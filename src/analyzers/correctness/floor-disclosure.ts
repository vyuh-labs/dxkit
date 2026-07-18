/**
 * Floor DISCLOSURE — making a failing build impossible to miss in a PR.
 *
 * The diff-scoped CI floor (T2.3) deliberately does not BLOCK on a
 * pre-existing broken build — but "warn" must not mean "a line in a green
 * check's log nobody opens". A reviewer approving a PR onto a broken base
 * branch should be unable to claim they didn't know. So one disclosure
 * builder feeds every surface reviewers actually look at:
 *
 *   - the PR COMMENT (the guardrail workflow appends
 *     `floorDisclosureMarkdown` to the report it posts — reviewers read
 *     the conversation);
 *   - CHECK ANNOTATIONS (`githubAnnotations` → `::error`/`::warning`
 *     workflow commands, surfaced in the Checks tab and the Files view);
 *   - the RUN'S STEP SUMMARY (same markdown, on the workflow run page).
 *
 * Three tiers, same vocabulary as the attribution lattice:
 *   net-new       → 🛑 error  — this PR broke it (the gate already blocks).
 *   pre-existing  → ⚠️ warning — the BASE BRANCH is broken; not this PR's
 *                   fault and not blocking, but approvers are told, loudly,
 *                   that they are merging onto a broken build.
 *   unattributed  → ⚠️ warning — failing now, base side unobservable.
 * A point-in-time failure (no base resolvable) gets the error tier: the
 * check is red anyway; the annotation says why without opening the log.
 *
 * Returns null / [] when there is nothing to shout about — a green floor
 * stays silent.
 */
import { dxkitCli } from '../../self-invocation';
import type { SurfaceFloorOutcome } from './surface-run';
import type { AttributedFloorFailure } from './attribution';
import type { CorrectnessCheckResult } from './run';

function repro(c: CorrectnessCheckResult): string {
  return [c.bin, ...(c.args ?? [])].filter(Boolean).join(' ');
}

function mdCheck(c: CorrectnessCheckResult): string[] {
  const lines = [`- **${c.pack} ${c.label}** — repro: \`${repro(c)}\``];
  if (c.output) {
    lines.push('  <details><summary>output</summary>');
    lines.push('');
    lines.push('  ```');
    for (const l of c.output.split('\n').slice(-15)) lines.push(`  ${l}`);
    lines.push('  ```');
    lines.push('  </details>');
  }
  return lines;
}

function tiers(outcome: SurfaceFloorOutcome): {
  netNew: CorrectnessCheckResult[];
  preExisting: CorrectnessCheckResult[];
  unattributed: CorrectnessCheckResult[];
  pointInTime: CorrectnessCheckResult[];
} {
  const a = outcome.attributed;
  const pick = (t: AttributedFloorFailure['attribution']) =>
    (a ?? []).filter((x) => x.attribution === t).map((x) => x.check);
  return {
    netNew: a ? pick('net-new') : [],
    preExisting: a ? pick('pre-existing') : [],
    unattributed: a ? pick('unattributed') : [],
    // No attribution ran (green, disabled, or no base resolvable): any
    // failure is a point-in-time red — still worth a legible annotation.
    pointInTime: a ? [] : (outcome.result?.checks ?? []).filter((c) => c.status === 'fail'),
  };
}

/** Markdown block for the PR comment + step summary; null when green. */
export function floorDisclosureMarkdown(outcome: SurfaceFloorOutcome): string | null {
  const { netNew, preExisting, unattributed, pointInTime } = tiers(outcome);
  if (!netNew.length && !preExisting.length && !unattributed.length && !pointInTime.length) {
    return null;
  }
  const lines: string[] = [];
  if (netNew.length > 0) {
    lines.push('## 🛑 Correctness floor: this PR breaks the build/tests (net-new — BLOCKING)');
    lines.push('');
    for (const c of netNew) lines.push(...mdCheck(c));
    lines.push('');
  }
  if (pointInTime.length > 0) {
    lines.push(
      '## 🛑 Correctness floor: build/tests failing (no merge-base to attribute against — BLOCKING)',
    );
    lines.push('');
    for (const c of pointInTime) lines.push(...mdCheck(c));
    lines.push('');
  }
  if (preExisting.length > 0) {
    lines.push(
      '## ⚠️ THE BASE BRANCH BUILD/TESTS ARE BROKEN (pre-existing — not caused by this PR, not blocking)',
    );
    lines.push('');
    lines.push(
      '> **Approvers, read this before approving:** these failures exist on the base branch itself. ' +
        'This PR did not cause them and is not blocked by them — but merging means merging onto a ' +
        'broken build. Approve only if you accept that, and make sure someone owns the fix: ' +
        `\`${dxkitCli('debt')}\` prints the prioritized repair inventory.`,
    );
    lines.push('');
    for (const c of preExisting) lines.push(...mdCheck(c));
    lines.push('');
  }
  if (unattributed.length > 0) {
    lines.push(
      '## ⚠️ Floor failures dxkit could not attribute (base side unobservable — not blocking)',
    );
    lines.push('');
    lines.push(
      '> These checks fail on this PR, but the merge-base run could not observe them ' +
        '(toolchain/deps unavailable in the base worktree), so dxkit refuses to blame either side. ' +
        'Review advised.',
    );
    lines.push('');
    for (const c of unattributed) lines.push(...mdCheck(c));
    lines.push('');
  }
  return lines.join('\n');
}

/** One-line GitHub workflow-command annotations (Checks tab + Files view). */
export function githubAnnotations(outcome: SurfaceFloorOutcome): string[] {
  const { netNew, preExisting, unattributed, pointInTime } = tiers(outcome);
  const out: string[] = [];
  for (const c of netNew) {
    out.push(
      `::error title=dxkit floor — this PR breaks the build/tests::${c.pack} ${c.label} is a NET-NEW failure (passes on the base branch). Repro: ${repro(c)}`,
    );
  }
  for (const c of pointInTime) {
    out.push(
      `::error title=dxkit floor — build/tests failing::${c.pack} ${c.label} failed. Repro: ${repro(c)}`,
    );
  }
  for (const c of preExisting) {
    out.push(
      `::warning title=dxkit floor — the BASE BRANCH is broken::${c.pack} ${c.label} fails on the base branch too. Not caused by this PR and not blocking — but approving merges onto a broken build. Inventory the debt: ${dxkitCli('debt')}`,
    );
  }
  for (const c of unattributed) {
    out.push(
      `::warning title=dxkit floor — unattributed failure::${c.pack} ${c.label} fails here and the base side could not be observed. Review advised.`,
    );
  }
  return out;
}
