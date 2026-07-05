/**
 * The load-bearing invariant behind the enforcement-path checks: the
 * status-check CONTEXT dxkit's guardrails workflow emits MUST equal the name
 * dxkit's code + `protect` require (`GUARDRAIL_CHECK`). When they drift, a
 * correctly-protected repo reads as "BYPASSABLE" and `protect` writes a
 * never-satisfiable required check — the class of bug that shipped when the
 * guardrail job had no explicit `name:` and GitHub used the job id `guardrail`
 * while the code expected `dxkit-guardrails`.
 *
 * GitHub derives an Actions check-run's context from the job's `name:` (or the
 * job id when `name:` is absent). This test parses the workflow TEMPLATE's
 * guardrail job name and pins it to `GUARDRAIL_CHECK`, so the two can never
 * silently diverge again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GUARDRAIL_CHECK, LEGACY_GUARDRAIL_CHECK } from '../src/enforcement';

/** The check-run context the workflow will emit: the guardrail job's `name:`
 *  (4-space indented, job level) or the job id `guardrail` when none is set. */
function emittedGuardrailContext(workflow: string): string {
  const lines = workflow.split('\n');
  const jobIdx = lines.findIndex((l) => /^ {2}guardrail:\s*$/.test(l));
  if (jobIdx === -1) throw new Error('guardrail job not found in template');
  for (let i = jobIdx + 1; i < lines.length; i++) {
    // Stop at the next top-level job (2-space key) — we've left the guardrail job.
    if (/^ {2}\S/.test(lines[i])) break;
    const m = lines[i].match(/^ {4}name:\s*(\S+)\s*$/); // job-level name (not a 6-space step name)
    if (m) return m[1];
  }
  return 'guardrail'; // job id fallback (the pre-fix behavior)
}

describe('guardrails workflow emits the context dxkit requires', () => {
  const template = readFileSync(
    join(__dirname, '..', 'src-templates', '.github', 'workflows', 'dxkit-guardrails.yml'),
    'utf8',
  );

  it('the guardrail job name equals GUARDRAIL_CHECK (so protect + doctor + the ruleset all match)', () => {
    expect(emittedGuardrailContext(template)).toBe(GUARDRAIL_CHECK);
  });

  it('the emitted context is no longer the bare legacy job id', () => {
    expect(emittedGuardrailContext(template)).not.toBe(LEGACY_GUARDRAIL_CHECK);
  });
});
