import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveCorrectnessSurface,
  detectTestCi,
  readSurfacePolicy,
  type CorrectnessSurface,
  type TestCiDetection,
} from '../src/analyzers/correctness/surface';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-surface-'));
  // Ensure a clean env for each test (the resolver reads DXKIT_FLOOR_*).
  delete process.env.DXKIT_FLOOR_LOOP;
  delete process.env.DXKIT_FLOOR_PREPUSH;
  delete process.env.DXKIT_FLOOR_CI;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.DXKIT_FLOOR_LOOP;
  delete process.env.DXKIT_FLOOR_PREPUSH;
  delete process.env.DXKIT_FLOOR_CI;
});

function writeWorkflow(name: string, body: string): void {
  const dir = path.join(tmp, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

const detect = (status: TestCiDetection['status'], evidence?: string) => () => ({
  status,
  evidence,
});

describe('detectTestCi', () => {
  it('no CI config at all → no-test-ci', () => {
    expect(detectTestCi(tmp).status).toBe('no-test-ci');
  });

  it('a workflow that runs npm test → has-test-ci with evidence', () => {
    writeWorkflow('ci.yml', 'jobs:\n  test:\n    steps:\n      - run: npm test\n');
    const d = detectTestCi(tmp);
    expect(d.status).toBe('has-test-ci');
    expect(d.evidence).toContain('ci.yml');
  });

  it('detects pytest / go test / cargo test / dotnet test / gradle', () => {
    for (const cmd of [
      'pytest -q',
      'go test ./...',
      'cargo test',
      'dotnet test',
      './gradlew test',
    ]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ci-'));
      try {
        fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), `- run: ${cmd}\n`);
        expect(detectTestCi(dir).status, cmd).toBe('has-test-ci');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('a workflow with no recognizable test command → uncertain (CI exists, opaque)', () => {
    writeWorkflow('ci.yml', 'jobs:\n  build:\n    steps:\n      - run: make ci\n');
    expect(detectTestCi(tmp).status).toBe('uncertain');
  });

  it('ignores dxkit-authored workflows (its own floor/guardrail is not the repo test-CI)', () => {
    writeWorkflow('dxkit-guardrails.yml', '- run: npm test\n');
    // Only dxkit's own workflow present → not counted → no-test-ci.
    expect(detectTestCi(tmp).status).toBe('no-test-ci');
  });

  it('reads flat CI configs (.gitlab-ci.yml)', () => {
    fs.writeFileSync(path.join(tmp, '.gitlab-ci.yml'), 'test:\n  script:\n    - pytest\n');
    const d = detectTestCi(tmp);
    expect(d.status).toBe('has-test-ci');
    expect(d.evidence).toContain('.gitlab-ci.yml');
  });
});

describe('readSurfacePolicy', () => {
  it('returns {} when no policy file', () => {
    expect(readSurfacePolicy(tmp)).toEqual({});
  });

  it('reads boolean surface toggles, ignoring non-booleans', () => {
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.dxkit', 'policy.json'),
      JSON.stringify({
        correctness: { surfaces: { ci: false, 'pre-push': true, 'loop-stop': 'yes' } },
      }),
    );
    expect(readSurfacePolicy(tmp)).toEqual({ ci: false, 'pre-push': true });
  });

  it('tolerates malformed JSON', () => {
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.dxkit', 'policy.json'), '{ not json');
    expect(readSurfacePolicy(tmp)).toEqual({});
  });
});

describe('resolveCorrectnessSurface — precedence', () => {
  const base = (over: Partial<Parameters<typeof resolveCorrectnessSurface>[0]> = {}) => ({
    surface: 'ci' as CorrectnessSurface,
    cwd: tmp,
    policySurfaces: {},
    detect: detect('no-test-ci'),
    ...over,
  });

  it('1. explicit flag wins over everything', () => {
    process.env.DXKIT_FLOOR_CI = '1';
    const r = resolveCorrectnessSurface(
      base({ flag: false, policySurfaces: { ci: true }, detect: detect('no-test-ci') }),
    );
    expect(r.enabled).toBe(false);
    expect(r.source).toBe('flag');
  });

  it('2. env override wins over policy + adaptive', () => {
    process.env.DXKIT_FLOOR_CI = 'off';
    const r = resolveCorrectnessSurface(base({ policySurfaces: { ci: true } }));
    expect(r.enabled).toBe(false);
    expect(r.source).toBe('env');
  });

  it('3. policy wins over adaptive default', () => {
    const r = resolveCorrectnessSurface(
      base({ policySurfaces: { ci: false }, detect: detect('no-test-ci') }),
    );
    expect(r.enabled).toBe(false);
    expect(r.source).toBe('policy');
  });

  it('loop-stop is always-on by default (no flag/env/policy)', () => {
    const r = resolveCorrectnessSurface(base({ surface: 'loop-stop' }));
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('always-on');
  });

  it('loop-stop can still be disabled by an explicit flag', () => {
    const r = resolveCorrectnessSurface(base({ surface: 'loop-stop', flag: false }));
    expect(r.enabled).toBe(false);
    expect(r.source).toBe('flag');
  });
});

describe('resolveCorrectnessSurface — adaptive (pre-push / ci)', () => {
  const adaptive = (status: TestCiDetection['status'], surface: CorrectnessSurface = 'ci') =>
    resolveCorrectnessSurface({
      surface,
      cwd: tmp,
      policySurfaces: {},
      detect: detect(status, 'ci.yml: npm test'),
    });

  it('has-test-ci → OPT-IN (disabled by default)', () => {
    const r = adaptive('has-test-ci');
    expect(r.enabled).toBe(false);
    expect(r.source).toBe('adaptive-test-ci-detected');
  });

  it('no-test-ci → default ON', () => {
    const r = adaptive('no-test-ci');
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('adaptive-no-test-ci');
  });

  it('uncertain → FAIL TOWARD ON', () => {
    const r = adaptive('uncertain');
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('adaptive-uncertain');
  });

  it('applies the same adaptive logic to pre-push', () => {
    expect(adaptive('has-test-ci', 'pre-push').enabled).toBe(false);
    expect(adaptive('no-test-ci', 'pre-push').enabled).toBe(true);
    expect(adaptive('uncertain', 'pre-push').enabled).toBe(true);
  });
});
