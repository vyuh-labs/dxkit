/**
 * The tree-trust boundary in the shipped guardrails workflow is FORK-KEYED
 * (4.3.2): `--untrusted` fires when the PR head repo differs from the base
 * repo, not on every pull_request event. The event-keyed version (S-05,
 * 4.0.4) silently disabled repo-declared custom-check/lint gating on EVERY
 * PR — net-new lint errors stopped gating at PR time and nothing said so.
 *
 * This pins three things about the template:
 *   1. the decision is computed ONCE (a 'Resolve tree trust' step) and every
 *      analyzing step consumes its output — the two-independent-computations
 *      shape is exactly the drift class Rule 2.30 exists for;
 *   2. the condition is fork-keyed and fail-closed (a missing head repo
 *      compares unequal → untrusted; a step skip skips the consumer);
 *   3. the head-repo value reaches the shell via `env:` — never interpolated
 *      into a run script line.
 *
 * The comment-defer workflow is deliberately NOT fork-keyed: it runs in a
 * privileged issue_comment context (contents: write), is restricted to
 * same-repo PRs, and its --untrusted cache-warming run only validates
 * dep-vuln fingerprints — the boundary stays unconditional there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOWS = join(__dirname, '..', 'src-templates', '.github', 'workflows');
const guardrails = readFileSync(join(WORKFLOWS, 'dxkit-guardrails.yml'), 'utf8');
const commentDefer = readFileSync(join(WORKFLOWS, 'dxkit-comment-defer.yml'), 'utf8');

describe('guardrails workflow tree trust is fork-keyed and single-sourced', () => {
  it('computes the --untrusted decision exactly once, in the trust step', () => {
    expect(guardrails).toContain('- name: Resolve tree trust');
    const assignments = guardrails.match(/UNTRUSTED="--untrusted"/g) ?? [];
    expect(assignments).toHaveLength(1);
  });

  it('keys the boundary on fork-ness, not the pull_request event alone', () => {
    expect(guardrails).toMatch(
      /\[ "\$\{GITHUB_EVENT_NAME\}" = "pull_request" \] && \[ "\$\{DXKIT_PR_HEAD_REPO\}" != "\$\{GITHUB_REPOSITORY\}" \]/,
    );
    // The old event-only condition must not survive anywhere.
    expect(guardrails).not.toMatch(/"pull_request" \]; then UNTRUSTED/);
  });

  it('every analyzing step consumes the one trust output (guardrail check + flow console)', () => {
    const consumers =
      guardrails.match(/UNTRUSTED="\$\{\{ steps\.trust\.outputs\.flag \}\}"/g) ?? [];
    expect(consumers).toHaveLength(2);
  });

  it('the always()-guarded console step skips when trust was never resolved (fail closed)', () => {
    expect(guardrails).toContain("if: always() && steps.trust.outcome == 'success'");
  });

  it('the head repo reaches the shell via env, never inline run interpolation', () => {
    // The expression appears exactly once — as the env: value of the trust step.
    const uses = guardrails.match(/github\.event\.pull_request\.head\.repo\.full_name/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(guardrails).toContain(
      'DXKIT_PR_HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}',
    );
  });

  it('comment-defer keeps its unconditional --untrusted (privileged context)', () => {
    expect(commentDefer).toContain('--untrusted');
  });
});
