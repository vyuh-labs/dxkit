/**
 * The cross-gate fail-open CONTRACT (the won't-recur net for the swallow class).
 *
 * Every additive guardrail gate (flow, schema-drift, seam/dup) is fail-OPEN: a
 * ref that can't be checked out, an unparseable tree, a plugin throw — none may
 * wedge the build. The class of bug this pins: a gate that catches its error in
 * a bare `catch {}` and returns `skipped: 'error'` with NO reason, so a real
 * throw becomes a diagnosability black hole. It shipped once (the flow gate
 * erroring silently inside `guardrail check` on a real repo) and was invisible
 * in dogfood because dxkit's own repo runs `flow` off, so the gate path was
 * never exercised.
 *
 * This drives EACH gate into its catch (a base ref that resolves to nothing
 * checkoutable → the base-worktree step throws) and asserts the outcome carries
 * `skipped: 'error'` AND a populated `error` (step + message). A future gate that
 * reintroduces a silent catch — or a new gate that omits the failure capture —
 * fails here. The type system is the first line (the `skip(mode, 'error')`
 * overload requires the failure arg); this is the runtime backstop and the proof
 * the renderers surface it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { evaluateFlowGateForGuardrail } from '../../src/baseline/flow-gate-check';
import { evaluateSchemaDriftGateForGuardrail } from '../../src/baseline/schema-drift-gate-check';
import { evaluateDupGateForGuardrail } from '../../src/baseline/dup-gate-check';
import { captureGateFailure } from '../../src/baseline/gate-failopen';
import { RefBaselineError } from '../../src/baseline/ref-baseline';
import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck, type GuardrailCheckResult } from '../../src/baseline/check';
import { renderConsole, renderJson, renderMarkdown } from '../../src/baseline/check-renderers';

/** A ref that resolves to no checkoutable commit — forces the base-worktree
 *  step of every gate to throw. */
const UNREACHABLE_REF = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/** A monorepo with flow (call+route), a model, and a structural duplicate — so
 *  every gate reaches its base-worktree step rather than an earlier content
 *  skip. Committed on `main`. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-failopen-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, 'web'), { recursive: true });
  mkdirSync(join(dir, 'api'), { recursive: true });
  mkdirSync(join(dir, 'models'), { recursive: true });
  mkdirSync(join(dir, '.dxkit'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  // Enable all three opt-in gates so each reaches its evaluation path (schema +
  // duplication default off; a mode override does not switch on an unconfigured
  // capability, so the policy must turn them on).
  writeFileSync(
    join(dir, '.dxkit', 'policy.json'),
    JSON.stringify({
      flow: { mode: 'warn' },
      schema: { mode: 'warn' },
      duplication: { mode: 'warn' },
    }),
  );
  // Flow surface: a client call + a served route.
  writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\n");
  writeFileSync(join(dir, 'api', 'ctrl.ts'), "class C { @get('/articles') a() {} }\n");
  // A declared model (schema surface).
  writeFileSync(
    join(dir, 'models', 'article.ts'),
    '@model()\nexport class Article { @property() title: string; }\n',
  );
  // A structural duplicate: two functions with the same 3-callee set → the seam
  // detector flags them, so the dup gate reaches its base-worktree step.
  writeFileSync(join(dir, 'a.ts'), 'function alpha() { helperX(); helperY(); helperZ(); }\n');
  writeFileSync(join(dir, 'b.ts'), 'function beta() { helperX(); helperY(); helperZ(); }\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

describe('gate fail-open contract — no silent swallow', () => {
  it('captureGateFailure extracts a clean message and preserves the step', () => {
    expect(captureGateFailure('base-worktree', new Error('boom'))).toEqual({
      step: 'base-worktree',
      message: 'boom',
    });
    // RefBaselineError folds its actionable hint into the message.
    const ref = new RefBaselineError('cannot reach ref', 'run git fetch');
    expect(captureGateFailure('head-gather', ref)).toEqual({
      step: 'head-gather',
      message: 'cannot reach ref (run git fetch)',
    });
    // A non-Error throw still yields a non-empty message.
    expect(captureGateFailure('evaluate', 'raw string throw').message).toBe('raw string throw');
  });

  it('flow gate: an unreachable base ref errors WITH a reason, never silently', async () => {
    const dir = makeRepo();
    const out = await evaluateFlowGateForGuardrail({
      cwd: dir,
      baseRef: UNREACHABLE_REF,
      modeOverride: 'warn',
    });
    expect(out.ran).toBe(false);
    expect(out.skipped).toBe('error');
    expect(out.error).toBeDefined();
    expect(out.error!.step.length).toBeGreaterThan(0);
    expect(out.error!.message.length).toBeGreaterThan(0);
    // Fail-open: an errored gate never blocks or warns the build.
    expect(out.blocks).toBe(false);
    expect(out.warns).toBe(false);
  });

  it('schema-drift gate: an unreachable base ref errors WITH a reason', async () => {
    const dir = makeRepo();
    const out = await evaluateSchemaDriftGateForGuardrail({
      cwd: dir,
      baseRef: UNREACHABLE_REF,
      modeOverride: 'warn',
    });
    expect(out.ran).toBe(false);
    expect(out.skipped).toBe('error');
    expect(out.error).toBeDefined();
    expect(out.error!.step.length).toBeGreaterThan(0);
    expect(out.error!.message.length).toBeGreaterThan(0);
    expect(out.blocks).toBe(false);
  });

  it('dup gate: an unreachable base ref errors WITH a reason', async () => {
    const dir = makeRepo();
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: UNREACHABLE_REF,
      modeOverride: 'warn',
    });
    expect(out.ran).toBe(false);
    // The dup gate only reaches the base-worktree step when HEAD has a
    // candidate duplicate; the fixture guarantees one.
    expect(out.skipped).toBe('error');
    expect(out.error).toBeDefined();
    expect(out.error!.step.length).toBeGreaterThan(0);
    expect(out.error!.message.length).toBeGreaterThan(0);
    expect(out.blocks).toBe(false);
  });
});

describe('renderers surface a fail-open gate error (never silent)', () => {
  let base: GuardrailCheckResult;
  let dir: string;

  beforeAll(async () => {
    dir = makeRepo();
    await createBaseline({ cwd: dir });
    base = await runGuardrailCheck({ cwd: dir });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const errored: GuardrailCheckResult['flowGate'] = {
    ran: false,
    skipped: 'error',
    error: { step: 'base-worktree', message: 'could not check out base ref' },
    mode: 'warn',
    findings: [],
    suppressed: [],
    blocks: false,
    warns: false,
  };

  it('console prints a visible line with the step and message', () => {
    const out = renderConsole({ ...base, flowGate: errored });
    expect(out).toContain('did not run');
    expect(out).toContain('base-worktree');
    expect(out).toContain('could not check out base ref');
  });

  it('json carries the structured error (not a bare skipped:"error")', () => {
    const json = renderJson({ ...base, flowGate: errored });
    expect(json.flowGate?.skipped).toBe('error');
    expect(json.flowGate?.error).toEqual({
      step: 'base-worktree',
      message: 'could not check out base ref',
    });
  });

  it('markdown prints a visible callout with the reason', () => {
    const md = renderMarkdown({ ...base, flowGate: errored });
    expect(md).toContain('did not run');
    expect(md).toContain('could not check out base ref');
  });
});
