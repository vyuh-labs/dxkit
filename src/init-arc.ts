/**
 * The init FINISHING arc — the step that makes `init` actually FINISH.
 *
 * `init --yes` already asks nothing; the friction was that it stopped early and
 * printed two commands of homework (`tools install`, `baseline create`) instead
 * of running them. This module runs that tail as a smooth, progress-rendered
 * sequence: provision the scanners → capture today's baseline (visibility-
 * resolved per Rule 11, non-interactive, FAIL-SOFT) → hand back a state the
 * pure {@link buildInitClosing} turns into a single mental-model closing.
 *
 * Split in two on purpose:
 *   - `finishSetup` does the IO and drives the spinner UI (not unit-tested);
 *   - `buildFindingBreakdown` + `buildInitClosing` are PURE, so the
 *     zero-question / one-closing-sentence / brownfield-mental-model contract
 *     is assertable in a transcript test (mirror of `loop/demo.ts:buildNextSteps`,
 *     the template the design doc names for every funnel closer).
 */

import * as logger from './logger';
import { dxkitCli } from './self-invocation';
import type { BaselineMode } from './baseline/modes';
import type { BaselineEntry } from './baseline/types';
import type { LanguageToolchainGap } from './languages/toolchain-coverage';

/** A coarse grouping of grandfathered findings — the emotional payoff line
 *  ("3 secrets · 12 dependency CVEs · 32 code patterns") the user sees as their
 *  repo becomes gated. Kept deliberately coarse; the exact per-kind taxonomy
 *  lives in the identity layer, this is a human summary. */
export interface FindingBreakdown {
  readonly secrets: number;
  readonly deps: number;
  readonly code: number;
  readonly other: number;
  readonly total: number;
}

/** Group baseline entries into the coarse human classes. Pure. */
export function buildFindingBreakdown(findings: readonly BaselineEntry[]): FindingBreakdown {
  let secrets = 0;
  let deps = 0;
  let code = 0;
  let other = 0;
  for (const f of findings) {
    switch (f.kind) {
      case 'secret':
        secrets++;
        break;
      case 'dep-vuln':
        deps++;
        break;
      case 'code':
      case 'config':
        code++;
        break;
      default:
        other++;
    }
  }
  return { secrets, deps, code, other, total: findings.length };
}

/** Render a breakdown as a `·`-separated human line, omitting zero classes. */
export function formatBreakdown(b: FindingBreakdown): string {
  const parts: string[] = [];
  if (b.secrets) parts.push(`${b.secrets} secret${b.secrets === 1 ? '' : 's'}`);
  if (b.deps) parts.push(`${b.deps} dependency CVE${b.deps === 1 ? '' : 's'}`);
  if (b.code) parts.push(`${b.code} code pattern${b.code === 1 ? '' : 's'}`);
  if (b.other) parts.push(`${b.other} other`);
  return parts.join(' · ');
}

/** The state the pure closing builder consumes — everything it needs to teach
 *  the brownfield mental model in one sentence, with zero homework commands. */
export interface InitClosingState {
  /** Did we arm gates AND establish a baseline (committed count or ref)? */
  readonly gated: boolean;
  /** Grandfathered finding count for committed modes; null for ref-based
   *  (the ref itself is the baseline — there is no init-time count) or when
   *  the baseline capture was skipped/failed. */
  readonly baselineFindings: number | null;
  readonly baselineMode: BaselineMode | null;
  /** Human labels of the gate surfaces that were armed (for the recap line). */
  readonly surfaces: readonly string[];
  /** Scanner classes still missing at baseline time (coverage gap to teach). */
  readonly incompleteScanners: readonly string[];
  /** Active language packs whose OWN toolchain is absent from PATH, so their
   *  deep classes (lint / license / correctness floor) were UNMEASURED. When
   *  non-empty the "gated" claim is QUALIFIED — never presented as full coverage
   *  (the unprovisioned-toolchain class). Empty on the common fully-provisioned
   *  path. */
  readonly languageToolchainGaps: readonly LanguageToolchainGap[];
  readonly elapsedMs: number;
}

/** One actionable next step: a label and the exact command to run. */
export interface ClosingAction {
  readonly label: string;
  readonly command: string;
}

/** The structured closing — the renderer colors it; tests assert its fields. */
export interface InitClosing {
  readonly headline: string;
  /** "ready in Ns" — the time-to-first-verdict stamp. */
  readonly ready: string;
  /** The mental-model body: at most a couple of short sentences. */
  readonly body: readonly string[];
  /** A single optional caution (incomplete scanner coverage). */
  readonly caution: string | null;
  readonly actions: readonly ClosingAction[];
}

function secondsLabel(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return 'ready in under a second';
  if (s < 90) return `ready in ${Math.round(s)}s`;
  return `ready in ${Math.round(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * Build the closing from the finished-arc state. PURE — no IO, no `Date.now`.
 *
 * Contract (the design doc's DoD):
 *   - teaches the brownfield mental model in ONE sentence;
 *   - carries ZERO homework commands when gated (the tail already ran) — the
 *     only command it may name is `tools install` to CLOSE a real coverage gap,
 *     which is genuinely still needed;
 *   - the two standing actions are always Verify (`doctor`) and Undo
 *     (`uninstall`), so a first-timer always knows how to check and how to back out.
 */
export function buildInitClosing(state: InitClosingState): InitClosing {
  const ready = secondsLabel(state.elapsedMs);
  const actions: ClosingAction[] = [
    { label: 'Verify', command: dxkitCli('doctor') },
    { label: 'Undo', command: dxkitCli('uninstall') },
  ];

  // Not gated: a context-only install (dx-only, no gate surfaces). Sell the
  // context win, and teach the ONE command that turns on the gate.
  if (!state.gated) {
    return {
      headline: 'dxkit is set up.',
      ready,
      body: ['Claude Code now has full project context for this repo.'],
      caution: null,
      actions: [
        { label: 'Gate it', command: dxkitCli('init --claude-loop') },
        { label: 'Undo', command: dxkitCli('uninstall') },
      ],
    };
  }

  const body: string[] = [];
  if (state.baselineMode === 'ref-based') {
    // Public repo: the default branch IS the baseline; nothing was written.
    body.push('Your default branch is the baseline — nothing was written to your tree.');
    body.push('Anything a change ADDS from here is caught before it ships.');
  } else if (state.baselineFindings !== null) {
    const n = state.baselineFindings;
    if (n === 0) {
      body.push('Your repo is clean today — that clean state is now the floor.');
      body.push('Anything a change ADDS from here is caught before it ships.');
    } else {
      body.push(
        `${n} finding${n === 1 ? '' : 's'} today ${n === 1 ? 'is' : 'are'} grandfathered — ` +
          `${n === 1 ? "it won't" : "they won't"} block you.`,
      );
      body.push('Anything a change ADDS from here is caught before it ships.');
    }
  } else {
    // Gated (surfaces armed) but no baseline count — a fail-soft skip.
    body.push('Your gates are armed. Capture a baseline to set the grandfathered floor:');
    body.push(`  ${dxkitCli('baseline create')}`);
  }

  // Honesty gate: when an ACTIVE language pack's OWN toolchain is missing, its
  // deep classes (lint / license / the compile-and-test correctness floor) were
  // NOT measured — so we must NOT present this as full coverage, and the
  // remediation must name the ROOT prerequisite (install the toolchain), never
  // loop the user back to `tools install` (whose own prerequisite is the very
  // thing that's missing). This is the unprovisioned-toolchain class: a
  // pure-C# repo baselined with no `dotnet` on PATH, headlined "You're gated ✓".
  const gaps = state.languageToolchainGaps;
  if (gaps.length > 0) {
    const langWord = gaps.length === 1 ? gaps[0].displayName : `${gaps.length} languages`;
    const toolchains = gaps
      .map((g) => `${g.displayName} (\`${g.missingBinaries.join('`, `')}\`)`)
      .join('; ');
    const caution =
      `${langWord}'s toolchain isn't on PATH (${toolchains}), so its deeper checks ` +
      `— lint, license, and the compile/test floor — were NOT measured. The ` +
      `language-agnostic classes (secrets, dependency CVEs, SAST, duplication) ARE ` +
      `gated. Install the toolchain (or use the generated devcontainer), then re-run ` +
      `\`${dxkitCli('tools install')}\` and \`${dxkitCli('baseline create --force')}\` for full coverage.`;
    // Qualified headline — measured what it could, honest about the rest.
    return { headline: "You're gated for what's measurable.", ready, body, caution, actions };
  }

  // Same honesty gate, one class over: a scanner that wasn't available at
  // capture time means the baseline is PARTIAL — those finding kinds were
  // never measured here, so they are DEFERRED to an environment that can
  // observe them (CI, with the guaranteed toolchain), not fail-open-committed
  // as if gated. An unqualified "You're gated." over that baseline is a
  // confident answer where the honest output is a boundary (the same shape as
  // the unprovisioned-toolchain case above).
  if (state.incompleteScanners.length > 0) {
    const caution =
      `${state.incompleteScanners.length} scanner class(es) weren't available here ` +
      `(${state.incompleteScanners.join(', ')}) — likely a package index that can't reach the ` +
      `pinned versions (a mirror / offline proxy). They are DEFERRED to CI, which captures them ` +
      `with the guaranteed toolchain and completes the baseline automatically. Until that first ` +
      `CI run lands, those classes are not yet gating — nothing else to do. ` +
      `(Or, offline: \`${dxkitCli('tools install')}\` then \`${dxkitCli('baseline create --force')}\` ` +
      `once the scanners resolve.)`;
    return { headline: "You're gated for what's measurable.", ready, body, caution, actions };
  }

  return { headline: "You're gated.", ready, body, caution: null, actions };
}

/** Options for the finishing arc. */
export interface FinishSetupOptions {
  readonly cwd: string;
  /** Human labels of the gate surfaces init just armed (for the closing recap). */
  readonly surfaces: readonly string[];
  /** Overwrite an existing baseline (the `--force` passthrough). */
  readonly force?: boolean;
}

/**
 * Run the finishing tail with live progress, and return the closing state.
 *
 * FAIL-SOFT throughout: a scanner that won't install, or a baseline capture
 * that throws, degrades to a warned step — never an aborted init. A partly-set-up
 * repo with armed gates is strictly better than an error at the finish line.
 */
export async function finishSetup(opts: FinishSetupOptions): Promise<InitClosingState> {
  const started = Date.now();
  const { cwd } = opts;

  // Mute the reused installers/analyzers' ordinary logger output for the whole
  // arc — they'd otherwise bleed progress chatter through our step UI. The
  // spinner bypasses the mute, so the steps still render. Restored in `finally`.
  const priorQuiet = logger.setQuiet(true);
  try {
    return await runFinishingArc(opts, cwd, started);
  } finally {
    logger.setQuiet(priorQuiet);
  }
}

async function runFinishingArc(
  opts: FinishSetupOptions,
  cwd: string,
  started: number,
): Promise<InitClosingState> {
  // 1) Provision the scanners the baseline needs. Running this FIRST is what
  //    makes the baseline complete (and keeps its incomplete-capture prompt
  //    unreachable — the design doc's key sequencing insight).
  const { installMissingTools } = await import('./tools-cli');
  const scan = logger.startSpinner('Installing scanners');
  const tools = await installMissingTools(cwd, {
    onEvent: (e) => {
      if (e.phase === 'installing') scan.setLabel(`Installing ${e.name}`);
    },
  });
  {
    const present = tools.alreadyPresent.length;
    if (tools.installed.length > 0) {
      scan.note(`installed ${tools.installed.join(', ')}`);
      scan.succeed(
        `${tools.installed.length} installed${present ? ` · ${present} already present` : ''}`,
      );
    } else if (present > 0) {
      scan.succeed(`${present} already present`);
    } else {
      scan.succeed('nothing to install');
    }
    for (const f of tools.failed) scan.note(`could not install ${f.name}: ${f.reason}`);
  }

  // 2) Optimize the config for THIS repo. `gatherConfigPlan` computes the
  //    deterministic per-capability plan from observable repo facts (same repo →
  //    same plan) and `applyConfigPlan` merge-writes it into policy.json without
  //    clobbering user edits. This turns a minimal-default install into a
  //    repo-optimized one — it enables the lint / schema / duplication gates that
  //    fit the repo (mostly warn-tier, so it adds visibility, not new blocks) and
  //    PINS postures like baseline.mode. Runs BEFORE the baseline so baseline.mode
  //    is pinned before capture. Fail-soft.
  const cfg = logger.startSpinner('Optimizing config for this repo');
  try {
    const { gatherConfigPlan } = await import('./discovery/commands');
    const { applyConfigPlan } = await import('./configure-cli');
    const plan = gatherConfigPlan(cwd);
    if (plan.length > 0) {
      for (const item of plan) cfg.note(`${item.section} → ${item.summary}`);
      applyConfigPlan(cwd, plan);
      cfg.succeed(`${plan.length} setting${plan.length === 1 ? '' : 's'} tuned to this repo`);
    } else {
      cfg.succeed('already optimal');
    }
  } catch (err) {
    cfg.warn(`skipped — ${(err as Error).message}`);
  }

  // 3) Capture today's baseline — visibility-resolved mode, non-interactive.
  //    Calling createBaseline directly bypasses the CLI's incomplete-capture
  //    prompt by construction (it captures whatever scanners are present), so
  //    the arc never hangs; we surface the coverage gap as a note instead.
  const { createBaseline, gatherScanCoverage } = await import('./baseline/create');
  const { missingScanners } = await import('./baseline/coverage');
  const incompleteScanners = missingScanners(gatherScanCoverage(cwd)).map((m) => m.tool);

  // The pack-driven "is the primary language's toolchain present" signal — the
  // SAME one doctor reports — so the finish arc can't over-claim coverage when
  // the repo's own language depth is unmeasured (gh onboarding honesty class).
  const { detectActiveLanguages } = await import('./languages');
  const { assessLanguageToolchains } = await import('./languages/toolchain-coverage');
  const languageToolchainGaps = assessLanguageToolchains(detectActiveLanguages(cwd));

  const bl = logger.startSpinner('Capturing baseline');
  // The first baseline scans the whole tree (SAST + deps + coverage), which is
  // minutes on a large repo — say so, so a long-running spinner never reads as
  // a hang. (No-op'd visually for the fast already-gated path, which resolves
  // before anyone reads it.)
  bl.note('scanning your code for the grandfathered floor — the first run can take a few minutes');
  let baselineFindings: number | null = null;
  let baselineMode: BaselineMode | null = null;
  try {
    const result = await createBaseline({ cwd, force: !!opts.force });
    baselineMode = result.mode.mode;
    if (result.mode.mode === 'ref-based') {
      bl.note('public repo → ref-based (nothing written to your tree)');
      if (result.mode.ref) bl.note(`baseline is ${result.mode.ref}, compared on every check`);
      bl.succeed('ref-based');
    } else if (result.file) {
      const b = buildFindingBreakdown(result.file.findings);
      baselineFindings = b.total;
      if (b.total > 0) bl.note(formatBreakdown(b));
      const modeWord =
        result.mode.mode === 'committed-sanitized' ? 'committed (sanitized)' : 'committed';
      bl.note(`private repo → ${modeWord} baseline`);
      // A class this environment could not observe (a scanner your package index
      // couldn't reach, a wrong-host build gate) is recorded as DEFERRED, not
      // fail-open-committed as if measured. It completes on CI with the
      // guaranteed toolchain; the gate is honest ("completing on CI") until then.
      const deferred = result.file.deferred ?? [];
      if (deferred.length > 0) {
        bl.note(
          `→ ${deferred.length} class(es) deferred to CI: ${deferred.map((d) => d.label).join(', ')}`,
        );
        bl.note('  (captured on the first CI run with the guaranteed toolchain — nothing to do)');
      }
      bl.succeed(`${b.total} finding${b.total === 1 ? '' : 's'} grandfathered`);
    } else {
      bl.succeed('captured');
    }
  } catch (err) {
    const msg = (err as Error).message;
    // Re-init on an already-adopted repo: a committed baseline exists, so
    // createBaseline refuses. That's not a failure — the repo is already
    // gated. Read the existing baseline and report its grandfathered floor.
    const existing = msg.match(/already exists at (.+?\.json)/);
    if (existing) {
      try {
        const { readBaselineFile } = await import('./baseline/baseline-file');
        const b = buildFindingBreakdown(readBaselineFile(existing[1]).findings);
        baselineFindings = b.total;
        baselineMode = 'committed-full';
        if (b.total > 0) bl.note(formatBreakdown(b));
        bl.note('baseline already present — your repo is already gated');
        bl.succeed(`${b.total} finding${b.total === 1 ? '' : 's'} already grandfathered`);
      } catch {
        bl.succeed('baseline already present');
      }
    } else {
      // Fail-soft: the gates are still armed; the user can capture a baseline
      // themselves. Never abort init at the finish line.
      bl.warn(`skipped — ${msg}`);
    }
  }

  return {
    gated: opts.surfaces.length > 0,
    baselineFindings,
    baselineMode,
    surfaces: opts.surfaces,
    incompleteScanners,
    languageToolchainGaps,
    elapsedMs: Date.now() - started,
  };
}

/** Render a built closing to stdout (the init case's final output). */
export function renderInitClosing(closing: InitClosing): void {
  logger.header(`${closing.headline}  ✓   ${closing.ready}`);
  for (const line of closing.body) logger.info(line);
  if (closing.caution) {
    console.log(''); // slop-ok: spacing before the caution
    logger.warn(closing.caution);
  }
  console.log(''); // slop-ok: spacing before the actions
  const width = Math.max(...closing.actions.map((a) => a.label.length));
  for (const a of closing.actions) {
    logger.dim(`${a.label.padEnd(width)}   ${a.command}`);
  }
}
