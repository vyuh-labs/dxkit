#!/usr/bin/env node
/**
 * Graph-producer benchmark harness (graph consolidation arc).
 *
 * Compares graph.json producers on a locally-configured repo matrix:
 *   - lane "pinned":  dxkit's shipped graphify driver (`explore refresh`) —
 *                     what users get today; the migration-safety bar.
 *   - lane "latest":  the newest graphify release via its OWN CLI from a
 *                     dedicated bench venv — the competitive bar.
 *   - lane "native":  dxkit's native tree-sitter emitter (graph.producer=
 *                     native), once it exists.
 *
 * The repo list lives OUTSIDE the repo (tmp/ is gitignored) so customer
 * names never enter committed code. See tmp/graph-bench/bench-config.json:
 *   {
 *     "dxkitRoot": "/abs/path/to/dxkit-repo",
 *     "latestVenv": "~/.cache/dxkit/bench/graphify-<ver>-venv",
 *     "timeoutMinutes": 30,
 *     "repos": [{ "name": "...", "path": "/abs/path", "stack": "ts" }]
 *   }
 *
 * Usage:
 *   node scripts/graph-bench/bench.mjs run   [--repo <name>] [--lanes a,b]
 *   node scripts/graph-bench/bench.mjs stats [--repo <name>]
 *   node scripts/graph-bench/bench.mjs report
 *
 * Artifacts land in tmp/graph-bench/results/<repo>/<lane>/
 * (graph.json copy, meta.json with timing/exit/hash, stats.json).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

// D4d lesson: a big repo's graph blows the 1MiB default maxBuffer and the
// failure reads as something else entirely. Be generous everywhere.
const MAX_BUFFER = 1 << 28; // 256 MiB

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CONFIG_PATH = path.join(ROOT, 'tmp', 'graph-bench', 'bench-config.json');
const RESULTS_ROOT = path.join(ROOT, 'tmp', 'graph-bench', 'results');

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`No config at ${CONFIG_PATH} — create it first (see header comment).`);
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.dxkitRoot = expandHome(cfg.dxkitRoot ?? ROOT);
  cfg.latestVenv = expandHome(cfg.latestVenv ?? '');
  cfg.timeoutMinutes = cfg.timeoutMinutes ?? 30;
  for (const r of cfg.repos) r.path = expandHome(r.path);
  return cfg;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Lane definitions: how to produce a graph.json and where it lands. */
function lanes(cfg) {
  return {
    pinned: {
      cmd: (repo) => ({
        bin: 'node',
        args: [path.join(cfg.dxkitRoot, 'dist', 'index.js'), 'explore', 'refresh'],
        cwd: repo.path,
      }),
      artifact: (repo) => path.join(repo.path, '.dxkit', 'reports', 'graph.json'),
    },
    latest: {
      cmd: (repo) => ({
        bin: path.join(cfg.latestVenv, 'bin', 'graphify'),
        // `update` = LLM-free re-extract + cluster; their canonical
        // non-interactive path. Config may override args per the installed
        // version's CLI (latestArgs).
        args: [...(cfg.latestArgs ?? ['update']), repo.path],
        cwd: repo.path,
      }),
      artifact: (repo) => path.join(repo.path, 'graphify-out', 'graph.json'),
    },
    native: {
      cmd: (repo) => ({
        bin: 'node',
        args: [path.join(cfg.dxkitRoot, 'dist', 'index.js'), 'explore', 'refresh'],
        cwd: repo.path,
        // Placeholder wiring until the emitter + policy flag exist.
        env: { DXKIT_GRAPH_PRODUCER: 'native' },
      }),
      artifact: (repo) => path.join(repo.path, '.dxkit', 'reports', 'graph.json'),
    },
  };
}

async function runLane(cfg, repo, laneName) {
  const lane = lanes(cfg)[laneName];
  const outDir = path.join(RESULTS_ROOT, repo.name, laneName);
  fs.mkdirSync(outDir, { recursive: true });
  const { bin, args, cwd, env } = lane.cmd(repo);
  const started = Date.now();
  const meta = { repo: repo.name, lane: laneName, bin, args, startedAt: new Date().toISOString() };
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout: cfg.timeoutMinutes * 60_000,
      env: { ...process.env, ...(env ?? {}) },
    });
    meta.exitCode = 0;
    meta.stdoutTail = stdout.slice(-2000);
    meta.stderrTail = stderr.slice(-2000);
  } catch (err) {
    meta.exitCode = err.code ?? 1;
    meta.error = String(err.message ?? err).slice(0, 2000);
    meta.stdoutTail = (err.stdout ?? '').slice(-2000);
    meta.stderrTail = (err.stderr ?? '').slice(-2000);
    meta.timedOut = err.killed === true;
  }
  meta.wallMs = Date.now() - started;
  const artifact = lane.artifact(repo);
  if (fs.existsSync(artifact)) {
    const dest = path.join(outDir, 'graph.json');
    fs.copyFileSync(artifact, dest);
    meta.artifact = { bytes: fs.statSync(dest).size, sha256: sha256(dest) };
  } else {
    meta.artifact = null; // producer ran but emitted nothing — a finding, not a crash
  }
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  const status =
    meta.exitCode === 0 && meta.artifact
      ? 'ok'
      : meta.timedOut
        ? 'TIMEOUT'
        : meta.artifact
          ? `exit ${meta.exitCode} (artifact present)`
          : `FAILED exit ${meta.exitCode}, no artifact`;
  console.log(
    `  ${repo.name} / ${laneName}: ${status} in ${(meta.wallMs / 1000).toFixed(1)}s` +
      (meta.artifact ? ` (${(meta.artifact.bytes / 1024).toFixed(0)} KiB)` : ''),
  );
  return meta;
}

/**
 * Structural stats over a graph.json, tolerant of both wire dialects
 * (dxkit/graphify-0.8 uses "links"; some graphify outputs use "edges";
 * node kind/type field names vary).
 */
function graphStats(file) {
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = g.nodes ?? [];
  const edges = g.links ?? g.edges ?? [];
  const count = (arr, keyFns) => {
    const out = {};
    for (const item of arr) {
      let v;
      for (const k of keyFns) {
        v = item[k];
        if (v !== undefined && v !== null) break;
      }
      const key = String(v ?? 'unknown');
      out[key] = (out[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
  };
  const files = new Set();
  const exts = {};
  for (const n of nodes) {
    const f = n.source_file ?? n.sourceFile ?? n.file;
    if (f) {
      files.add(f);
      const ext = path.extname(f) || '(none)';
      exts[ext] = (exts[ext] ?? 0) + 1;
    }
  }
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodesByKind: count(nodes, ['kind', 'label', 'type']),
    edgesByType: count(edges, ['type', 'relation', 'label']),
    filesCovered: files.size,
    nodesByExtension: Object.fromEntries(Object.entries(exts).sort((a, b) => b[1] - a[1])),
  };
}

function cmdStats(cfg, repoFilter) {
  for (const repo of cfg.repos) {
    if (repoFilter && repo.name !== repoFilter) continue;
    for (const laneName of Object.keys(lanes(cfg))) {
      const dir = path.join(RESULTS_ROOT, repo.name, laneName);
      const file = path.join(dir, 'graph.json');
      if (!fs.existsSync(file)) continue;
      const stats = graphStats(file);
      fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(stats, null, 2));
      console.log(
        `${repo.name} / ${laneName}: ${stats.nodeCount} nodes, ${stats.edgeCount} edges, ${stats.filesCovered} files`,
      );
    }
  }
}

function cmdReport(cfg) {
  const rows = [];
  for (const repo of cfg.repos) {
    const row = { repo: repo.name, stack: repo.stack ?? '?' };
    for (const laneName of Object.keys(lanes(cfg))) {
      const dir = path.join(RESULTS_ROOT, repo.name, laneName);
      const statsFile = path.join(dir, 'stats.json');
      const metaFile = path.join(dir, 'meta.json');
      if (fs.existsSync(statsFile)) {
        const s = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        const m = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
        row[laneName] =
          `${s.nodeCount}n/${s.edgeCount}e/${s.filesCovered}f ${(m.wallMs / 1000).toFixed(0)}s`;
      } else if (fs.existsSync(metaFile)) {
        const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        row[laneName] = m.timedOut ? 'TIMEOUT' : `FAIL(${m.exitCode})`;
      } else {
        row[laneName] = '—';
      }
    }
    rows.push(row);
  }
  const cols = ['repo', 'stack', ...Object.keys(lanes(cfg))];
  const lines = [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${cols.map((c) => r[c] ?? '—').join(' | ')} |`),
  ];
  const out = lines.join('\n');
  fs.writeFileSync(path.join(RESULTS_ROOT, 'REPORT.md'), out + '\n');
  console.log(out);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const cfg = loadConfig();
  const repoFilter = flag('repo');
  if (cmd === 'run') {
    const laneNames = (flag('lanes') ?? 'pinned,latest').split(',');
    for (const repo of cfg.repos) {
      if (repoFilter && repo.name !== repoFilter) continue;
      console.log(`${repo.name} (${repo.stack ?? '?'}) — ${repo.path}`);
      for (const laneName of laneNames) {
        if (!lanes(cfg)[laneName]) {
          console.error(`unknown lane: ${laneName}`);
          process.exit(2);
        }
        await runLane(cfg, repo, laneName);
      }
    }
  } else if (cmd === 'stats') {
    cmdStats(cfg, repoFilter);
  } else if (cmd === 'report') {
    cmdReport(cfg);
  } else {
    console.error('usage: bench.mjs <run|stats|report> [--repo name] [--lanes a,b]');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
