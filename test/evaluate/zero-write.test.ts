import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto'; // fingerprint-helper-ok: tree snapshotting for the zero-write proof, not finding identity
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runEvaluate } from '../../src/evaluate/run';

/**
 * THE zero-write proof: `evaluate` runs the real guardrail over a real ref
 * pair and the target repository is byte-identical afterwards — no
 * `.dxkit/`, no caches, no refs, no config. This is the structural
 * guarantee the funnel copy states ("nothing was written to your repo"),
 * pinned as an invariant rather than trusted as a code-review property.
 *
 * The test runs the full gather pipeline in disposable worktrees; missing
 * scanners on the host degrade to coverage entries (fail-open), which is
 * itself part of what the evidence must record honestly.
 */

const tmps: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function mkRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-evalzw-'));
  tmps.push(d);
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t.co');
  git(d, 'config', 'user.name', 't');
  return d;
}
function commit(cwd: string, files: Record<string, string>, subject: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', subject);
  return git(cwd, 'rev-parse', 'HEAD');
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Every path under `dir` (files AND directories, including dotfiles) with
 *  a content hash for files — the complete on-disk state. */
function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        out.set(childRel + '/', 'dir');
        walk(childRel);
      } else if (entry.isFile()) {
        out.set(
          childRel,
          createHash('sha256')
            .update(fs.readFileSync(path.join(dir, childRel)))
            .digest('hex'),
        );
      }
    }
  };
  walk('');
  return out;
}

describe('evaluate zero-write invariant', () => {
  it(
    'leaves the target repo byte-identical and reports the replay honestly',
    { timeout: 300_000 },
    async () => {
      const d = mkRepo();
      const base = commit(
        d,
        {
          'package.json': '{"name":"zw-fixture","version":"1.0.0"}\n',
          'src/a.js': 'const a = 1;\nmodule.exports = a;\n',
        },
        'root',
      );
      const head = commit(
        d,
        { 'src/b.js': 'const b = 2;\nmodule.exports = b;\n' },
        'feat: add b (#5)',
      );

      const before = snapshotTree(d);
      const gitStateBefore =
        git(d, 'for-each-ref') + '\n' + git(d, 'status', '--porcelain=v1', '-uall');

      const doc = await runEvaluate({ cwd: d, base, head });

      const after = snapshotTree(d);
      const gitStateAfter =
        git(d, 'for-each-ref') + '\n' + git(d, 'status', '--porcelain=v1', '-uall');

      // The attestation the output makes, proven byte-for-byte.
      expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before));
      expect(gitStateAfter).toBe(gitStateBefore);
      expect(fs.existsSync(path.join(d, '.dxkit'))).toBe(false);

      // The evidence is honest about what happened.
      expect(doc.schema).toBe('dxkit.evaluate-evidence.v1');
      expect(doc.zeroWrite).toBe(true);
      expect(doc.totals.landings).toBe(1);
      expect(doc.totals.errored).toBe(0);
      const run = doc.runs[0];
      expect(run.baseSha).toBe(base);
      expect(run.headSha).toBe(head);
      expect(run.guardrail?.schema).toBe('dxkit.guardrail-check.v1');
      expect(run.coverage.scanners.length).toBeGreaterThan(0);
      expect(run.durationMs).toBeGreaterThan(0);
    },
  );

  it(
    'last-landings mode replays history and survives an unresolvable landing',
    { timeout: 300_000 },
    async () => {
      const d = mkRepo();
      commit(d, { 'package.json': '{"name":"zw-fixture2","version":"1.0.0"}\n' }, 'root');
      commit(d, { 'src/a.js': 'const a = 1;\nmodule.exports = a;\n' }, 'feat: a (#1)');
      commit(d, { 'src/a.js': 'const a = 2;\nmodule.exports = a;\n' }, 'feat: bump a (#2)');

      const before = snapshotTree(d);
      const doc = await runEvaluate({ cwd: d, lastLandings: 5 });
      expect(Object.fromEntries(snapshotTree(d))).toEqual(Object.fromEntries(before));

      // Root has no base side → 2 replayable landings.
      expect(doc.totals.landings).toBe(2);
      expect(doc.runs.map((r) => r.label)).toEqual(['#2', '#1']);
      expect(doc.costs.interruptions.landings).toBe(doc.totals.landings - doc.totals.errored);
    },
  );
});
