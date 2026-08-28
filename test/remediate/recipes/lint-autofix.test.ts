/**
 * The lint-autofix recipe: applied (the pack's fix mode runs file-scoped and
 * the same run's parsed leftovers are empty), failed (unfixable rules remain,
 * with the rules named), and the declared refusals (user check, sliced
 * order, pack without a fix mode). Also pins the ts pack's `fixCommand`
 * shape: file-scoped `eslint --fix`, json output, same parser as the gate.
 */
import { describe, it, expect } from 'vitest';
import { executeLintAutofix } from '../../../src/remediate/recipes/lint-autofix';
import { getLanguage } from '../../../src/languages';
import { fakeExec, lintFinding, makeCtx, makeOrder, tempRepo } from './helpers';

function lintOrder(check: string, file: string, overrides: Record<string, unknown> = {}) {
  return makeOrder({
    id: `lint-located:${file}`,
    class: 'lint-located',
    findings: [lintFinding('l1', check, file, 'prefer-const')],
    envelope: { paths: [file], manifests: false },
    provenance: { source: 'debt-slice', file, slice: 1, of: 1 },
    ...overrides,
  });
}

/** A repo where the ts pack's eslint resolves (a local .bin shim exists). */
function eslintRepo(): string {
  return tempRepo({
    'package.json': '{"name":"fx"}',
    'node_modules/.bin/eslint': '#!/bin/sh\n',
    'src/a.ts': 'let x = 1;\nexport default x;\n',
  });
}

const eslintJson = (cwd: string, messages: Array<{ ruleId: string; message: string }>) =>
  JSON.stringify([{ filePath: `${cwd}/src/a.ts`, messages }]);

describe('the ts pack fixCommand', () => {
  it('is file-scoped eslint --fix with the same json parse as the gate', () => {
    const cwd = eslintRepo();
    const fix = getLanguage('typescript')!.lintGate!.fixCommand!({ cwd, files: ['src/a.ts'] });
    expect(fix).not.toBeNull();
    expect(fix!.args).toContain('--fix');
    expect(fix!.args).toContain('src/a.ts');
    expect(fix!.args).not.toContain('.');
    expect(fix!.parse.kind).toBe('structured');
  });

  it('returns null with no files or no resolvable eslint', () => {
    const cwd = eslintRepo();
    const gate = getLanguage('typescript')!.lintGate!;
    expect(gate.fixCommand!({ cwd, files: [] })).toBeNull();
    const bare = tempRepo({ 'package.json': '{}' });
    expect(gate.fixCommand!({ cwd: bare, files: ['src/a.ts'] })).toBeNull();
  });
});

describe('lint-autofix recipe', () => {
  it('applies when the fix run leaves zero findings in the file', async () => {
    const cwd = eslintRepo();
    const { exec, calls } = fakeExec(() => ({ code: 0, output: eslintJson(cwd, []) }));
    const outcome = await executeLintAutofix(
      lintOrder('lint:typescript', 'src/a.ts'),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') expect(outcome.changedFiles).toEqual(['src/a.ts']);
    expect(calls[0].cmd.args).toContain('--fix');
  });

  it('fails with the leftover rules named when the fix cannot close every finding', async () => {
    const cwd = eslintRepo();
    const { exec } = fakeExec(() => ({
      code: 1,
      output: eslintJson(cwd, [{ ruleId: 'no-unused-vars', message: 'x is unused' }]),
    }));
    const outcome = await executeLintAutofix(
      lintOrder('lint:typescript', 'src/a.ts'),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.step).toBe('verify-lint');
      expect(outcome.output).toContain('no-unused-vars');
    }
  });

  it('refuses a user-declared check (no pack fixer exists for it)', async () => {
    const cwd = eslintRepo();
    const { exec, calls } = fakeExec();
    const outcome = await executeLintAutofix(
      lintOrder('arch-rules', 'src/a.ts'),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('a sliced order executes like any other (the runner groups a file into one fix attempt)', async () => {
    const cwd = eslintRepo();
    const { exec } = fakeExec(() => ({ code: 0, output: eslintJson(cwd, []) }));
    const outcome = await executeLintAutofix(
      lintOrder('lint:typescript', 'src/a.ts', {
        provenance: { source: 'debt-slice', file: 'src/a.ts', slice: 1, of: 3 },
      }),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('applied');
  });

  it('KNOWN leftover rules come back structurally (the grouped runner splits per slice); an unknown rule fails plain', async () => {
    const cwd = eslintRepo();
    // The order knows prefer-const (its own finding rule): a prefer-const
    // leftover is structured.
    const { exec: execA } = fakeExec(() => ({
      code: 1,
      output: eslintJson(cwd, [{ ruleId: 'prefer-const', message: 'x' }]),
    }));
    const known = await executeLintAutofix(
      lintOrder('lint:typescript', 'src/a.ts'),
      makeCtx(cwd, { exec: execA }),
    );
    expect(known.kind).toBe('failed');
    if (known.kind === 'failed') expect(known.leftoverRules).toEqual(['prefer-const']);
    // A rule the order never carried is net-new (or unparsed): plain
    // failure, no structured leftovers, so the runner discards the diff.
    const { exec: execB } = fakeExec(() => ({
      code: 1,
      output: eslintJson(cwd, [{ ruleId: 'no-debugger', message: 'x' }]),
    }));
    const unknown = await executeLintAutofix(
      lintOrder('lint:typescript', 'src/a.ts'),
      makeCtx(cwd, { exec: execB }),
    );
    expect(unknown.kind).toBe('failed');
    if (unknown.kind === 'failed') expect(unknown.leftoverRules).toBeUndefined();
  });

  it('refuses a pack that declares no fix mode, with the pack named', async () => {
    const cwd = eslintRepo();
    const { exec } = fakeExec();
    const outcome = await executeLintAutofix(
      lintOrder('lint:java', 'src/a.ts'),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('java');
  });
});
