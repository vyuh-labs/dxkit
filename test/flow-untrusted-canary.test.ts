/**
 * N-TRUST-01 side-effect canary (4.1.3). The `--untrusted` trust tier promises
 * that executable flow plugins NEVER load when the scanned source is
 * attacker-controlled — the shipped PR workflow runs `flow console --untrusted`
 * against PR-head code, so a dropped flag means PR-head JavaScript executes on
 * the CI runner. The audit found the boolean forwarded at some call sites and
 * silently dropped at others (console → gate, map → seam inventory, evaluate →
 * seam visibility).
 *
 * The canary: a fixture plugin whose module body writes a sentinel file OUTSIDE
 * the repo at load time. Each user-facing `--untrusted` entry point runs twice —
 * untrusted first (the sentinel must NOT appear), then trusted (the sentinel
 * MUST appear, proving the canary actually covers that entry's plugin-load path
 * and the untrusted assertion is not vacuous).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SDK_MAJOR } from '@vyuhlabs/dxkit-sdk';
import { runFlowConsole, runFlowExtract, runFlowMap } from '../src/flow-cli';
import { gatherSeamInventory } from '../src/analyzers/convergence/inventory';
import { runEvaluate } from '../src/evaluate/run';

let repo: string;
let sentinelDir: string;
let sentinel: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-canary-repo-'));
  sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-canary-out-'));
  sentinel = path.join(sentinelDir, 'PLUGIN_FIRED');
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(sentinelDir, { recursive: true, force: true });
});

function write(rel: string, content: unknown): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
}

/** The canary plugin: side-effect at LOAD (module body), then a valid dialect
 *  definition. The sentinel path is absolute + out-of-tree so a load from a
 *  detached git worktree (the gate's base side, evaluate's head) still lands
 *  where the test can see it. */
function writeCanaryPlugin(): void {
  write('.dxkit/extensions/canary/extension.json', {
    schemaVersion: 1,
    name: 'canary',
    plugin: { module: 'plugin.js' },
  });
  write(
    '.dxkit/extensions/canary/plugin.js',
    `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'fired');\n` +
      `module.exports = {\n` +
      `  name: 'canary',\n` +
      `  sdkMajor: ${SDK_MAJOR},\n` +
      `  httpFlowDialect: {\n` +
      `    pack: 'typescript',\n` +
      `    clientMethodCallees: { methods: ['fetchJson'] },\n` +
      `    methodAliases: { fetchjson: 'GET' },\n` +
      `  },\n` +
      `};\n`,
  );
}

/** The stack markers that make the repo DETECT as TypeScript — diagnoseFlow
 *  (the seam-inventory chain) bails before any plugin load when no
 *  flow-capable pack is active, which would make the positive controls
 *  vacuous. */
function writeStackMarkers(): void {
  write('package.json', { name: 'canary-fixture', version: '1.0.0' });
  write('tsconfig.json', { compilerOptions: { strict: true } });
}

function fired(): boolean {
  return fs.existsSync(sentinel);
}
function resetSentinel(): void {
  fs.rmSync(sentinel, { force: true });
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

/** A minimal TS repo with the canary plugin COMMITTED (so worktrees at a ref
 *  carry it) and one flow-surface change on top for diff-scoped surfaces. */
function setupGitRepo(): void {
  writeStackMarkers();
  write('src/app.ts', `export async function load() { return api.fetchJson('/articles/1'); }\n`);
  writeCanaryPlugin();
  git('init', '-q');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'base');
  write('src/app.ts', `export async function load() { return api.fetchJson('/articles/2'); }\n`);
  git('add', '-A');
  git('commit', '-qm', 'head');
}

describe('the plugin canary never fires through an --untrusted entry', () => {
  it('flow map (model gather + seam inventory)', async () => {
    write('src/app.ts', `export async function load() { return api.fetchJson('/a'); }\n`);
    writeCanaryPlugin();

    await runFlowMap({ cwd: repo, json: true, untrusted: true });
    expect(fired()).toBe(false);

    // Positive control: the same entry, trusted, DOES load the plugin — the
    // untrusted assertion above is not vacuous.
    await runFlowMap({ cwd: repo, json: true, untrusted: false });
    expect(fired()).toBe(true);
  }, 120_000);

  it('flow extract', async () => {
    write('src/app.ts', `export async function load() { return api.fetchJson('/a'); }\n`);
    writeCanaryPlugin();

    await runFlowExtract({ cwd: repo, json: true, untrusted: true });
    expect(fired()).toBe(false);

    await runFlowExtract({ cwd: repo, json: true, untrusted: false });
    expect(fired()).toBe(true);
  }, 120_000);

  it('flow console --diff (the gate path — the shipped PR workflow entry)', async () => {
    setupGitRepo();

    await runFlowConsole({ cwd: repo, json: true, diff: 'HEAD~1', untrusted: true });
    expect(fired()).toBe(false);

    await runFlowConsole({ cwd: repo, json: true, diff: 'HEAD~1', untrusted: false });
    expect(fired()).toBe(true);
  }, 120_000);

  it('gatherSeamInventory (the one seam orchestration both flow map and evaluate share)', async () => {
    writeStackMarkers();
    write('src/app.ts', `export async function load() { return api.fetchJson('/a'); }\n`);
    writeCanaryPlugin();

    await gatherSeamInventory(repo, { untrusted: true });
    expect(fired()).toBe(false);

    await gatherSeamInventory(repo);
    expect(fired()).toBe(true);
  }, 120_000);

  it('evaluate (the trial seam-visibility lane)', async () => {
    setupGitRepo();

    await runEvaluate({ cwd: repo, base: 'HEAD~1', head: 'HEAD', untrusted: true });
    expect(fired()).toBe(false);

    resetSentinel();
    await runEvaluate({ cwd: repo, base: 'HEAD~1', head: 'HEAD', untrusted: false });
    expect(fired()).toBe(true);
  }, 300_000);
});
