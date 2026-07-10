/**
 * Flow-contract freshness (src/analyzers/flow/staleness.ts) + the bounded
 * remote-tip probe (remote-ref.ts:remoteTipSha). The committed served.json is
 * a deliberate lag; these pin the DISCLOSURE machinery: publish records each
 * participant's gathered commit, and doctor compares it against the
 * participant's current tip — local checkouts offline, `repo:` participants
 * via one fail-open ls-remote.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { publishFlow } from '../src/analyzers/flow/publish';
import { readServedContract } from '../src/analyzers/flow/contract';
import { contractFreshness } from '../src/analyzers/flow/staleness';
import { remoteTipSha } from '../src/baseline/remote-ref';

const NOW = '2026-07-02T00:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** A git-backed sibling backend serving one route; returns a `commit` helper
 *  to advance its tip (the staleness trigger). */
function makeGitBackend(root: string): { dir: string; commit: (route: string) => void } {
  const dir = join(root, 'backend');
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'be', version: '0.0.0' }));
  mkdirSync(join(dir, 'api'), { recursive: true });
  const commit = (route: string): void => {
    writeFileSync(join(dir, 'api', 'ctrl.ts'), `class C { @get('${route}') h() {} }\n`);
    git('add', '.');
    git('commit', '-q', '-m', `serve ${route}`);
  };
  commit('/articles');
  return { dir, commit };
}

describe('publish provenance → contractFreshness', () => {
  let root: string;
  let appDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dxkit-flowstale-'));
    appDir = join(root, 'app');
    write(root, 'app/package.json', JSON.stringify({ name: 'app', version: '0.0.0' }));
    write(root, 'app/web/List.tsx', "axios.get('/articles');\n");
    write(
      root,
      'app/.dxkit/workspace.json',
      JSON.stringify({ participants: [{ name: 'backend', path: '../backend' }], external: [] }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('records each participant’s gathered commit on the committed contract', async () => {
    makeGitBackend(root);
    await publishFlow(appDir, { generatedAt: NOW });
    const served = readServedContract(appDir);
    expect(served?.participants).toHaveLength(1);
    expect(served?.participants?.[0]).toMatchObject({
      name: 'backend',
      source: 'local',
      routes: 1,
    });
    expect(served?.participants?.[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('freshness: current right after publish, BEHIND once the provider tip moves', async () => {
    const backend = makeGitBackend(root);
    await publishFlow(appDir, { generatedAt: NOW });

    const fresh = contractFreshness(appDir);
    expect(fresh).not.toBeNull();
    expect(fresh?.stale).toBe(false);
    expect(fresh?.participants[0]).toMatchObject({ name: 'backend', moved: false });

    // The provider ships a new commit — the committed snapshot is now behind.
    backend.commit('/articles-v2');
    const stale = contractFreshness(appDir);
    expect(stale?.stale).toBe(true);
    expect(stale?.participants[0].moved).toBe(true);
    expect(stale?.participants[0].tip).toMatch(/^[0-9a-f]{40}$/);
    expect(stale?.participants[0].tip).not.toBe(stale?.participants[0].sha);
  });

  it('is honest about the unknown: probe failure → moved null, never a false verdict', async () => {
    makeGitBackend(root);
    await publishFlow(appDir, { generatedAt: NOW });
    // Local checkout gone AND the injected remote probe fails (offline).
    rmSync(join(root, 'backend'), { recursive: true, force: true });
    const fresh = contractFreshness(appDir, () => null);
    expect(fresh?.participants[0].moved).toBeNull();
    expect(fresh?.stale).toBe(false); // unknown is not stale — no false alarms
  });

  it('routes a repo:-only participant through the injected remote probe with its ref', async () => {
    makeGitBackend(root);
    await publishFlow(appDir, { generatedAt: NOW });
    rmSync(join(root, 'backend'), { recursive: true, force: true });
    write(
      root,
      'app/.dxkit/workspace.json',
      JSON.stringify({
        participants: [{ name: 'backend', repo: 'https://example.com/be.git', ref: 'release-1' }],
        external: [],
      }),
    );
    const calls: Array<{ repo: string; ref?: string }> = [];
    contractFreshness(appDir, (opts) => {
      calls.push(opts);
      return null;
    });
    expect(calls).toEqual([{ repo: 'https://example.com/be.git', ref: 'release-1' }]);
  });

  it('returns null when the repo commits no contract (nothing to disclose)', () => {
    expect(contractFreshness(appDir)).toBeNull();
  });
});

describe('remoteTipSha', () => {
  it('resolves HEAD and a branch tip of a reachable remote, null when unreachable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-tip-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@e.com');
      git('config', 'user.name', 't');
      writeFileSync(join(dir, 'a.txt'), '1');
      git('add', '.');
      git('commit', '-q', '-m', 'one');
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      const url = `file://${dir}`;
      expect(remoteTipSha({ repo: url })).toBe(sha);
      expect(remoteTipSha({ repo: url, ref: 'main' })).toBe(sha);
      expect(remoteTipSha({ repo: url, ref: 'no-such-branch' })).toBeNull();
      expect(remoteTipSha({ repo: `file://${dir}-nope`, timeoutMs: 5_000 })).toBeNull();
      // Argument-injection guard: a leading-dash repo/ref fails closed to null.
      expect(remoteTipSha({ repo: '--upload-pack=/bin/true' })).toBeNull();
      expect(remoteTipSha({ repo: url, ref: '--exec=x' })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
