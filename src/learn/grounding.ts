/**
 * Assistant grounding for `learn --serve` (issue #245).
 *
 * ONE function assembles BOTH the system prompt the provider receives AND the
 * human-readable disclosure of exactly what is being sent — from the same
 * walk over the same data (Rule 2.30). The page's "what is sent" statement
 * can therefore never drift from the payload: if a section is added to the
 * prompt, its disclosure line is added in the same place or it doesn't ship.
 *
 * Privacy design (user decision, 2026-08-02): BYO key means grounding goes
 * to the USER'S chosen provider. Default is SUMMARIES AND COUNTS only (the
 * sanitized-baseline ethos). Finding-level detail (doctor check labels with
 * remedies, blocking-finding fingerprints) is behind an explicit visible
 * toggle. The assistant explains and produces exact commands; it executes
 * nothing — the one write path (`configure --apply`) is only ever quoted.
 */
import type { LearnBundle } from './bundle';
import type { LearnRepoStatus } from './repo-status';

export interface GroundingResult {
  system: string;
  /** One line per thing included — rendered verbatim on the page. */
  disclosure: string[];
  repoMode: boolean;
  detail: boolean;
}

const ASSISTANT_CHARTER = `You are the dxkit learn assistant, running locally next to the user's terminal.
Answer ONLY from the grounding below — the registry digest, the docs, and (when present) this repo's status.
When the answer is an action, produce the EXACT command to run, or the sentence to tell a coding agent.
You execute nothing and cannot change anything; the one configuration write path is 'vyuh-dxkit configure --apply', which you may quote but the user runs.
Your knowledge is version-locked: you know exactly the capabilities of the dxkit version named below (the one installed here), generated from its own registries — never speculate about newer or older versions.
If the grounding does not answer a question, say so plainly, suggest 'vyuh-dxkit doctor' or the reference shelf, and point the user to the public repository (github.com/vyuh-labs/dxkit) or 'vyuh-dxkit issue' to report the documentation gap; never invent capabilities or flags.`;

export function assembleGrounding(
  bundle: LearnBundle,
  status: LearnRepoStatus | null,
  opts: { detail?: boolean } = {},
): GroundingResult {
  const detail = !!opts.detail && status !== null;
  const parts: string[] = [ASSISTANT_CHARTER];
  const disclosure: string[] = [];

  // 1. The registry digest — compiled-in product facts, no repo data.
  const capLines = bundle.capabilities.map(
    (c) =>
      `- ${c.id} [${c.groupLabel}${c.tier === 'core' ? ', core' : ''}]: ${c.docsBlurb ?? c.summary}`,
  );
  const knobLines = bundle.knobs.map(
    (k) => `- ${k.path} (command: ${k.command})${k.note ? ` — ${k.note}` : ''}`,
  );
  parts.push(`## Capability registry (dxkit v${bundle.version})\n${capLines.join('\n')}`);
  parts.push(`## Policy knobs\n${knobLines.join('\n')}`);
  if (bundle.policyFields.length > 0) {
    const fieldLines = bundle.policyFields.map(
      (f) =>
        `- ${f.path} (${f.type}${f.default !== undefined ? `, default ${f.default}` : ''}${f.enum ? `, one of: ${f.enum.join('|')}` : ''}): ${f.description || '(no description)'}`,
    );
    parts.push(
      `## Policy field reference (every field .dxkit/policy.json accepts)\n${fieldLines.join('\n')}`,
    );
  }
  disclosure.push(
    `The capability registry: every command name + description, policy knob names, and the full policy field reference (product facts, no repo data).`,
  );

  // 2. The curated docs + the grounded slice of the reference shelf — all
  // product facts shipped with the package (never repo data). The command
  // pages and deep benchmark chapters stay page/search-only for size; the
  // registry digest above covers every command.
  for (const d of bundle.docs) {
    parts.push(`## Doc: ${d.title}\n${d.markdown}`);
  }
  for (const r of bundle.reference.filter((x) => x.grounded)) {
    parts.push(`## Reference: ${r.title} (docs/${r.relPath})\n${r.markdown}`);
  }
  if (bundle.skills.length > 0) {
    parts.push(
      `## Agent skills dxkit installs\n${bundle.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`,
    );
  }
  if (bundle.tasks.length > 0) {
    parts.push(
      `## Remediation lane tasks\n${bundle.tasks
        .map(
          (t) =>
            `- ${t.id} (${t.tier} tier — ${t.tierWhy}): ${t.summary} Verified by the ${t.verify}${t.hinge ? `; score hinge: ${t.hinge}` : ''}.`,
        )
        .join(
          '\n',
        )}\nTasks run on the scheduled lane, or as one-off dispatch campaigns from the Actions UI (workflow_dispatch inputs: task, custom prompt, spend/turn/minute overrides — clamped by remediate.maxDispatchBudget). Everything lands only via a PR through the gate.`,
    );
  }
  disclosure.push(
    `The built-in docs: mental model, quickstarts, capabilities-and-limits, extending dxkit, the configuration reference, getting started, benchmarks overview, plus the installed agent-skill and remediation-task catalogs.`,
  );

  // 3. Repo status — ONLY in repo mode, summaries by default.
  if (status) {
    const s: string[] = [];
    s.push(`dxkit installed: ${status.installed ? 'yes' : 'no'}`);
    if (status.policy) {
      s.push(
        `policy: preset=${status.policy.preset ?? '(none)'}, custom checks=${status.policy.checksCount}, lint gate=${status.policy.lintEnabled ? 'on' : 'off'}, lanes=[${status.policy.lanes.join(', ') || 'none'}]`,
      );
    }
    for (const b of status.baselines) {
      s.push(
        `baseline '${b.name}': ${b.entryCount} grandfathered findings${b.capturedAt ? `, captured ${b.capturedAt.slice(0, 10)}` : ''}`,
      );
    }
    if (status.lastVerdict) {
      const v = status.lastVerdict;
      s.push(
        `last guardrail verdict: ${v.unattributableCount > 0 ? 'CANNOT GATE' : v.blocks ? 'BLOCKED' : 'PASSED'} (${v.blockingCount} blocking, ${v.warningCount} warnings, at ${v.ranAt})`,
      );
    }
    if (status.doctor) {
      const failing = status.doctor.checks.filter((c) => !c.ok);
      s.push(
        `doctor: ${status.doctor.checks.length - failing.length} checks pass, ${failing.length} failing`,
      );
      if (detail) {
        for (const c of failing) {
          s.push(
            `  failing: ${c.label}${c.fix ? ` — remedy: ${c.fix.command ?? c.fix.hint}` : ''}`,
          );
        }
        for (const r of status.doctor.recommendations ?? []) {
          s.push(
            `  recommended: ${r.id} — ${r.recommendation.reason} (${r.recommendation.command})`,
          );
        }
      }
    }
    if (detail && status.rawPolicyText) {
      s.push(`full committed policy.json:\n${status.rawPolicyText}`);
    }
    if (detail && status.lastVerdict?.blockingFindings?.length) {
      for (const f of status.lastVerdict.blockingFindings) {
        s.push(`  blocking finding: kind=${f.kind}, fingerprint=${f.fingerprint}`);
      }
    }
    parts.push(`## This repo (live status)\n${s.join('\n')}`);
    disclosure.push(
      detail
        ? `This repo's status IN DETAIL: the full committed policy.json, baseline counts, the last verdict, each failing doctor check with its remedy, and blocking-finding fingerprints. (Detail toggle is ON.)`
        : `This repo's status as SUMMARIES ONLY: policy summary, baseline entry counts, the last verdict word, and doctor pass/fail counts. No file paths, no finding contents, no check labels. (Turn on the detail toggle to include failing checks + remedies.)`,
    );
  } else {
    disclosure.push(`No repo data at all — this is the zero-context guide.`);
  }

  disclosure.push(`Your question and the visible chat history.`);
  disclosure.push(
    `Sent DIRECTLY from this machine to the provider you chose. dxkit runs no server of its own and stores nothing.`,
  );

  return { system: parts.join('\n\n'), disclosure, repoMode: status !== null, detail };
}
