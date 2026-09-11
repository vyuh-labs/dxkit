/**
 * The land step's credential preflight RETRIES (#375), pinned by running
 * the template's own shell body under `bash -eo pipefail` (what Actions
 * runs a `run:` block with) against a scripted fake `git`:
 *
 *   - two transient failures then success: the step proceeds to
 *     `remediate land` (no --preflight-failed), every failure line kept,
 *     the backoff is 10s then 30s (a fake `sleep` records it);
 *   - three failures: no `remediate land` push attempt; the step hands the
 *     attempt count and the LAST error to `remediate land
 *     --preflight-failed`, which owns the one `landing-blocked:` phrasing
 *     (pinned in pending-ref.test.ts), and exits 1;
 *   - no landing record: the step exits 0 without probing at all.
 *
 * The body is EXTRACTED from the template, never copied: a drift between
 * the shipped step and what this test runs is impossible.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describePreflightFailure } from '../../src/remediate/attempt-record';
import { landingRecordPath } from '../../src/remediate/landing-record';

const TEMPLATE = path.join(
  __dirname,
  '..',
  '..',
  'src-templates',
  '.github',
  'workflows',
  'dxkit-remediate.yml',
);
const TASK = 'fix-build';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dxkit-preflight-${label}-`));
  dirs.push(dir);
  return dir;
}

/** The land step's `run: |` body, dedented, with the matrix task bound. */
function landStepScript(): string {
  const lines = fs.readFileSync(TEMPLATE, 'utf8').split('\n');
  const start = lines.findIndex((l) =>
    l.includes('- name: Land the deferred work (fresh credential)'),
  );
  expect(start).toBeGreaterThan(-1);
  const runIdx = lines.findIndex((l, i) => i > start && /^ {8}run: \|$/.test(l));
  expect(runIdx).toBeGreaterThan(start);
  const body: string[] = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') break;
    if (!l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  expect(body.length).toBeGreaterThan(10);
  return body.join('\n').split('${{ matrix.task }}').join(TASK) + '\n';
}

interface Harness {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly dxkitArgs: string;
  readonly sleepLog: string;
  readonly lsRemoteCount: string;
}

/** A fixture checkout with a landing record, a recording fake CLI, and a
 *  PATH whose `git` fails `failTimes` ls-remotes before succeeding and
 *  whose `sleep` only records. */
function harness(failTimes: number, withRecord = true): Harness {
  const cwd = tempDir('cwd');
  const bin = tempDir('bin');
  const state = tempDir('state');
  if (withRecord) {
    fs.mkdirSync(path.dirname(path.join(cwd, landingRecordPath(TASK))), { recursive: true });
    fs.writeFileSync(path.join(cwd, landingRecordPath(TASK)), '{}\n', 'utf8');
  }
  const dxkitArgs = path.join(state, 'dxkit-args');
  const sleepLog = path.join(state, 'sleep-log');
  const lsRemoteCount = path.join(state, 'ls-remote-count');
  const cliDir = path.join(cwd, 'node_modules', '.bin');
  fs.mkdirSync(cliDir, { recursive: true });
  const write = (file: string, content: string): void => {
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o755 });
  };
  write(
    path.join(cliDir, 'vyuh-dxkit'),
    '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$DXKIT_ARGS_FILE"\n',
  );
  write(
    path.join(bin, 'git'),
    [
      '#!/bin/bash',
      'case "$1" in',
      '  config)',
      '    if [ "$2" = "--get-all" ]; then echo "AUTHORIZATION: basic x"; fi',
      '    exit 0 ;;',
      '  ls-remote)',
      '    n=$(cat "$LS_REMOTE_COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$LS_REMOTE_COUNT"',
      '    if [ "$n" -le "$FAIL_TIMES" ]; then',
      '      echo "remote: Repository not found." >&2',
      '      echo "fatal: repository \'https://github.com/acme/repo/\' not found" >&2',
      '      exit 128',
      '    fi',
      '    exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  write(path.join(bin, 'sleep'), '#!/bin/bash\necho "sleep $1" >> "$SLEEP_LOG"\n');
  return {
    cwd,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      DXKIT_LANE_TOKEN: '<your-token>',
      DXKIT_ARGS_FILE: dxkitArgs,
      SLEEP_LOG: sleepLog,
      LS_REMOTE_COUNT: lsRemoteCount,
      FAIL_TIMES: String(failTimes),
    },
    dxkitArgs,
    sleepLog,
    lsRemoteCount,
  };
}

function run(h: Harness): { status: number; stdout: string } {
  const script = path.join(tempDir('script'), 'land.sh');
  fs.writeFileSync(script, landStepScript(), 'utf8');
  try {
    const stdout = execFileSync('bash', ['-eo', 'pipefail', script], {
      cwd: h.cwd,
      env: h.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '' };
  }
}

const readOr = (file: string, fallback = ''): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback;

describe.skipIf(process.platform === 'win32')('the land step credential preflight (#375)', () => {
  it('two transient failures then success: retries with 10s/30s backoff, keeps every failure line, then lands', () => {
    const h = harness(2);
    const { status, stdout } = run(h);
    expect(status).toBe(0);
    expect(stdout).toContain(
      'landing credential preflight attempt 1 failed: remote: Repository not found.',
    );
    expect(stdout).toContain(
      'landing credential preflight attempt 2 failed: remote: Repository not found.',
    );
    expect(stdout).toContain(
      'landing credential verified (single auth header, ls-remote OK, attempt 3)',
    );
    expect(readOr(h.sleepLog)).toBe('sleep 10\nsleep 30\n');
    expect(readOr(h.lsRemoteCount).trim()).toBe('3');
    expect(readOr(h.dxkitArgs).split('\n').filter(Boolean)).toEqual([
      'remediate',
      'land',
      '--task',
      TASK,
    ]);
  });

  it('three failures: no push attempt, the last error + attempt count go to the CLI for the ONE disclosure, exit 1', () => {
    const h = harness(3);
    const { status, stdout } = run(h);
    expect(status).toBe(1);
    expect(stdout).toContain(
      'landing credential preflight attempt 3 failed: remote: Repository not found.',
    );
    expect(stdout).not.toContain('landing credential verified');
    // Bounded: exactly three probes, backoff only BETWEEN attempts.
    expect(readOr(h.lsRemoteCount).trim()).toBe('3');
    expect(readOr(h.sleepLog)).toBe('sleep 10\nsleep 30\n');
    const args = readOr(h.dxkitArgs).split('\n').filter(Boolean);
    expect(args.slice(0, 4)).toEqual(['remediate', 'land', '--task', TASK]);
    expect(args[4]).toBe('--preflight-failed');
    // The full stderr of the LAST attempt rides the flag (the first line
    // is what the phrasing keeps), then the attempt count.
    expect(args[5]).toBe('remote: Repository not found.');
    expect(args[6]).toBe("fatal: repository 'https://github.com/acme/repo/' not found");
    expect(args.slice(7)).toEqual(['--preflight-attempts', '3']);
    // The named disclosure is the CLI's, derived from exactly those inputs:
    // the template phrases nothing in bash.
    expect(describePreflightFailure(3, args.slice(5, 7).join('\n'))).toBe(
      'landing-blocked: credential preflight failed after 3 attempts (remote: Repository not found.)',
    );
    expect(landStepScript()).not.toContain('landing-blocked');
  });

  it('no landing record: exit 0 with the disclosed skip, no probe, no CLI call', () => {
    const h = harness(0, false);
    const { status, stdout } = run(h);
    expect(status).toBe(0);
    expect(stdout).toContain(`no landing record for '${TASK}'`);
    expect(fs.existsSync(h.lsRemoteCount)).toBe(false);
    expect(fs.existsSync(h.dxkitArgs)).toBe(false);
  });
});
