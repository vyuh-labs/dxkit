import { parseArgs } from 'node:util';
import { renderCommandIndex, suggestCommand } from './discovery/commands';
import { suspectVendoredEntries } from './analyzers/tools/vendored-advisor';
import { detect } from './detect';
import { generate } from './generator';
import { promptForConfig, promptFlowSetup } from './prompts';
import { detectFlowTopology, applyFlowSetup } from './analyzers/flow/setup';
import { existingFlowMode } from './analyzers/flow/config';
import { runUpdate, writeInstallFlags } from './update';
import { runDoctor } from './doctor';
import { VERSION } from './constants';
import * as logger from './logger';
import { GenerationMode } from './types';
import { formatTopActionLine, formatTopActionsBlock } from './scoring';
import { renderToolsUnavailableLines } from './analyzers/tools/tools-unavailable-prose';
import { getReportDate } from './analyzers/tools/report-date';
import {
  checkFailOnScore,
  checkFailOnSeverity,
  parseScoreThreshold,
  parseSeverityTier,
} from './fail-on';
import type { SeverityCounts } from './fail-on';
import { stampSchema } from './report-schema';
import {
  installHooks,
  installDevcontainer,
  installCiGuardrails,
  installCiBaselineRefresh,
  installCiDeepSastRefresh,
  installCiGraphRefresh,
  graphRefreshEnabled,
  installCiReportsRefresh,
  reportsRefreshEnabled,
  installPrReview,
  installIgnoreFiles,
  installHooksPostinstall,
  installDxkitDevDependency,
} from './ship-installers';
import type { ShipInstallResult } from './ship-installers';
import { dxkitCli, requiresResolvableCli } from './self-invocation';
import * as fs from 'fs';
import * as path from 'path';

// process.stdout.write returns false when the OS pipe buffer is full
// (typically 64KB on Linux). Without awaiting 'drain', the process exits
// and the tail of large payloads is silently lost on POSIX — manifests as
// 0-byte files when piping `--json` output through `cat > file` or similar.
// Tracked as D017.
async function emitJson(payload: unknown): Promise<void> {
  const data = JSON.stringify(payload, null, 2) + '\n';
  if (!process.stdout.write(data)) {
    await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
  }
}

/**
 * Build per-finding graph context for the detailed reports when the
 * run passed `--graph-context`. Fail-open: returns undefined when the
 * flag is off OR the graph can't be loaded, so detailed reports render
 * exactly as they do today. Logs a one-line coverage note so the user
 * sees how much of the report got enriched (and why, when it didn't).
 */
async function buildGraphContextIfRequested(
  enabled: boolean,
  cwd: string,
  locations: ReadonlyArray<{ file: string; line?: number }>,
) {
  if (!enabled) return undefined;
  const { buildFindingContextMap } = await import('./explore/finding-context');
  const gc = buildFindingContextMap(cwd, locations);
  if (!gc) {
    logger.dim('--graph-context: no graph.json found (run `health` first) — skipped.');
    return undefined;
  }
  const enriched = Object.keys(gc.contexts).length;
  logger.dim(`--graph-context: attached to ${enriched}/${locations.length} finding location(s).`);
  return gc;
}

async function buildAttributionIfRequested(
  enabled: boolean,
  cwd: string,
  locations: ReadonlyArray<{ file: string; line?: number }>,
) {
  if (!enabled) return undefined;
  const { buildAttributionMap } = await import('./attribution/attribute');
  const attr = buildAttributionMap(cwd, locations);
  if (!attr) {
    logger.dim('--attribute: no attributable locations (git blame produced nothing) — skipped.');
    return undefined;
  }
  const n = Object.keys(attr.attributions).length;
  logger.dim(`--attribute: "who to ask" attached to ${n}/${locations.length} finding location(s).`);
  return attr;
}

/**
 * Apply `--fail-on-score` to a higher-is-better score. Exits with
 * code 1 + a logged reason when the gate fires. Skips when the user
 * didn't pass the flag. Centralized so every analyzer that supports
 * the flag fires consistent messages.
 */
function applyFailOnScore(raw: string | undefined, score: number, scoreLabel: string): void {
  if (raw === undefined) return;
  const threshold = parseScoreThreshold(raw);
  if (threshold === null) {
    logger.fail(`--fail-on-score: invalid value "${raw}". Expected a number in [0, 100].`);
    process.exit(1);
  }
  const verdict = checkFailOnScore(score, threshold);
  if (verdict.fails) {
    logger.fail(`${scoreLabel} ${verdict.reason}`);
    process.exit(1);
  }
}

/**
 * Apply `--fail-on-severity` to a per-severity count map. Exits
 * with code 1 + a logged reason when the gate fires. Skips when
 * the user didn't pass the flag.
 */
function applyFailOnSeverity(
  raw: string | undefined,
  counts: SeverityCounts,
  countsLabel: string,
): void {
  if (raw === undefined) return;
  const tier = parseSeverityTier(raw);
  if (tier === null) {
    logger.fail(
      `--fail-on-severity: invalid tier "${raw}". Expected one of: critical, high, medium, low.`,
    );
    process.exit(1);
  }
  const verdict = checkFailOnSeverity(counts, tier);
  if (verdict.fails) {
    logger.fail(`${countsLabel}: ${verdict.reason}`);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
  ${logger.bold('vyuh-dxkit')} v${VERSION} — a deterministic stop condition + code-graph context layer for AI coding agents

  ${logger.bold('Commands:')}
${renderCommandIndex().join('\n')}
  ${logger.bold('Reference (flags & options):')}
    vyuh-dxkit init [options]    Install dxkit agent DX in this repo
    vyuh-dxkit update [options]  Re-generate (preserves evolved files)
    vyuh-dxkit uninstall [options]
                                 Remove dxkit, restoring the exact pre-dxkit state:
                                 delete files dxkit created + surgically revert its
                                 additive merges (.gitignore / CLAUDE.md / settings.json
                                 / package.json). Dry-run by default; --yes applies.
                                 [--keep-baselines] [--remove-devdep] [--force]
    vyuh-dxkit doctor            Verify setup
    vyuh-dxkit health [path]     Run deterministic health analysis
    vyuh-dxkit vulnerabilities [path]  Run deep security scan
    vyuh-dxkit test-gaps [path]  Analyze test coverage gaps
    vyuh-dxkit quality [path]    Code quality + slop detection
    vyuh-dxkit dev-report [path] Developer activity analysis
    vyuh-dxkit licenses [path]   Dependency license inventory
    vyuh-dxkit bom [path]        Bill of Materials (licenses + vulnerabilities joined)
    vyuh-dxkit coverage [path]   Run per-pack test-with-coverage (side-effecting; materializes the coverage artifact health/test-gaps read)
    vyuh-dxkit dashboard [path]  Render .dxkit/reports/ into a single HTML dashboard
    vyuh-dxkit report [path]     Run every analyzer + dashboard in one shot (full audit)
    vyuh-dxkit explore <sub>     Repo exploration via the graphify artifact
                                 (hot-files / entry-points / file / feature / communities / api-surface / context)
    vyuh-dxkit context <query>   Slim structural slice for a query — token-efficient
                                 codebase context for LLMs (--budget / --depth / --substring / --json)
    vyuh-dxkit reviewers [--base <ref>|--staged] [--limit N] [--json]
                                 Suggest reviewers for the change — active-owner model
                                 (recency-weighted git history, bots + departed devs
                                 filtered, excludes the author) blended with CODEOWNERS,
                                 with a bus-factor signal. Names + @handles, never emails.
    vyuh-dxkit to-xlsx <json>    Convert a dxkit JSON report to 15-col XLSX
    vyuh-dxkit tools [path]      Show required analysis tools status
    vyuh-dxkit tools install     Interactively install missing tools
    vyuh-dxkit baseline create [path] [--name <name>] [--force]
                               [--mode=<mode>] [--ref=<ref>]
                                 Capture per-finding identities to .dxkit/baselines/<name>.json
                                 (read later by guardrail check to gate new regressions).
                                 --mode=committed-full|committed-sanitized|ref-based picks
                                 the on-disk posture; default auto-selects from repo visibility.
    vyuh-dxkit baseline show [path] [--name <n>] [--baseline <path>]
                             [--kind <kind>] [--json]
                                 Pretty-print the on-disk baseline. Default: summary +
                                 per-kind counts. --kind drills into one kind. --json
                                 emits a schema-banner-wrapped payload.
    vyuh-dxkit guardrail check [path] [--name <n>] [--baseline <path>]
                               [--changed-only] [--incremental] [--untrusted]
                               [--policy <path>] [--mode=<mode>] [--ref=<ref>]
                               [--json | --markdown]
                                 Diff current scan against the named baseline; block on net-new
                                 regressions per brownfield policy. Exit code 1 when blocked.
                                 --mode/--ref mirror baseline create (override policy.json).
                                 --incremental scopes the scan to the change so the check scales
                                 with PR size, not repo size: it scopes semgrep to changed files
                                 (both sides in ref-based mode) AND, in ref-based mode, skips the
                                 dependency-vuln audit entirely when no dependency manifest changed
                                 (a net-new dep vuln requires one). Same verdict, much faster.
                                 Falls back to a full scan on any doubt.
                                 --untrusted treats the scanned source as attacker-controlled (a
                                 hosted PR gate): dependency audits never execute it (e.g. Python
                                 skips pip-audit project-build). Trusted local runs omit it.
    vyuh-dxkit hooks activate [path]
                                 Idempotently set core.hooksPath = .githooks. Wired into
                                 package.json postinstall by 'init --with-hooks' so every
                                 clone + 'npm install' activates the dxkit hooks
                                 automatically. Safe to run by hand; always exits 0.
    vyuh-dxkit allowlist add <file:line> --category=<cat> --reason=<text>
    vyuh-dxkit allowlist add --fingerprint=<id> --kind=<kind> --category=<cat>
                             --reason=<text> [--expires=<YYYY-MM-DD>]
                                 Suppress an individual finding with a typed category
                                 (false-positive / test-fixture / mitigated-externally /
                                 accepted-risk / deferred) and required reason. Inline
                                 form inserts a dxkit-allow: annotation; file-level
                                 form writes to .dxkit/allowlist.json.
    vyuh-dxkit allowlist list | show <fingerprint> | audit | prune [--dry-run] [--json]
                                 Review / audit / clean the allowlist. audit surfaces
                                 expired + soon-to-expire (within 14 days) + missing-
                                 rationale entries; add --against-baseline to also flag
                                 orphaned entries (match no current finding). prune
                                 removes expired entries.
    vyuh-dxkit allowlist remove <fingerprint>
                                 Delete one file-level allowlist entry by fingerprint.
                                 Use after a re-baseline orphans an entry whose finding
                                 is confirmed gone (see allowlist audit --against-baseline).
    vyuh-dxkit allowlist export --snyk [--out=<.snyk>]
                                 Write a .snyk policy file ignoring every Snyk-originated
                                 allowlisted finding, so the team's dxkit suppressions
                                 propagate to Snyk's own gate.
    vyuh-dxkit issue --type=<type> [--about=<text>] [--fingerprint=<id>] [--no-browser]
                                 Open a pre-filled GitHub Issue against vyuh-labs/dxkit.
                                 Types: false-positive, missing-finding, bug,
                                 feature-request, docs, uninstall. Nothing is submitted
                                 until you click "Submit" in your browser.

  ${logger.bold('Init options:')}
    --dx-only                 Just .claude/ + CLAUDE.md (default)
    --full                    Everything: DX + quality + hooks + devcontainer +
                              CI guardrails + baseline-refresh workflow
    --with-hooks              Install .githooks/pre-push guardrail hook (pre-commit opt-in)
    --with-precommit-hook     Also install .githooks/pre-commit (slow on large repos)
    --with-devcontainer       Install .devcontainer/ with pinned toolchains +
                              dxkit + Claude Code & Codex CLIs
    --with-dxkit-agents       Install AGENTS.md + CLAUDE.md shim + the 6 dxkit-
                              specific skills (learn/init/config/hooks/reports/
                              action) for Claude Code auto-discovery
    --with-ci                 Install .github/workflows/dxkit-guardrails.yml
                              (PR-gate that posts a markdown summary comment)
    --with-baseline-refresh   Install .github/workflows/dxkit-baseline-refresh.yml
    --with-deep-sast-refresh  Install .github/workflows/dxkit-deep-sast-refresh.yml (Snyk/CodeQL ingest; opt-in)
    --with-graph-refresh      Install .github/workflows/dxkit-graph-refresh.yml (rebuild + cache graph.json on merge; opt-in, sets policy graph.refresh)
    --with-reports-refresh    Install .github/workflows/dxkit-reports-refresh.yml (publish a health snapshot to the dxkit-reports ref on merge; opt-in, or enable via policy reports.onMerge)
    --with-pr-review          Install .github/workflows/pr-review.yml (AI PR review; opt-in)
                              (post-merge auto-regen of .dxkit/baselines/main.json)
    --claude-loop             Register the Stop-gate hook for autonomous coding
                              loops (additive: merges into .claude/settings.json +
                              CLAUDE.md, preserving your content). Implies dxkit skills.
    --loop-preset <p>         Loop blocking posture: security-only (default) or
                              full-debt. Only meaningful with --claude-loop.
    --flow                    Set up the UI→API integration gate (warn posture),
                              no prompt. Auto-offered interactively when init
                              detects a UI→API surface.
    --no-flow                 Skip flow setup even when a UI→API surface is detected.
    --detect                  Auto-detect stack, minimal prompts
    --yes                     Accept all defaults, no prompts
    --force                   Overwrite existing files (incl. existing hooks/
                              devcontainer instead of writing .dxkit sidecars)
    --stealth                 Gitignore generated files (local-only, not committed)
    --name <n>                Override project name
    --no-scan                 Skip codebase analysis

  ${logger.bold('Update options:')}
    --force      Overwrite modified files (except evolved)
    --rescan     Re-run codebase analysis

  ${logger.bold('Analyzer options (health, vulnerabilities, test-gaps, quality, dev-report, licenses, bom):')}
    --json            Print report as JSON to stdout (top-level 'schema' field
                      carries the dxkit.<kind>-report.v1 banner for version-gating)
    --verbose         Print per-tool timing to stderr
    --no-save         Skip writing the markdown report file
    --detailed        Also write <name>-detailed.md + .json with evidence + ranked actions
    --graph-context   Vulnerabilities/test-gaps/quality: attach per-finding graph context
                      (module + blast radius) to the detailed report. Needs a graph.json
                      (run health first); fail-open — skipped silently if absent.
    --attribute       Vulnerabilities/test-gaps/quality: attach a "who to ask" column to
                      the detailed report (git blame → active-owner model; inactive authors
                      routed to the current owner). Names + @handles, never emails. Opt-in;
                      fail-open. Historical only — net-new findings are introduced by your
                      own change.
    --xlsx            Licenses/bom: also write 15-col BOM XLSX
    --since           Dev-report: start date (YYYY-MM-DD)
    --filter          Bom: 'all' (default) or 'top-level' (keeps only root manifest deps;
                      advisory rollup under byTopLevelDep still reflects transitives)
    --with-coverage   Health/test-gaps: materialize coverage artifacts via per-pack
                      runTests() before analysis (line-coverage truth vs filename match)
    --fail-on-score <N>     Exit 1 when the analyzer's headline score drops below N.
                            Applies to: health (overallScore), test-gaps (effectiveCoverage).
    --fail-on-severity <tier>
                      Exit 1 when any finding at <tier> or higher exists.
                      tier ∈ critical|high|medium|low.
                      Applies to: vulnerabilities, bom.

  ${logger.bold('Examples:')}
    ${dxkitCli('init')}                  # Interactive
    ${dxkitCli('init --detect')}         # Auto-detect, just DX
    ${dxkitCli('init --full --yes')}     # Everything, no prompts
    ${dxkitCli('init --detect --stealth')}  # Local-only, not committed
    ${dxkitCli('update')}                # Re-generate from manifest
`);
}

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      'dx-only': { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      detect: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      force: { type: 'boolean', short: 'f', default: false },
      stealth: { type: 'boolean', default: false },
      name: { type: 'string' },
      'no-scan': { type: 'boolean', default: false },
      rescan: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      since: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      'no-save': { type: 'boolean', default: false },
      detailed: { type: 'boolean', default: false },
      output: { type: 'string', short: 'o' },
      xlsx: { type: 'boolean', default: false },
      filter: { type: 'string' },
      all: { type: 'boolean', default: false },
      frontend: { type: 'string' },
      backend: { type: 'string' },
      specs: { type: 'string' },
      'reports-dir': { type: 'string' },
      'json-dir': { type: 'string' },
      'project-name': { type: 'string' },
      lang: { type: 'string' },
      timeout: { type: 'string' },
      'no-fail-fast': { type: 'boolean', default: false },
      'with-coverage': { type: 'boolean', default: false },
      'changed-only': { type: 'boolean', default: false },
      incremental: { type: 'boolean', default: false },
      untrusted: { type: 'boolean', default: false },
      baseline: { type: 'string' },
      policy: { type: 'string' },
      markdown: { type: 'boolean', default: false },
      'fail-on-score': { type: 'string' },
      'fail-on-severity': { type: 'string' },
      summary: { type: 'boolean', default: false },
      kind: { type: 'string' },
      'with-hooks': { type: 'boolean', default: false },
      'with-precommit-hook': { type: 'boolean', default: false },
      'with-devcontainer': { type: 'boolean', default: false },
      'with-dxkit-agents': { type: 'boolean', default: false },
      'with-ci': { type: 'boolean', default: false },
      'with-baseline-refresh': { type: 'boolean', default: false },
      'with-ci-push-trigger': { type: 'boolean', default: false },
      'with-deep-sast-refresh': { type: 'boolean', default: false },
      'with-graph-refresh': { type: 'boolean', default: false },
      'with-reports-refresh': { type: 'boolean', default: false },
      'with-pr-review': { type: 'boolean', default: false },
      // loop pack: register the Stop-gate hook + CLAUDE.md loop norm
      'claude-loop': { type: 'boolean', default: false },
      'loop-preset': { type: 'string' },
      // flow setup (folded into init; no standalone `flow init`).
      // --flow forces it on (warn posture); --no-flow suppresses it.
      flow: { type: 'boolean', default: false },
      'no-flow': { type: 'boolean', default: false },
      // setup-branch-protection flags
      branch: { type: 'string' },
      'require-reviews': { type: 'string' },
      // `protect` applies changes only with --apply (dry-run by default)
      apply: { type: 'boolean', default: false },
      // setup-prebuild flags (branch reused above)
      regions: { type: 'string' },
      // upgrade flags
      target: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      plan: { type: 'boolean', default: false },
      // allowlist flags (allowlist add | list | show | audit | prune | remove | export)
      category: { type: 'string' },
      reason: { type: 'string' },
      fingerprint: { type: 'string' },
      expires: { type: 'string' },
      'acknowledged-severity': { type: 'string' },
      'added-by': { type: 'string' },
      mode: { type: 'string' },
      ref: { type: 'string' },
      surface: { type: 'string' },
      correctness: { type: 'boolean' },
      'no-correctness': { type: 'boolean' },
      'keep-baselines': { type: 'boolean', default: false },
      'remove-devdep': { type: 'boolean', default: false },
      'no-feedback': { type: 'boolean', default: false },
      'soon-days': { type: 'string' },
      'against-baseline': { type: 'boolean', default: false },
      'baseline-name': { type: 'string' },
      snyk: { type: 'boolean', default: false },
      out: { type: 'string' },
      // flow console flags: scope to a diff base + optionally skip the gate pass
      diff: { type: 'string' },
      'no-gate': { type: 'boolean', default: false },
      // issue flags
      type: { type: 'string' },
      about: { type: 'string' },
      'no-browser': { type: 'boolean', default: false },
      // explore flags
      limit: { type: 'string' },
      refresh: { type: 'boolean', default: false },
      // report snapshot flag: retain the most recent N history entries
      retain: { type: 'string' },
      substring: { type: 'boolean', default: false },
      // reviewers flags
      staged: { type: 'boolean', default: false },
      base: { type: 'string' },
      // context flags
      budget: { type: 'string' },
      depth: { type: 'string' },
      // graph-context enrichment for detailed reports (vuln/test-gaps/quality)
      'graph-context': { type: 'boolean', default: false },
      // attribution enrichment for detailed reports — "who to ask" (opt-in)
      attribute: { type: 'boolean', default: false },
      // ingest flags (external SAST engines → .dxkit/external snapshots)
      sarif: { type: 'string' },
      'from-snyk': { type: 'boolean', default: false },
      'snyk-cli': { type: 'boolean', default: false },
      codeql: { type: 'boolean', default: false },
      engine: { type: 'string' },
      org: { type: 'string' },
      project: { type: 'string' },
      // ingest: opt-in .env loading of SNYK_* creds
      'no-env-file': { type: 'boolean', default: false },
      'env-file': { type: 'string' },
      // baseline create: proceed despite missing scanners (CI/non-interactive)
      'allow-incomplete': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  if (values.version) {
    console.log(VERSION);
    return;
  }

  // Route logger output to stderr in --json mode so stdout stays pure JSON.
  logger.setJsonMode(!!values.json);

  const command = positionals[0] || 'init';
  const cwd = process.cwd();

  /**
   * Resolve a user-supplied repo path to an absolute one. Analyzers
   * propagate this value into child worker processes (Layer 2 parallel
   * cloc/gitleaks/graphify) that run from a different cwd, so a bare
   * "." would resolve against the child's cwd — yielding bogus scans
   * of dxkit's own dist/ output. Always absolutize at the boundary.
   */
  const resolveRepoPath = (raw?: string): string => path.resolve(raw || cwd);

  switch (command) {
    case 'init': {
      logger.header('vyuh-dxkit init');

      logger.info('Detecting stack...');
      const detected = detect(cwd);
      const langs = Object.entries(detected.languages)
        .filter(([, v]) => v)
        .map(([k]) => k);

      if (langs.length === 0) {
        logger.warn('No languages detected. Generating with minimal config.');
      } else {
        logger.success(`Languages: ${langs.join(', ')}`);
      }
      if (detected.framework) logger.success(`Framework: ${detected.framework}`);
      if (detected.testRunner)
        logger.success(`Tests: ${detected.testRunner.framework} (${detected.testRunner.command})`);
      console.log(''); // slop-ok

      const promptOpts = {
        yes: !!(values.yes || values.detect),
        detect: !!values.detect,
        name: values.name as string | undefined,
      };
      const promptResult = await promptForConfig(detected, promptOpts);
      const config = promptResult.config;

      const finalMode: GenerationMode = values.full
        ? 'full'
        : values['dx-only']
          ? 'dx-only'
          : promptResult.mode;
      // The six dxkit-* skills + AGENTS.md + CLAUDE.md shim are the
      // marquee 2.5.1 surface. Default-off on bare `init` (keep the
      // first-install quiet); default-on under `--full` (matches the
      // rest of the ship surface — hooks/devcontainer/CI all opt-in
      // via flags but bundled under --full).
      // --claude-loop implies the dxkit skills so the dxkit-loop skill (and
      // its siblings) land — the loop is most useful when the user can ask
      // Claude to explain a block / switch presets conversationally. --flow
      // does the same for the dxkit-flow skill: setting up the integration gate
      // is most useful when Claude can then diagnose + repair a break with it.
      const wantClaudeLoop = !!values['claude-loop'];
      const wantDxkitAgents =
        !!values.full || !!values['with-dxkit-agents'] || wantClaudeLoop || !!values.flow;
      const result = await generate(
        cwd,
        config,
        finalMode,
        !!values.force,
        !!values['no-scan'],
        wantDxkitAgents,
      );

      // Phase Ship installers (additive). `--full` implies every flag
      // so a one-command setup gets the full 2.5.0 ship surface.
      const isFull = !!values.full;
      // pre-commit hook stays opt-in even under --full because it
      // re-runs every analyzer on every commit (slow on large
      // codebases until incremental scanning lands). Pre-push +
      // CI catch the same regressions before code leaves the
      // developer's machine.
      const wantPrecommitHook = !!values['with-precommit-hook'];
      // --with-precommit-hook implies --with-hooks (so the
      // installer actually runs to install pre-commit alongside
      // pre-push).
      const wantHooks = isFull || !!values['with-hooks'] || wantPrecommitHook;
      const wantDevcontainer = isFull || !!values['with-devcontainer'];
      const wantCi = isFull || !!values['with-ci'];
      const wantBaselineRefresh = isFull || !!values['with-baseline-refresh'];
      const wantCiPushTrigger = !!values['with-ci-push-trigger'];
      // pr-review is opt-in even under --full because the workflow
      // is inert without `ANTHROPIC_API_KEY` + `ENABLE_AI_REVIEW=true`
      // configured separately. Shipping it by default just clutters
      // the Actions tab on repos that don't intend to enable it.
      const wantPrReview = !!values['with-pr-review'];

      const shipResults: { label: string; result: ShipInstallResult }[] = [];
      if (wantHooks) {
        shipResults.push({
          label: 'Git hooks',
          result: installHooks(cwd, {
            force: !!values.force,
            withPrecommit: wantPrecommitHook,
          }),
        });
        // Auto-activate hooksPath via package.json postinstall when a
        // package.json is present. No-ops for non-Node repos. Skipping
        // requires explicit user choice rather than a flag: customers
        // who don't want automation can delete the line from
        // scripts.postinstall after init.
        shipResults.push({
          label: 'Hooks auto-activation',
          result: installHooksPostinstall(cwd, { force: !!values.force }),
        });
      }
      if (wantDevcontainer) {
        shipResults.push({
          label: 'Devcontainer',
          result: installDevcontainer(cwd, { force: !!values.force }),
        });
      }
      if (wantCi) {
        shipResults.push({
          label: 'CI guardrails workflow',
          result: installCiGuardrails(cwd, {
            force: !!values.force,
            pushTrigger: wantCiPushTrigger,
          }),
        });
      }
      if (wantBaselineRefresh) {
        shipResults.push({
          label: 'CI baseline-refresh workflow',
          result: installCiBaselineRefresh(cwd, { force: !!values.force }),
        });
      }
      if (wantPrReview) {
        shipResults.push({
          label: 'AI PR-review workflow',
          result: installPrReview(cwd, { force: !!values.force }),
        });
      }
      // Loop pack (opt-in even under --full: it registers a Stop hook that
      // blocks the agent from stopping, which is intrusive enough to be an
      // explicit choice). Additive merge — preserves existing settings.json
      // hooks + CLAUDE.md content.
      if (wantClaudeLoop) {
        const { installClaudeLoop } = await import('./loop/scaffold');
        const rawPreset = values['loop-preset'];
        if (rawPreset !== undefined && rawPreset !== 'security-only' && rawPreset !== 'full-debt') {
          logger.fail(`Invalid --loop-preset: ${rawPreset}. Use security-only or full-debt.`);
          process.exit(1);
        }
        shipResults.push({
          label: 'Loop pack (Stop-gate)',
          result: installClaudeLoop(cwd, {
            preset: rawPreset as 'security-only' | 'full-debt' | undefined,
          }),
        });
      }
      // Opt-in even under --full: the workflow is inert without a
      // SNYK_TOKEN secret + deepSast config, so shipping it by default
      // just clutters the Actions tab (same rationale as pr-review).
      if (values['with-deep-sast-refresh']) {
        shipResults.push({
          label: 'CI deep-SAST refresh workflow',
          result: installCiDeepSastRefresh(cwd, { force: !!values.force }),
        });
      }
      // Graph-refresh (#119) — opt-in perf transport: rebuild + cache graph.json
      // on merge (Actions cache, never git). Enabled by the flag OR an existing
      // `.dxkit/policy.json:graph.refresh: "cache"`; off by default (it's an
      // optimization, not a gate, so it shouldn't clutter every CI install).
      if (values['with-graph-refresh'] || graphRefreshEnabled(cwd)) {
        shipResults.push({
          label: 'CI graph-refresh workflow',
          result: installCiGraphRefresh(cwd, { force: !!values.force }),
        });
      }
      // Report snapshots on merge — opt-in score-over-time transport: publish
      // a health snapshot to the dedicated `dxkit-reports` ref on merge (git
      // plumbing, never the default branch's tree). Enabled by the flag OR an
      // existing `.dxkit/policy.json:reports.onMerge: true`; off by default
      // (a trend feature, not a gate, so it shouldn't clutter every CI install).
      if (values['with-reports-refresh'] || reportsRefreshEnabled(cwd)) {
        shipResults.push({
          label: 'CI reports-refresh workflow',
          result: installCiReportsRefresh(cwd, { force: !!values.force }),
        });
      }

      // Flow setup — folded into `init` (there is no standalone `flow init`).
      // Detect a UI→API surface; if there is none, stay silent (zero burden on
      // a library / CLI / data repo). Otherwise prompt for the gate posture
      // (interactive, with a description of each) or take the gentle `warn`
      // default (--flow / --yes / non-TTY). --no-flow suppresses it entirely.
      if (!values['no-flow']) {
        const detection = await detectFlowTopology(cwd);
        if (detection.topology !== 'none') {
          // Non-TTY without an explicit answer can't prompt — fall to the
          // default rather than hang (mirrors how --yes is handled).
          const flowYes = promptOpts.yes || !process.stdin.isTTY;
          const decision = await promptFlowSetup(detection, {
            yes: flowYes,
            forceOn: !!values.flow,
            // Preserve a posture the user already evolved (a committed
            // `flow.mode: "block"`) instead of re-applying the gentle `warn`
            // default on this additive re-run.
            currentMode: existingFlowMode(cwd),
          });
          const written = applyFlowSetup(cwd, decision);
          shipResults.push({
            label: 'Flow integration gate',
            result: {
              installed: written,
              skipped: [],
              sidecars: [],
              notes: [
                `Flow gate posture: ${decision.mode} ` +
                  `(${detection.callCount} call(s) → ${detection.routeCount} route(s)). ` +
                  `Change it in .dxkit/policy.json:flow.mode.`,
              ],
            },
          });
        }
      }

      // dxkit must resolve project-locally so every installed self-invocation
      // surface (Stop hook, context-hook, pre-push + CI guardrail) can run a
      // pinned dxkit instead of 404-ing. The set of surfaces that imply this
      // is derived from the one registry in src/self-invocation.ts — never a
      // hand-maintained flag chain, which is what once dropped the loop Stop
      // hook. No-ops for non-Node repos and when the dep is already declared.
      if (
        requiresResolvableCli({
          claudeSettings: wantDxkitAgents,
          claudeLoop: wantClaudeLoop,
          gitHooks: wantHooks,
          ciGuardrails: wantCi,
        })
      ) {
        shipResults.push({
          label: 'dxkit devDependency',
          result: installDxkitDevDependency(cwd, { force: !!values.force }),
        });
      }

      // .gitignore + .dxkit-ignore seeding: default-on, no flag.
      // Additive (existing entries preserved); safe for both fresh
      // installs and re-runs.
      shipResults.push({
        label: 'Ignore files',
        result: installIgnoreFiles(cwd, { force: !!values.force }),
      });

      // Summary
      console.log('');
      logger.header('Summary');
      if (result.created.length) logger.success(`Created: ${result.created.length} files`);
      if (result.skipped.length)
        logger.warn(`Skipped: ${result.skipped.length} files (already exist)`);
      if (result.overwritten.length) logger.info(`Overwritten: ${result.overwritten.length} files`);

      for (const { label, result: r } of shipResults) {
        if (r.installed.length) {
          logger.success(`${label}: installed ${r.installed.length} file(s)`);
          for (const f of r.installed) logger.dim(`    ${f}`);
        }
        if (r.sidecars.length) {
          logger.warn(
            `${label}: ${r.sidecars.length} sidecar(s) written (existing files preserved)`,
          );
          for (const f of r.sidecars) logger.dim(`    ${f}`);
        }
        if (r.skipped.length) {
          logger.dim(`${label}: ${r.skipped.length} file(s) skipped (already present)`);
        }
        for (const note of r.notes) logger.info(note);
      }

      // Stamp the install-flag set into the manifest so `vyuh-dxkit
      // update` knows exactly which surfaces to refresh later instead
      // of re-deriving from the workspace. Single source of truth for
      // upgrade-time decisions.
      writeInstallFlags(cwd, {
        withDxkitAgents: wantDxkitAgents,
        withHooks: wantHooks,
        withPrecommit: wantPrecommitHook,
        withDevcontainer: wantDevcontainer,
        withCiGuardrails: wantCi,
        withBaselineRefresh: wantBaselineRefresh,
        withCiPushTrigger: wantCiPushTrigger,
        withPrReview: wantPrReview,
        withClaudeLoop: wantClaudeLoop,
        // Stamp the deep-SAST flag so `update` refreshes the workflow (it used
        // to have no flag → update never refreshed it) and uninstall removes it
        // by flag rather than only by presence.
        withDeepSastRefresh: !!values['with-deep-sast-refresh'],
        // #119: stamp the opt-in (flag or policy) so update refreshes the
        // graph-refresh workflow and uninstall removes it.
        withGraphRefresh: !!values['with-graph-refresh'] || graphRefreshEnabled(cwd),
        // Reports-refresh: stamp the opt-in (flag or reports.onMerge) so update
        // refreshes the dxkit-reports-refresh workflow and uninstall removes it.
        // Without this stamp the surface's flag gate never opens on a modern
        // manifest and update would silently skip it.
        withReportsRefresh: !!values['with-reports-refresh'] || reportsRefreshEnabled(cwd),
      });

      console.log('');
      logger.info('Manifest written to .vyuh-dxkit.json');

      // Stealth mode: gitignore only files we just created
      if (values.stealth) {
        enableStealthMode(cwd, result.created);
      }

      console.log('');
      logger.success('Done! Claude Code now has full project context.');

      // D150 fix: baseline-create is the most actionable next step
      // when ship surfaces (hooks / CI / etc.) landed — surface it
      // prominently rather than buried under a wall of dim hints.
      // Without a baseline, the hooks + CI workflows fail-fast on
      // every push ("no baseline found"), making the customer think
      // dxkit is broken right after they installed it.
      if (shipResults.length > 0) {
        console.log(''); // slop-ok
        // Sequence matters: `baseline create` refuses to write an incomplete
        // baseline when a scanner is missing (e.g. the coverage tool), so point
        // at `tools install` FIRST — otherwise the very next step init suggests
        // fails, right after install.
        logger.info(
          `Next: run \`${dxkitCli('tools install')}\`, then \`${dxkitCli('baseline create')}\` to capture today's state.`,
        );
        logger.dim('   (tools install provisions the scanners baseline needs; without a baseline,');
        logger.dim('    your pre-push hook + CI guardrail have nothing to diff against)');
      }

      console.log(''); // slop-ok
      logger.dim('  Other commands: `vyuh-dxkit doctor` (verify), `vyuh-dxkit update` (refresh),');
      logger.dim('    `vyuh-dxkit upgrade` (move to a newer dxkit version)');
      break;
    }

    case 'update': {
      await runUpdate(cwd, !!values.force, !!values.rescan);
      break;
    }

    case 'doctor': {
      await runDoctor(cwd, { json: !!values.json });
      break;
    }

    case 'capabilities': {
      const { runCapabilities } = await import('./discovery/capabilities-cli');
      runCapabilities(cwd, { json: !!values.json });
      break;
    }

    case 'checks': {
      const { runChecks } = await import('./checks-cli');
      // positionals[1] is the subcommand ('list' | 'run') when present; a bare
      // path (or nothing) defaults to 'list'. The path is whichever positional
      // isn't the subcommand.
      const isSub = positionals[1] === 'list' || positionals[1] === 'run';
      const sub = positionals[1] === 'run' ? 'run' : 'list';
      const target = resolveRepoPath(isSub ? positionals[2] : positionals[1]);
      runChecks(target, sub, { json: !!values.json });
      break;
    }

    case 'receipt': {
      const { runReceipt, receiptFailureHint } = await import('./receipt-cli');
      try {
        await runReceipt(resolveRepoPath(positionals[1]), {
          since: values.since as string | undefined,
          json: !!values.json,
          refresh: !!values.refresh,
        });
      } catch (err) {
        logger.fail(receiptFailureHint(err as Error));
        process.exit(1);
      }
      break;
    }

    case 'metrics': {
      const { runMetrics } = await import('./metrics-cli');
      await runMetrics(resolveRepoPath(positionals[1]), {
        since: values.since as string | undefined,
        json: !!values.json,
      });
      break;
    }

    case 'tests': {
      const sub = positionals[1];
      if (sub !== 'affected') {
        logger.fail(
          `Unknown tests subcommand: ${sub ?? '(missing)'}. ` +
            `Available: vyuh-dxkit tests affected [path] [--diff <ref>] [--json] [--refresh]`,
        );
        process.exit(1);
      }
      const { runTestsAffected } = await import('./tests-affected-cli');
      await runTestsAffected(resolveRepoPath(positionals[2]), {
        diff: values.diff as string | undefined,
        json: !!values.json,
        refresh: !!values.refresh,
      });
      break;
    }

    case 'configure': {
      const { runConfigure } = await import('./configure-cli');
      // `configure check` (positional subcommand) is the CI drift detector;
      // otherwise positionals[1] is a path. Plan-only by default (safe);
      // --apply writes the merge into policy.json.
      const isCheck = positionals[1] === 'check';
      runConfigure(resolveRepoPath(isCheck ? positionals[2] : positionals[1]), {
        check: isCheck,
        apply: !!values.apply,
        json: !!values.json,
      });
      break;
    }

    case 'health': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeHealthWithMetrics } = await import('./analyzers/health');
      logger.header('vyuh-dxkit health');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();

      // D021 (2.4.7): --with-coverage materializes the coverage artifact
      // BEFORE the analyzer runs, so the report reads line-coverage
      // truth (`coverageFidelity: 'line-coverage'`) instead of falling
      // back to the filename-match heuristic. Shares the same per-pack
      // runner the `coverage` command uses; honors --lang to limit
      // scope on polyglot repos.
      if (values['with-coverage']) {
        const { runCoverageAcrossPacks } = await import('./analyzers/coverage-runner');
        const langFilter = (values as Record<string, unknown>).lang as string | undefined;
        logger.info('Running test-with-coverage across active packs...');
        const { rows } = await runCoverageAcrossPacks(targetPath, {
          langFilter,
          failFast: !values['no-fail-fast'],
          onPackStart: (id) => process.stderr.write(`  → ${id}: running tests with coverage...\n`),
        });
        const successes = rows.filter((r) => r.status === 'success').length;
        if (successes > 0) {
          logger.success(`${successes}/${rows.length} packs produced coverage artifacts`);
        } else {
          logger.warn(
            `0/${rows.length} packs produced coverage artifacts — falling back to heuristic`,
          );
        }
        console.log(''); // slop-ok
      }

      // Detailed mode needs HealthMetrics for remediation planning; pull both.
      // D032 (2.4.7): always gather the underlying metrics so the
      // `-detailed.json` write below has the data it needs. Pre-fix
      // the metrics-bearing path was gated on `--detailed`, so the
      // dashboard's input JSON was only produced when the user opted
      // into detailed reporting — making the dashboard headline numbers
      // silently stale or zero on a default `dxkit health . && dxkit
      // dashboard .` workflow. Both internal entry points share
      // `analyzeHealthInternal`, so the only cost is keeping a metrics
      // reference live (no extra compute).
      const healthResult = await analyzeHealthWithMetrics(targetPath, {
        verbose: !!values.verbose,
      });
      const report = healthResult.report;
      const healthMetrics = healthResult.metrics;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        await emitJson(stampSchema(report, 'health'));
      } else {
        // Console output
        console.log('');
        console.log(
          `  ${logger.bold('Overall:')} ${report.summary.overallScore}/100 (Rating: ${report.summary.rating})`,
        );
        console.log('');
        const dims = report.dimensions;
        const order: Array<[string, typeof dims.testing]> = [
          ['Testing', dims.testing],
          ['Code Quality', dims.quality],
          ['Documentation', dims.documentation],
          ['Security', dims.security],
          ['Maintainability', dims.maintainability],
          ['Developer Experience', dims.developerExperience],
        ];
        for (const [name, dim] of order) {
          const bar =
            '█'.repeat(Math.round(dim.score / 5)) + '░'.repeat(20 - Math.round(dim.score / 5));
          console.log(
            `  ${name.padEnd(22)} ${bar} ${dim.score.toString().padStart(3)}/100  ${dim.rating}`,
          );
          const topAction = formatTopActionLine(dim);
          if (topAction) {
            logger.dim(`  ${' '.repeat(22)} → ${topAction}`);
          }
        }
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        if (report.toolsUnavailable.length > 0) {
          logger.dim('Unavailable: ' + report.toolsUnavailable.join(', '));
        }
        logger.dim(`Completed in ${elapsed}s`);
      }

      // Disk side: orthogonal to --json so consumers don't need separate
      // `--detailed` and `--detailed --json` invocations (closes D018).
      // `logger.success` routes to stderr in --json mode, so it's safe to
      // call unconditionally.
      if (!values['no-save']) {
        const reportDir = path.join(targetPath, '.dxkit', 'reports');
        const date = getReportDate();
        const reportPath = path.join(reportDir, `health-audit-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatMarkdownReport(report, elapsed));
        if (!values.json) console.log(''); // slop-ok
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

        // D032 (2.4.7): always write BOTH `-detailed.json` AND
        // `-detailed.md` so `vyuh-dxkit dashboard` finds fresh inputs
        // on every run. The dashboard reads JSON for tile metrics and
        // embeds the markdown for tab content (Language Breakdown +
        // Plans live only in the detailed.md). Pre-fix gating these
        // on `--detailed` meant a default `health → dashboard` workflow
        // showed stale tile values + stale tab content from whichever
        // run last passed `--detailed`. The `--detailed` flag now only
        // controls the console success-log lines.
        const { buildHealthDetailed, formatHealthDetailedMarkdown } =
          await import('./analyzers/health/detailed');
        const detailed = buildHealthDetailed(report, healthMetrics);
        const detailedJsonPath = path.join(reportDir, `health-audit-${date}-detailed.json`);
        const detailedMdPath = path.join(reportDir, `health-audit-${date}-detailed.md`);
        fs.writeFileSync(
          detailedJsonPath,
          JSON.stringify(stampSchema(detailed as object, 'health-detailed'), null, 2),
        );
        fs.writeFileSync(detailedMdPath, formatHealthDetailedMarkdown(detailed, elapsed));
        if (values.detailed) {
          logger.success(`Detailed report saved to ${path.relative(targetPath, detailedMdPath)}`);
          logger.success(`Detailed JSON saved to ${path.relative(targetPath, detailedJsonPath)}`);
        }
      }

      // --fail-on-score: applies to the overall health score. Runs
      // after disk writes so a failure still leaves a complete
      // report behind for inspection.
      applyFailOnScore(
        values['fail-on-score'] as string | undefined,
        report.summary.overallScore,
        'health overallScore',
      );

      if (!values.json) {
        // Hint about missing tools (exclude project-side config errors).
        const PROJECT_ISSUES = ['config error', 'legacy .eslintrc', 'no eslint config'];
        const trulyMissing = report.toolsUnavailable.filter(
          (t) => !PROJECT_ISSUES.some((p) => t.includes(p)),
        );
        if (trulyMissing.length > 0) {
          console.log('');
          logger.dim(
            '💡 Run `vyuh-dxkit tools install` to install missing tools for more accurate results.',
          );
        }
      }
      break;
    }

    case 'tools': {
      const subCommand = positionals[1];
      // For `tools install`, positionals[2] is overloaded: tool name
      // (cross-stack single-tool install) OR path (default behavior).
      // Disambiguate: if it's a known TOOL_DEFS key, treat as tool
      // name. If it's not a known tool name AND doesn't look like a
      // path (no slash, no dot-prefix, doesn't resolve to an existing
      // directory), fail loudly so typo'd tool names don't silently
      // fall through to a default install on a non-existent path.
      const { TOOL_DEFS } = await import('./analyzers/tools/tool-registry');
      const arg2 = positionals[2];
      const arg3 = positionals[3];
      let toolName: string | undefined;
      let pathArg: string | undefined;
      if (subCommand === 'install' && arg2) {
        if (TOOL_DEFS[arg2]) {
          toolName = arg2;
          pathArg = arg3;
        } else {
          const looksLikePath =
            arg2.includes('/') || arg2.startsWith('.') || fs.existsSync(path.resolve(cwd, arg2));
          if (!looksLikePath) {
            logger.fail(`Unknown tool: ${arg2}`);
            logger.info('Run `vyuh-dxkit tools list` to see available tools.');
            process.exit(1);
          }
          pathArg = arg2;
        }
      } else {
        pathArg = arg2;
      }
      const targetPath = resolveRepoPath(pathArg);
      const { runToolsCommand } = await import('./tools-cli');
      await runToolsCommand(targetPath, subCommand, !!values.yes, {
        toolName,
        all: !!values.all,
      });
      break;
    }

    case 'flow': {
      const subCommand = positionals[1];
      const frontend = values.frontend as string | undefined;
      const backend = values.backend as string | undefined;
      const specs = values.specs as string | undefined;

      // `flow` / `flow map` → the traceability map (writes the graph overlay).
      if (subCommand === undefined || subCommand === 'map') {
        const { runFlowMap } = await import('./flow-cli');
        await runFlowMap({ cwd, frontend, backend, specs, json: !!values.json });
        break;
      }
      // `flow trace "<METHOD> <path>"` → one endpoint's full trace.
      if (subCommand === 'trace') {
        const target = positionals.slice(2).join(' ').trim();
        if (!target) {
          logger.fail('Usage: vyuh-dxkit flow trace "<METHOD> <path>"');
          process.exit(1);
        }
        const { runFlowTrace } = await import('./flow-cli');
        await runFlowTrace({ cwd, frontend, backend, specs, json: !!values.json, target });
        break;
      }
      // `flow extract` → the parity CSVs.
      if (subCommand === 'extract') {
        const { runFlowExtract } = await import('./flow-cli');
        await runFlowExtract({
          cwd,
          frontend,
          backend,
          specs,
          out: values.out as string | undefined,
          json: !!values.json,
        });
        break;
      }
      // `flow console` → the interactive HTML console (map + request runner).
      // `--diff <ref>` scopes it to the change and marks net-new breaks.
      if (subCommand === 'console') {
        const { runFlowConsole } = await import('./flow-cli');
        await runFlowConsole({
          cwd,
          frontend,
          backend,
          specs,
          diff: values.diff as string | undefined,
          out: values.out as string | undefined,
          noGate: !!values['no-gate'],
          json: !!values.json,
        });
        break;
      }
      // `flow refresh` → write the served/consumed contract snapshots the
      // cross-repo integration gate reads.
      if (subCommand === 'refresh') {
        const { runFlowRefresh } = await import('./flow-cli');
        await runFlowRefresh({ cwd, frontend, backend, specs, json: !!values.json });
        break;
      }
      // `flow publish` → the multi-repo handshake: union every workspace
      // participant's served routes into this repo's served.json.
      if (subCommand === 'publish') {
        const { runFlowPublish } = await import('./flow-cli');
        await runFlowPublish({ cwd, frontend, backend, specs, json: !!values.json });
        break;
      }
      logger.fail(`Unknown flow subcommand: ${subCommand}`);
      logger.info('Usage:');
      logger.info('  vyuh-dxkit flow [map] [--frontend <dir>] [--backend <dir>] [--specs <a,b>]');
      logger.info('  vyuh-dxkit flow trace "<METHOD> <path>"');
      logger.info('  vyuh-dxkit flow extract [--out <dir>]');
      logger.info('  vyuh-dxkit flow console [--diff <ref>] [--out <file>] [--no-gate]');
      logger.info('  vyuh-dxkit flow refresh');
      logger.info('  vyuh-dxkit flow publish   (multi-repo: union participants’ served routes)');
      process.exit(1);
      break;
    }

    case 'vulnerabilities':
    case 'vuln': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeSecurity, formatSecurityReport } = await import('./analyzers/security');
      logger.header('vyuh-dxkit vulnerabilities');
      logger.info(`Scanning ${targetPath}...`);
      const startTime = Date.now();
      const report = await analyzeSecurity(targetPath, { verbose: !!values.verbose });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        await emitJson(stampSchema(report, 'vulnerabilities'));
      } else {
        const s = report.summary.findings;
        const d = report.summary.dependencies;
        console.log('');
        console.log(`  ${logger.bold('Code findings:')}`);
        console.log(
          `    CRITICAL: ${s.critical}  HIGH: ${s.high}  MEDIUM: ${s.medium}  LOW: ${s.low}  Total: ${s.total}`,
        );
        if (d.tool) {
          console.log(`  ${logger.bold('Dependency vulns:')}`);
          console.log(`    ${d.critical}C ${d.high}H ${d.medium}M ${d.low}L (${d.total} total)`);
        }
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        if (report.toolsUnavailable.length > 0) {
          logger.dim('Unavailable: ' + report.toolsUnavailable.join(', '));
        }
        logger.dim(`Completed in ${elapsed}s`);
      }

      // Disk side: orthogonal to --json (closes D018).
      if (!values['no-save']) {
        const reportDir = path.join(targetPath, '.dxkit', 'reports');
        const date = getReportDate();
        const reportPath = path.join(reportDir, `vulnerability-scan-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatSecurityReport(report, elapsed));
        if (!values.json) console.log(''); // slop-ok
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

        // D032 (2.4.7): detailed JSON + MD always written so dashboard finds fresh inputs.
        const { buildSecurityDetailed, formatSecurityDetailedMarkdown } =
          await import('./analyzers/security/detailed');
        const securityLocations = report.findings.map((f) => ({ file: f.file, line: f.line }));
        const graphContext = await buildGraphContextIfRequested(
          !!values['graph-context'],
          targetPath,
          securityLocations,
        );
        const securityAttribution = await buildAttributionIfRequested(
          !!values.attribute,
          targetPath,
          securityLocations,
        );
        const securityDetailed = buildSecurityDetailed(report, graphContext, securityAttribution);
        const securityDetailedJsonPath = path.join(
          reportDir,
          `vulnerability-scan-${date}-detailed.json`,
        );
        const securityDetailedMdPath = path.join(
          reportDir,
          `vulnerability-scan-${date}-detailed.md`,
        );
        fs.writeFileSync(
          securityDetailedJsonPath,
          JSON.stringify(
            stampSchema(securityDetailed as object, 'vulnerabilities-detailed'),
            null,
            2,
          ),
        );
        fs.writeFileSync(
          securityDetailedMdPath,
          formatSecurityDetailedMarkdown(securityDetailed, elapsed),
        );
        if (values.detailed) {
          logger.success(
            `Detailed report saved to ${path.relative(targetPath, securityDetailedMdPath)}`,
          );
          logger.success(
            `Detailed JSON saved to ${path.relative(targetPath, securityDetailedJsonPath)}`,
          );
        }
      }

      // --fail-on-severity: applies to both code findings and
      // dependency advisories. Code findings fire first because
      // they're typically actionable (a SAST hit you wrote);
      // dependency advisories second (transitive issue you may need
      // to triage).
      applyFailOnSeverity(
        values['fail-on-severity'] as string | undefined,
        report.summary.findings,
        'vulnerabilities (code)',
      );
      applyFailOnSeverity(
        values['fail-on-severity'] as string | undefined,
        report.summary.dependencies,
        'vulnerabilities (dependencies)',
      );
      break;
    }

    case 'test-gaps': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeTestGaps, formatTestGapsReport } = await import('./analyzers/tests');
      logger.header('vyuh-dxkit test-gaps');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();

      // D021 (2.4.7): --with-coverage materializes the coverage artifact
      // before analysis so the test-gaps report reads line-coverage
      // truth instead of falling back to filename-match. Same runner
      // health --with-coverage uses.
      if (values['with-coverage']) {
        const { runCoverageAcrossPacks } = await import('./analyzers/coverage-runner');
        const langFilter = (values as Record<string, unknown>).lang as string | undefined;
        logger.info('Running test-with-coverage across active packs...');
        const { rows } = await runCoverageAcrossPacks(targetPath, {
          langFilter,
          failFast: !values['no-fail-fast'],
          onPackStart: (id) => process.stderr.write(`  → ${id}: running tests with coverage...\n`),
        });
        const successes = rows.filter((r) => r.status === 'success').length;
        if (successes > 0) {
          logger.success(`${successes}/${rows.length} packs produced coverage artifacts`);
        } else {
          logger.warn(
            `0/${rows.length} packs produced coverage artifacts — falling back to heuristic`,
          );
        }
        console.log(''); // slop-ok
      }

      const report = await analyzeTestGaps(targetPath, { verbose: !!values.verbose });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        await emitJson(stampSchema(report, 'test-gaps'));
      } else {
        const s = report.summary;
        console.log('');
        console.log(`  ${logger.bold('Effective coverage:')} ${s.effectiveCoverage}%`);
        console.log(
          `  Test files: ${s.testFiles} (${s.activeTestFiles} active, ${s.commentedOutFiles} commented-out)`,
        );
        console.log(`  Source files: ${s.sourceFiles}`);
        console.log('');
        console.log(`  ${logger.bold('Untested by risk:')}`);
        console.log(
          `    CRITICAL: ${s.untestedCritical}  HIGH: ${s.untestedHigh}  MEDIUM: ${s.untestedMedium}  LOW: ${s.untestedLow}`,
        );
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        logger.dim(`Completed in ${elapsed}s`);
      }

      // Disk side: orthogonal to --json (closes D018).
      if (!values['no-save']) {
        const reportDir = path.join(targetPath, '.dxkit', 'reports');
        const date = getReportDate();
        const reportPath = path.join(reportDir, `test-gaps-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatTestGapsReport(report, elapsed));
        if (!values.json) console.log(''); // slop-ok
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

        // D032 (2.4.7): detailed JSON + MD always written so dashboard finds fresh inputs.
        const { buildTestGapsDetailed, formatTestGapsDetailedMarkdown } =
          await import('./analyzers/tests/detailed');
        const testGapsGraphContext = await buildGraphContextIfRequested(
          !!values['graph-context'],
          targetPath,
          report.gaps.map((g) => ({ file: g.path })),
        );
        const testGapsAttribution = await buildAttributionIfRequested(
          !!values.attribute,
          targetPath,
          report.gaps.map((g) => ({ file: g.path })),
        );
        const testGapsDetailed = buildTestGapsDetailed(
          report,
          testGapsGraphContext,
          testGapsAttribution,
        );
        const testGapsDetailedJsonPath = path.join(reportDir, `test-gaps-${date}-detailed.json`);
        const testGapsDetailedMdPath = path.join(reportDir, `test-gaps-${date}-detailed.md`);
        fs.writeFileSync(
          testGapsDetailedJsonPath,
          JSON.stringify(stampSchema(testGapsDetailed as object, 'test-gaps-detailed'), null, 2),
        );
        fs.writeFileSync(
          testGapsDetailedMdPath,
          formatTestGapsDetailedMarkdown(testGapsDetailed, elapsed),
        );
        if (values.detailed) {
          logger.success(
            `Detailed report saved to ${path.relative(targetPath, testGapsDetailedMdPath)}`,
          );
          logger.success(
            `Detailed JSON saved to ${path.relative(targetPath, testGapsDetailedJsonPath)}`,
          );
        }
      }

      // --fail-on-score: applies to the headline effectiveCoverage
      // percentage. Tests-gap reports use a higher-is-better
      // coverage scale, so the same threshold semantics work as
      // for the health overall score.
      applyFailOnScore(
        values['fail-on-score'] as string | undefined,
        report.summary.effectiveCoverage,
        'test-gaps effectiveCoverage',
      );
      break;
    }

    case 'quality': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeQuality, formatQualityReport } = await import('./analyzers/quality');
      logger.header('vyuh-dxkit quality');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      const report = await analyzeQuality(targetPath, {
        verbose: !!values.verbose,
        detailed: !!values.detailed,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        await emitJson(stampSchema(report, 'quality'));
      } else {
        const m = report.metrics;
        const slopLabel =
          report.slopScore >= 80
            ? 'clean'
            : report.slopScore >= 60
              ? 'fair'
              : report.slopScore >= 40
                ? 'messy'
                : 'sloppy';
        console.log('');
        console.log(`  ${logger.bold('Slop Score:')} ${report.slopScore}/100 (${slopLabel})`);
        console.log('');
        if (m.duplication) {
          console.log(
            `  Duplication:    ${m.duplication.percentage}% (${m.duplication.cloneCount} clones)`,
          );
        }
        if (m.commentRatio !== null) {
          console.log(`  Comment ratio:  ${(m.commentRatio * 100).toFixed(1)}%`);
        }
        console.log(`  Lint:           ${m.lintErrors} errors, ${m.lintWarnings} warnings`);
        console.log(`  TODO/FIXME/HACK: ${m.todoCount}/${m.fixmeCount}/${m.hackCount}`);
        console.log(`  Console stmts:  ${m.consoleLogCount}`);
        if (m.functionCount !== null) {
          console.log(
            `  Functions:      ${m.functionCount} (max ${m.maxFunctionsInFile} in one file)`,
          );
        }
        if (m.deadImportCount !== null) {
          console.log(`  Dead imports:   ${m.deadImportCount}`);
        }
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        if (report.toolsUnavailable.length > 0) {
          logger.dim('Unavailable: ' + report.toolsUnavailable.join(', '));
        }
        logger.dim(`Completed in ${elapsed}s`);
      }

      // Disk side: orthogonal to --json (closes D018).
      if (!values['no-save']) {
        const reportDir = path.join(targetPath, '.dxkit', 'reports');
        const date = getReportDate();
        const reportPath = path.join(reportDir, `quality-review-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatQualityReport(report, elapsed));
        if (!values.json) console.log(''); // slop-ok
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

        // D032 (2.4.7): detailed JSON + MD always written so dashboard finds fresh inputs.
        const { buildQualityDetailed, formatQualityDetailedMarkdown } =
          await import('./analyzers/quality/detailed');
        const qualityLocations = [
          ...(report.metrics.topConsoleFiles ?? []),
          ...(report.metrics.topTodoFiles ?? []),
        ].map((f) => ({ file: f.file }));
        const qualityGraphContext = await buildGraphContextIfRequested(
          !!values['graph-context'],
          targetPath,
          qualityLocations,
        );
        const qualityAttribution = await buildAttributionIfRequested(
          !!values.attribute,
          targetPath,
          qualityLocations,
        );
        const qualityDetailed = buildQualityDetailed(
          report,
          qualityGraphContext,
          qualityAttribution,
        );
        const qualityDetailedJsonPath = path.join(
          reportDir,
          `quality-review-${date}-detailed.json`,
        );
        const qualityDetailedMdPath = path.join(reportDir, `quality-review-${date}-detailed.md`);
        fs.writeFileSync(qualityDetailedJsonPath, JSON.stringify(qualityDetailed, null, 2));
        fs.writeFileSync(
          qualityDetailedMdPath,
          formatQualityDetailedMarkdown(qualityDetailed, elapsed),
        );
        if (values.detailed) {
          logger.success(
            `Detailed report saved to ${path.relative(targetPath, qualityDetailedMdPath)}`,
          );
          logger.success(
            `Detailed JSON saved to ${path.relative(targetPath, qualityDetailedJsonPath)}`,
          );
        }
      }
      break;
    }

    case 'dev-report': {
      const targetPath = resolveRepoPath(positionals[1]);
      const sinceFlag = (values as Record<string, unknown>).since as string | undefined;
      const { analyzeDevActivity, formatDevReport } = await import('./analyzers/developer');
      logger.header('vyuh-dxkit dev-report');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      const report = await analyzeDevActivity(targetPath, sinceFlag, {
        verbose: !!values.verbose,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        await emitJson(stampSchema(report, 'dev-report'));
      } else {
        const s = report.summary;
        console.log('');
        console.log(`  ${logger.bold('Period:')} ${report.period.since} to ${report.period.until}`);
        console.log(
          `  ${logger.bold('Commits:')} ${s.totalCommits} (${s.nonMergeCommits} non-merge, ${s.mergeCommits} merge)`,
        );
        console.log(`  ${logger.bold('Contributors:')} ${s.contributors}`);
        console.log(`  ${logger.bold('Merge ratio:')} ${(s.mergeRatio * 100).toFixed(1)}%`);
        console.log(
          `  ${logger.bold('Conventional commits:')} ${report.commitQuality.conventionalPercent}%`,
        );
        console.log('');
        if (report.hotFiles.length > 0) {
          console.log(`  ${logger.bold('Hot files:')}`);
          for (const f of report.hotFiles.slice(0, 5)) {
            console.log(`    ${f.changes.toString().padStart(3)} changes  ${f.path}`);
          }
        }
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        logger.dim(`Completed in ${elapsed}s`);
      }

      // Disk side: orthogonal to --json (closes D018).
      if (!values['no-save']) {
        const reportDir = path.join(targetPath, '.dxkit', 'reports');
        const date = getReportDate();
        const reportPath = path.join(reportDir, `developer-report-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatDevReport(report, elapsed));
        if (!values.json) console.log(''); // slop-ok
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

        // D032 (2.4.7): detailed JSON + MD always written so dashboard finds fresh inputs.
        const { buildDevDetailed, formatDevDetailedMarkdown } =
          await import('./analyzers/developer/detailed');
        const { gatherVagueCommitExamples } = await import('./analyzers/developer/gather');
        const sinceDate =
          sinceFlag || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const vague = gatherVagueCommitExamples(targetPath, sinceDate);
        const devDetailed = buildDevDetailed(report, vague);
        const devDetailedJsonPath = path.join(reportDir, `developer-report-${date}-detailed.json`);
        const devDetailedMdPath = path.join(reportDir, `developer-report-${date}-detailed.md`);
        fs.writeFileSync(devDetailedJsonPath, JSON.stringify(devDetailed, null, 2));
        fs.writeFileSync(devDetailedMdPath, formatDevDetailedMarkdown(devDetailed, elapsed));
        if (values.detailed) {
          logger.success(
            `Detailed report saved to ${path.relative(targetPath, devDetailedMdPath)}`,
          );
          logger.success(
            `Detailed JSON saved to ${path.relative(targetPath, devDetailedJsonPath)}`,
          );
        }
      }
      break;
    }

    case 'licenses': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeLicenses, formatLicensesReport } = await import('./analyzers/licenses');
      logger.header('vyuh-dxkit licenses');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      const report = await analyzeLicenses(targetPath, { verbose: !!values.verbose });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        await emitJson(stampSchema(report, 'licenses')); // slop-ok
      } else {
        const s = report.summary;
        console.log(''); // slop-ok
        console.log(`  ${logger.bold('Packages:')} ${s.totalPackages}`); // slop-ok
        const licCount = Object.keys(s.byLicense).length;
        console.log(`  ${logger.bold('License types:')} ${licCount} distinct`); // slop-ok
        if (s.unknownCount > 0) {
          console.log(`  ${logger.bold('Unknown license:')} ${s.unknownCount}`); // slop-ok
        }
        const top = Object.entries(s.byLicense)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        if (top.length > 0) {
          console.log(''); // slop-ok
          console.log(`  ${logger.bold('Top licenses:')}`); // slop-ok
          for (const [lic, count] of top) {
            console.log(`    ${count.toString().padStart(4)}  ${lic}`); // slop-ok
          }
        }
        console.log(''); // slop-ok
        logger.dim('Tools: ' + (report.toolsUsed.join(', ') || '(none)'));
        logger.dim(`Completed in ${elapsed}s`);
      }

      // Disk side: orthogonal to --json (closes D018).
      if (!values['no-save']) {
        const reportDir = path.join(targetPath, '.dxkit', 'reports');
        const date = getReportDate();
        const reportPath = path.join(reportDir, `licenses-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatLicensesReport(report, elapsed));
        if (!values.json) console.log(''); // slop-ok
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

        // D032 (2.4.7): detailed JSON + MD always written so dashboard finds fresh inputs.
        const { buildLicensesDetailed, formatLicensesDetailedMarkdown } =
          await import('./analyzers/licenses/detailed');
        const licensesDetailed = buildLicensesDetailed(report);
        const licensesDetailedJsonPath = path.join(reportDir, `licenses-${date}-detailed.json`);
        const licensesDetailedMdPath = path.join(reportDir, `licenses-${date}-detailed.md`);
        fs.writeFileSync(licensesDetailedJsonPath, JSON.stringify(licensesDetailed, null, 2));
        fs.writeFileSync(
          licensesDetailedMdPath,
          formatLicensesDetailedMarkdown(licensesDetailed, elapsed),
        );

        if (values.detailed) {
          logger.success(
            `Detailed report saved to ${path.relative(targetPath, licensesDetailedMdPath)}`,
          );
          logger.success(
            `Detailed JSON saved to ${path.relative(targetPath, licensesDetailedJsonPath)}`,
          );
        }

        if (values.xlsx) {
          const { toLicensesXlsx } = await import('./analyzers/xlsx');
          const xlsxPath = values.output
            ? path.resolve(values.output as string)
            : path.join(reportDir, `licenses-${date}.xlsx`);
          const buf = await toLicensesXlsx(licensesDetailed);
          fs.writeFileSync(xlsxPath, buf);
          logger.success(`XLSX saved to ${path.relative(targetPath, xlsxPath)}`);
        }
      }
      break;
    }

    case 'bom': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeBom, formatBomReport } = await import('./analyzers/bom');
      logger.header('vyuh-dxkit bom');
      logger.info(`Analyzing ${targetPath}...`);
      const rawFilter = values.filter;
      if (rawFilter !== undefined && rawFilter !== 'all' && rawFilter !== 'top-level') {
        logger.fail(`Invalid --filter value: ${rawFilter}. Expected 'all' or 'top-level'.`);
        process.exit(1);
      }
      const filter = rawFilter as 'all' | 'top-level' | undefined;
      const startTime = Date.now();
      const report = await analyzeBom(targetPath, {
        verbose: !!values.verbose,
        filter,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        await emitJson(stampSchema(report, 'bom')); // slop-ok
      } else {
        const s = report.summary;
        console.log(''); // slop-ok
        if (s.projectRoots.length > 1) {
          logger.info(
            `Aggregated across ${s.projectRoots.length} project roots: ${s.projectRoots.join(', ')}`,
          );
        }
        if (s.filter === 'top-level') {
          // prettier-ignore
          console.log(`  ${logger.bold('Packages indexed:')} ${s.totalPackages} of ${s.unfilteredTotalPackages} (filter=top-level)`); // slop-ok
        } else {
          console.log(`  ${logger.bold('Packages indexed:')} ${s.totalPackages}`); // slop-ok
        }
        console.log(
          // slop-ok
          `  ${logger.bold('Vulnerable packages:')} ${s.vulnerablePackages} ` +
            `(${s.totalAdvisories} advisories — vulnerabilities cmd counts those)`,
        );
        console.log(
          // slop-ok
          `  ${logger.bold('Actionable upgrades:')} ${s.actionableVulns} (Tier-1 proposals)`,
        );
        if (s.vulnOnlyPackages > 0) {
          console.log(
            // slop-ok
            `  ${logger.bold('License-scanner gap:')} ${s.vulnOnlyPackages} vuln-only entries`,
          );
        }
        if (s.vulnerablePackages > 0) {
          console.log(''); // slop-ok
          console.log(`  ${logger.bold('Severity (worst-of-package):')}`); // slop-ok
          console.log(
            // slop-ok
            `       ${s.bySeverity.critical} critical, ${s.bySeverity.high} high, ${s.bySeverity.medium} medium, ${s.bySeverity.low} low`,
          );
        }
        console.log(''); // slop-ok
        logger.dim('Tools: ' + (report.toolsUsed.join(', ') || '(none)'));
        logger.dim(`Completed in ${elapsed}s`);
      }

      // Disk side: orthogonal to --json (closes D018).
      if (!values['no-save']) {
        const reportDir = path.join(targetPath, '.dxkit', 'reports');
        const date = getReportDate();
        const reportPath = path.join(reportDir, `bom-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatBomReport(report, elapsed));
        if (!values.json) console.log(''); // slop-ok
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

        // D032 (2.4.7): detailed JSON + MD always written so dashboard finds fresh inputs.
        const { buildBomDetailed, formatBomDetailedMarkdown } =
          await import('./analyzers/bom/detailed');
        const bomDetailed = buildBomDetailed(report);
        const bomDetailedJsonPath = path.join(reportDir, `bom-${date}-detailed.json`);
        const bomDetailedMdPath = path.join(reportDir, `bom-${date}-detailed.md`);
        fs.writeFileSync(bomDetailedJsonPath, JSON.stringify(bomDetailed, null, 2));
        fs.writeFileSync(bomDetailedMdPath, formatBomDetailedMarkdown(bomDetailed, elapsed));

        if (values.detailed) {
          logger.success(
            `Detailed report saved to ${path.relative(targetPath, bomDetailedMdPath)}`,
          );
          logger.success(
            `Detailed JSON saved to ${path.relative(targetPath, bomDetailedJsonPath)}`,
          );
        }

        if (values.xlsx) {
          const { toBomXlsx } = await import('./analyzers/xlsx');
          const xlsxPath = values.output
            ? path.resolve(values.output as string)
            : path.join(reportDir, `bom-${date}.xlsx`);
          const buf = await toBomXlsx(report);
          fs.writeFileSync(xlsxPath, buf);
          logger.success(`XLSX saved to ${path.relative(targetPath, xlsxPath)}`);
        }
      }

      // --fail-on-severity: BomReport.summary.bySeverity carries
      // per-package max-severity counts. A package with multiple
      // advisories is counted once at its highest severity, which
      // is what a "block at this tier" gate wants — not double
      // counting.
      applyFailOnSeverity(
        values['fail-on-severity'] as string | undefined,
        report.summary.bySeverity,
        'bom severity',
      );
      break;
    }

    case 'dashboard': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeDashboard } = await import('./analyzers/dashboard');
      logger.header('vyuh-dxkit dashboard');

      const reportsDir = values['reports-dir']
        ? path.resolve(values['reports-dir'] as string)
        : path.join(targetPath, '.dxkit', 'reports');
      const jsonDir = values['json-dir'] ? path.resolve(values['json-dir'] as string) : undefined;
      const projectName = (values['project-name'] as string | undefined) ?? undefined;
      const outputPath = values.output
        ? path.resolve(values.output as string)
        : path.join(reportsDir, 'dashboard.html');

      let result;
      try {
        result = analyzeDashboard(targetPath, { reportsDir, jsonDir, projectName });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.fail(msg);
        process.exit(1);
      }

      if (result.reportCount === 0) {
        logger.fail(
          `No report markdowns found in ${path.relative(targetPath, reportsDir) || reportsDir}.\n` +
            `Run 'vyuh-dxkit health .' (or any other report command) first to populate the directory.`,
        );
        process.exit(1);
      }

      if (values['no-save']) {
        // Drain-aware HTML emission to stdout. Mirrors emitJson() for
        // payloads that can exceed the 64KB pipe buffer (a dashboard
        // with all reports embedded routinely runs 300-500KB).
        if (!process.stdout.write(result.html)) {
          await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
        }
      } else {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, result.html);
        logger.success(
          `Dashboard written to ${path.relative(targetPath, outputPath) || outputPath}`,
        );
        logger.dim(
          `${result.reportCount} reports · ${result.summary.healthScore !== null ? `health ${result.summary.healthScore}/100` : 'no health data'} · ` +
            `${result.summary.vulnCount} vulns · ${result.summary.gapCount} test gaps · ` +
            `${result.summary.advisoryCount} BoM advisories · ${result.criticalIssueCount} critical-issue tiles`,
        );
      }
      break;
    }

    case 'coverage': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { runCoverageAcrossPacks } = await import('./analyzers/coverage-runner');
      const { detectActiveLanguages } = await import('./languages');
      logger.header('vyuh-dxkit coverage');

      const active = detectActiveLanguages(targetPath);
      const langFilter = (values as Record<string, unknown>).lang as string | undefined;
      const failFast = !values['no-fail-fast'];

      const candidates = active.filter((p) => !langFilter || p.id === langFilter);
      if (candidates.length === 0) {
        logger.fail(
          langFilter
            ? `No active language pack matches --lang ${langFilter}. Active packs: ${active.map((p) => p.id).join(', ') || '(none)'}`
            : `No active language packs detected in ${targetPath}. Nothing to run.`,
        );
        process.exit(2);
      }

      logger.info(`Stack: ${candidates.map((p) => p.id).join(', ')}`);
      console.log(''); // slop-ok

      const { rows } = await runCoverageAcrossPacks(targetPath, {
        langFilter,
        failFast,
        onPackStart: (id) => process.stderr.write(`  → ${id}: running tests with coverage...\n`),
      });

      // Render summary table via the same drain-aware stdout primitive
      // emitJson uses — wide table rows would otherwise trip the
      // no-bare-console-statements slop gate.
      const writeRow = (s: string): void => {
        process.stdout.write(s + '\n');
      };
      writeRow('');
      writeRow(
        `  ${logger.bold('Pack'.padEnd(12))}  ${logger.bold('Status'.padEnd(12))}  ${logger.bold('Duration'.padEnd(10))}  ${logger.bold('Artifact')}`,
      );
      writeRow(`  ${'─'.repeat(12)}  ${'─'.repeat(12)}  ${'─'.repeat(10)}  ${'─'.repeat(40)}`);
      for (const r of rows) {
        const icon =
          r.status === 'success'
            ? '\x1b[32m✓\x1b[0m'
            : r.status === 'unavailable' || r.status === 'skipped'
              ? '\x1b[2m·\x1b[0m'
              : '\x1b[31m✗\x1b[0m';
        const duration =
          r.durationMs > 0 ? `${(r.durationMs / 1000).toFixed(1)}s`.padStart(10) : '—'.padStart(10);
        const right = r.artifact ?? r.reason ?? '';
        writeRow(`  ${icon} ${r.pack.padEnd(10)}  ${r.status.padEnd(12)}  ${duration}  ${right}`);
      }

      const successes = rows.filter((r) => r.status === 'success').length;
      const failures = rows.filter((r) => r.status === 'failed').length;
      const unavailable = rows.filter(
        (r) => r.status === 'unavailable' || r.status === 'skipped',
      ).length;

      console.log(''); // slop-ok
      if (failures > 0) {
        logger.fail(`${successes}/${rows.length} packs produced coverage. ${failures} failed.`);
        process.exit(1);
      } else if (successes === 0) {
        logger.fail(
          `0/${rows.length} packs produced coverage (${unavailable} unavailable / skipped).`,
        );
        process.exit(2);
      } else {
        logger.success(
          `${successes}/${rows.length} packs produced coverage. ` +
            `Run \`vyuh-dxkit health\` or \`vyuh-dxkit test-gaps\` to consume.`,
        );
      }
      break;
    }

    case 'report': {
      // Subcommands: `report snapshot` publishes a per-merge score snapshot to
      // the `dxkit-reports` anchor; `report history` reads the trend back. Both
      // dispatch to reports-cli; a bare `report` runs the full audit below.
      const reportSub = positionals[1];
      if (reportSub === 'snapshot' || reportSub === 'history') {
        const cwd = resolveRepoPath(positionals[2]);
        if (values.json) logger.setJsonMode(true);
        const { runReportSnapshot, runReportHistory } = await import('./reports-cli');
        const code =
          reportSub === 'snapshot'
            ? await runReportSnapshot({
                cwd,
                json: !!values.json,
                dryRun: !!values['dry-run'],
                ...(values.ref ? { anchorRef: String(values.ref) } : {}),
                ...(values.retain ? { retainHistory: Number(values.retain) } : {}),
              })
            : runReportHistory({
                cwd,
                json: !!values.json,
                ...(values.ref ? { anchorRef: String(values.ref) } : {}),
                ...(values.limit ? { limit: Number(values.limit) } : {}),
              });
        process.exit(code);
      }
      // D021 (2.4.7 sub-piece 3): single orchestrator that runs every
      // analyzer in sequence and produces a fully-populated dashboard.
      // Child-process model rather than direct function calls: each
      // analyzer command already owns its file-write flow (D032 made
      // the detailed JSON + MD unconditional), so spawning preserves
      // every side effect without duplicating code. The ~7 extra Node
      // startups add ~10-15s on top of 5-10 minutes of real analysis —
      // acceptable for a "press one button, get a complete audit"
      // command. Direct function refactoring is recipe-v4 candidate
      // territory (would touch every analyzer's CLI wiring).
      const targetPath = resolveRepoPath(positionals[1]);
      const { spawnSync } = await import('child_process');
      logger.header('vyuh-dxkit report');
      logger.info(`Generating full audit for ${targetPath}...`);
      console.log(''); // slop-ok

      // Which analyzers run, in dependency order. `health` runs first
      // so its detailed JSON exists when later commands or the
      // dashboard look for it; `dashboard` runs last so every report
      // it embeds is fresh.
      const analyzerSteps: Array<{
        label: string;
        cmd: string;
        extraFlags?: string[];
        /**
         * Basename prefix of the markdown report each step writes
         * to `.dxkit/reports/`. Post-step the orchestrator verifies
         * the file actually exists — a step that exits rc=0 without
         * writing its report is a silent failure (the dashboard
         * downstream falls back to "no <X> data" and the customer
         * never learns their report is missing). Asserting at the
         * orchestrator surface converts the silent failure into a
         * loud one with the exit-code path the final summary
         * already handles.
         */
        reportPrefix: string;
      }> = [
        { label: 'Health', cmd: 'health', reportPrefix: 'health-audit' },
        { label: 'Vulnerabilities', cmd: 'vulnerabilities', reportPrefix: 'vulnerability-scan' },
        { label: 'Test gaps', cmd: 'test-gaps', reportPrefix: 'test-gaps' },
        { label: 'Code quality', cmd: 'quality', reportPrefix: 'quality-review' },
        { label: 'Developer report', cmd: 'dev-report', reportPrefix: 'developer-report' },
        { label: 'BoM', cmd: 'bom', reportPrefix: 'bom' },
        { label: 'Licenses', cmd: 'licenses', reportPrefix: 'licenses' },
      ];

      // Forward common analyzer flags to each child so the orchestrator
      // honors the same options the user would pass to a single command.
      const passthroughFlags: string[] = [];
      if (values.detailed) passthroughFlags.push('--detailed');
      if (values.xlsx) passthroughFlags.push('--xlsx');
      if (values.verbose) passthroughFlags.push('--verbose');
      if (values.since) passthroughFlags.push('--since', values.since as string);
      if (values.filter) passthroughFlags.push('--filter', values.filter as string);
      if (values['no-nested']) passthroughFlags.push('--no-nested');

      // --with-coverage handled ONCE upfront via `vyuh-dxkit coverage`;
      // health + test-gaps then read the materialized artifact via
      // `loadCoverage()` without re-running the test suite per command.
      // Pre-fix `report --with-coverage` (had it existed) would have
      // double-run tests for health and again for test-gaps.
      const runStartedAt = Date.now();
      const stepDurations: Array<{ label: string; ms: number; rc: number }> = [];

      if (values['with-coverage']) {
        logger.info('[setup] Materializing coverage artifacts (one run, shared)...');
        const t0 = Date.now();
        const rc = spawnSync(
          process.execPath,
          [
            process.argv[1],
            'coverage',
            targetPath,
            ...(values['no-fail-fast'] ? ['--no-fail-fast'] : []),
          ],
          { stdio: 'inherit' },
        ).status;
        stepDurations.push({ label: 'Coverage', ms: Date.now() - t0, rc: rc ?? -1 });
        console.log(''); // slop-ok
      }

      const reportDir = path.join(targetPath, '.dxkit', 'reports');
      // Snapshot the date once at orchestrator startup so every
      // spawned subcommand writes filenames against the same date —
      // long runs crossing UTC midnight otherwise produce a mix of
      // pre- and post-midnight suffixes, and the post-step file-
      // existence checks below miss the rolled-forward files.
      const dateStr = getReportDate();
      const childEnv = { ...process.env, DXKIT_REPORT_DATE: dateStr };
      for (const step of analyzerSteps) {
        logger.info(`[${stepDurations.length + 1}/${analyzerSteps.length + 1}] ${step.label}...`);
        const t0 = Date.now();
        const rc = spawnSync(
          process.execPath,
          [process.argv[1], step.cmd, targetPath, ...passthroughFlags, ...(step.extraFlags ?? [])],
          { stdio: 'inherit', env: childEnv },
        ).status;
        let effectiveRc = rc ?? -1;
        // Post-step assertion: the child returned rc=0 BUT did the
        // expected markdown actually land on disk? On heavy polyglot
        // repos (a JS-heavy customer frontend; 13K+ graphify nodes,
        // jscpd timeout exhaustion) the health child was observed to silently exit
        // 0 without writing its markdown — the dashboard then renders
        // "no <X> data" and the customer never learns their report
        // is missing. The orchestrator owns the "did the report
        // actually ship" assertion; analyzer subcommands keep their
        // own write logic unchanged.
        if (effectiveRc === 0) {
          const expectedReport = path.join(reportDir, `${step.reportPrefix}-${dateStr}.md`);
          if (!fs.existsSync(expectedReport)) {
            logger.warn(
              `${step.label} returned exit 0 but did NOT write ${path.relative(targetPath, expectedReport)}. ` +
                `Treating as failure so the final summary surfaces it.`,
            );
            effectiveRc = -1;
          }
        }
        stepDurations.push({ label: step.label, ms: Date.now() - t0, rc: effectiveRc });
        // When the FIRST step (Health) fails, the AnalysisResult cache
        // didn't get built — every downstream step then re-runs the
        // full detect + Layer 0 + Layer 2 gather from scratch. On a
        // heavy polyglot frontend this added ~86 s of redundant Layer
        // 2 work to Step 2 (Vulnerabilities) alone, and ~10× that
        // across the remaining 6 steps. Surface the cascade so the
        // user understands why subsequent steps feel slower; the
        // alternative path (build the cache directly from the failed
        // gather) is a structural fix tracked for a later release.
        if (step.cmd === 'health' && effectiveRc !== 0) {
          logger.warn(
            'Health failed before the analysis cache could be built. ' +
              'The remaining steps will re-detect the stack and re-gather ' +
              'shared metrics from scratch (expect each to be measurably ' +
              'slower than usual). Their reports will still be written ' +
              'when they succeed individually.',
          );
        }
        console.log(''); // slop-ok
      }

      logger.info(`[${stepDurations.length + 1}/${analyzerSteps.length + 1}] Dashboard...`);
      const dashT0 = Date.now();
      const dashRc = spawnSync(process.execPath, [process.argv[1], 'dashboard', targetPath], {
        stdio: 'inherit',
        env: childEnv,
      }).status;
      stepDurations.push({ label: 'Dashboard', ms: Date.now() - dashT0, rc: dashRc ?? -1 });

      // Final summary. Always emit it so the user sees the dashboard
      // location without scrolling through per-step output.
      const totalElapsed = ((Date.now() - runStartedAt) / 1000).toFixed(1);
      const failed = stepDurations.filter((s) => s.rc !== 0);
      console.log(''); // slop-ok
      logger.dim('─'.repeat(60));
      for (const s of stepDurations) {
        const status = s.rc === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
        const duration = `${(s.ms / 1000).toFixed(1)}s`.padStart(8);
        process.stdout.write(`  ${status} ${s.label.padEnd(20)} ${duration}\n`);
      }
      logger.dim('─'.repeat(60));
      console.log(''); // slop-ok
      if (failed.length === 0) {
        logger.success(
          `All ${stepDurations.length} steps completed in ${totalElapsed}s. ` +
            `Open .dxkit/reports/dashboard.html for the full picture.`,
        );
      } else {
        logger.warn(
          `${stepDurations.length - failed.length}/${stepDurations.length} steps completed (${failed.length} failed: ${failed.map((s) => s.label).join(', ')}). ` +
            `Partial dashboard at .dxkit/reports/dashboard.html.`,
        );
        process.exit(1);
      }
      break;
    }

    case 'to-xlsx': {
      const inputArg = positionals[1];
      if (!inputArg) {
        console.error('Usage: vyuh-dxkit to-xlsx <json-file> [--output <file.xlsx>]'); // slop-ok
        process.exit(1);
      }
      const inputPath = path.resolve(inputArg);
      const outputPath = values.output
        ? path.resolve(values.output as string)
        : inputPath.replace(/\.json$/, '') + '.xlsx';

      logger.header('vyuh-dxkit to-xlsx');
      logger.info(`Reading ${path.relative(cwd, inputPath)}...`);

      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.fail(`Failed to read/parse input: ${msg}`);
        process.exit(1);
      }

      const { detectReportKind, toXlsx } = await import('./analyzers/xlsx');
      const kind = detectReportKind(json);
      if (kind === 'unknown') {
        logger.fail(
          'Unrecognised report shape. Supported inputs: licenses (vyuh-dxkit licenses --detailed) or bom (vyuh-dxkit bom --detailed).',
        );
        process.exit(1);
      }

      const startTime = Date.now();
      const buf = await toXlsx(json);
      fs.writeFileSync(outputPath, buf);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      logger.success(`Wrote ${path.relative(cwd, outputPath)} (${buf.length} bytes)`);
      logger.dim(`Converted in ${elapsed}s · report kind: ${kind}`);
      break;
    }

    case 'hooks': {
      const subCommand = positionals[1];
      if (subCommand === 'activate') {
        const targetPath = resolveRepoPath(positionals[2]);
        const { runHooksActivate } = await import('./hooks-cli');
        runHooksActivate(targetPath);
        break;
      }
      logger.fail(
        `Unknown hooks subcommand: ${subCommand ?? '(missing)'}. ` +
          `Available: vyuh-dxkit hooks activate [path]`,
      );
      process.exit(1);
      break;
    }

    case 'baseline': {
      const subCommand = positionals[1];
      if (subCommand === 'create') {
        const targetPath = resolveRepoPath(positionals[2]);
        const { createBaseline, gatherScanCoverage } = await import('./baseline/create');
        const { parseBaselineMode } = await import('./baseline/modes');
        const { missingScanners } = await import('./baseline/coverage');
        logger.header('vyuh-dxkit baseline create');

        // Pre-flight scanner check. A baseline captured with scanners
        // missing silently omits those finding categories — and the
        // developer has no way to tell an incomplete capture from a
        // clean one. Warn loudly; in an interactive shell offer to stop
        // and install first, and in CI refuse unless --allow-incomplete
        // makes the choice explicit.
        const missing = missingScanners(gatherScanCoverage(targetPath));
        if (missing.length > 0) {
          logger.warn(
            `${missing.length} scanner(s) not detected: ${missing.map((m) => m.tool).join(', ')}`,
          );
          logger.dim('  Findings in these categories will NOT be captured in the baseline.');
          logger.dim(
            '  Install with `' + dxkitCli('tools install') + '`, or if a tool IS installed but',
          );
          logger.dim(
            '  not detected, point dxkit at it via .dxkit/tools.json (ask Claude: "fix dxkit").',
          );
          // `--force` is an explicit "overwrite, non-interactive, I know
          // what I'm doing" signal — and the shipped baseline-refresh
          // workflow runs `baseline create --force` right after
          // `tools install`, so treating --force as opt-in keeps that
          // automation working across the 2.7.1 upgrade (the warning
          // still prints). `--yes` / `--allow-incomplete` are the
          // explicit opt-ins for non-forced runs.
          const proceedAnyway = !!values.force || !!values.yes || !!values['allow-incomplete'];
          const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
          if (!proceedAnyway && interactive) {
            const readline = await import('node:readline/promises');
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = (await rl.question('  Capture an INCOMPLETE baseline anyway? [y/N]: '))
              .trim()
              .toLowerCase();
            rl.close();
            if (!answer.startsWith('y')) {
              logger.info('Aborted. Install the missing scanners, then re-run `baseline create`.');
              process.exit(1);
            }
          } else if (!proceedAnyway) {
            logger.fail(
              'Refusing to write an incomplete baseline non-interactively. ' +
                'Re-run with --allow-incomplete to proceed, or install the missing scanners.',
            );
            process.exit(1);
          }
        }

        logger.info(`Capturing baseline for ${targetPath}...`);
        const startTime = Date.now();
        const cliModeRaw = values.mode as string | undefined;
        const cliMode = cliModeRaw !== undefined ? parseBaselineMode(cliModeRaw) : undefined;
        if (cliModeRaw !== undefined && cliMode === null) {
          logger.fail(
            `Unknown --mode value: ${cliModeRaw}. ` +
              `Expected one of: committed-full, committed-sanitized, ref-based.`,
          );
          process.exit(1);
        }
        try {
          const result = await createBaseline({
            cwd: targetPath,
            name: values.name as string | undefined,
            force: !!values.force,
            verbose: !!values.verbose,
            cliMode: cliMode ?? undefined,
            cliRef: values.ref as string | undefined,
          });
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          logger.info(`Baseline ${result.mode.explanation}`);
          if (result.mode.mode === 'ref-based') {
            logger.success(
              `Ref-based mode: no file written. Guardrail check will compare against ${result.mode.ref} on demand (${elapsed}s)`,
            );
          } else if (result.path && result.file) {
            const rel = path.relative(targetPath, result.path);
            const tag = result.mode.mode === 'committed-sanitized' ? ' (sanitized)' : '';
            logger.success(
              `Wrote ${rel}${tag} — ${result.file.findings.length} findings, salt: ${result.file.saltMode} (${elapsed}s)`,
            );
          }
        } catch (err) {
          logger.fail((err as Error).message);
          process.exit(1);
        }
        break;
      }
      if (subCommand === 'show') {
        const targetPath = resolveRepoPath(positionals[2]);
        const { DEFAULT_BASELINE_NAME, pathForBaseline, readBaselineFile } =
          await import('./baseline/baseline-file');
        const { parseKindFilter, renderSummary, renderKind, renderJson, FILTER_KINDS } =
          await import('./baseline/show');
        const name = (values.name as string | undefined) ?? DEFAULT_BASELINE_NAME;
        const filePath =
          (values.baseline as string | undefined) ?? pathForBaseline(targetPath, name);
        let file;
        try {
          file = readBaselineFile(filePath);
        } catch (err) {
          logger.fail((err as Error).message);
          process.exit(1);
        }
        // Optional kind filter. Validated up-front so a typo surfaces
        // a clear error rather than a silently-empty result.
        let kindFilter: ReturnType<typeof parseKindFilter> | undefined;
        if (values.kind !== undefined) {
          const parsed = parseKindFilter(values.kind as string);
          if (parsed === null) {
            logger.fail(
              `--kind: unknown value "${values.kind}". Expected one of: ${FILTER_KINDS.join(', ')}.`,
            );
            process.exit(1);
          }
          kindFilter = parsed;
        }
        if (values.json) {
          await emitJson(renderJson(file, kindFilter ? { kind: kindFilter } : {}));
        } else if (kindFilter) {
          process.stdout.write(renderKind(file, kindFilter) + '\n');
        } else {
          process.stdout.write(renderSummary(file) + '\n');
        }
        break;
      }
      logger.fail(
        `Unknown baseline subcommand: ${subCommand ?? '(missing)'}. ` +
          `Available: vyuh-dxkit baseline create [path] [--name <name>] [--force] · ` +
          `vyuh-dxkit baseline show [path] [--name <name>] [--baseline <path>] [--kind <kind>] [--json]`,
      );
      process.exit(1);
      break;
    }

    case 'guardrail': {
      const subCommand = positionals[1];
      if (subCommand !== 'check') {
        logger.fail(
          `Unknown guardrail subcommand: ${subCommand ?? '(missing)'}. ` +
            `Available: vyuh-dxkit guardrail check [path] [--name <n>] [--baseline <path>] ` +
            `[--changed-only] [--policy <path>] [--json | --markdown]`,
        );
        process.exit(1);
      }
      const targetPath = resolveRepoPath(positionals[2]);
      const { runGuardrailCheck } = await import('./baseline/check');
      const { renderConsole, renderJson, renderMarkdown, verdictCounts } =
        await import('./baseline/check-renderers');
      const { writeVerdict } = await import('./baseline/verdict-cache');
      const { parseBaselineMode } = await import('./baseline/modes');
      const cliModeRaw = values.mode as string | undefined;
      const cliMode = cliModeRaw !== undefined ? parseBaselineMode(cliModeRaw) : undefined;
      if (cliModeRaw !== undefined && cliMode === null) {
        logger.fail(
          `Unknown --mode value: ${cliModeRaw}. ` +
            `Expected one of: committed-full, committed-sanitized, ref-based.`,
        );
        process.exit(1);
      }
      // Suppress the console header/info in --json AND --markdown: both are
      // machine-captured (piped to a file / a PR comment), so the ANSI-styled
      // console chrome would leak into the report.
      const quiet = !!values.json || !!values.markdown;
      if (!quiet) logger.header('vyuh-dxkit guardrail check');
      if (!quiet) logger.info(`Checking ${targetPath} against baseline...`);
      const startTime = Date.now();
      try {
        const result = await runGuardrailCheck({
          cwd: targetPath,
          name: values.name as string | undefined,
          baselinePath: values.baseline as string | undefined,
          changedOnly: !!values['changed-only'],
          incremental: !!values.incremental,
          untrusted: !!values.untrusted,
          policyPath: values.policy as string | undefined,
          verbose: !!values.verbose,
          cliMode: cliMode ?? undefined,
          cliRef: values.ref as string | undefined,
        });
        if (!quiet) logger.info(`Baseline ${result.mode.explanation}`);
        // Cache the verdict so a same-tree replay (the `receipt` command, a
        // second gate this session) reuses it instead of re-gathering. Keyed on
        // a content-complete tree signature + policy hash, so a replay can never
        // hide a net-new finding. Best-effort — never breaks the check.
        {
          const counts = verdictCounts(result);
          writeVerdict(targetPath, result.policy, {
            blocks: result.blocks,
            warns: result.warns,
            blockingCount: counts.blocking,
            warningCount: counts.warning,
            markdown: renderMarkdown(result),
            ranAt: new Date().toISOString(),
          });
        }
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (values.json) {
          await emitJson(renderJson(result));
        } else if (values.markdown) {
          process.stdout.write(renderMarkdown(result) + '\n');
        } else {
          process.stdout.write(renderConsole(result) + '\n');
          logger.dim(`Completed in ${elapsed}s`);
        }
        process.exit(result.blocks ? 1 : 0);
      } catch (err) {
        logger.fail((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'uninstall': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { planUninstall, executeUninstall } = await import('./uninstall');
      const opts = {
        keepBaselines: !!values['keep-baselines'],
        removeDevDependency: !!values['remove-devdep'],
        force: !!values.force,
      };
      const plan = planUninstall(targetPath, opts);

      if (values.json) {
        await emitJson({ empty: plan.empty, warnings: plan.warnings, actions: plan.actions });
        process.exit(0);
      }

      logger.header('vyuh-dxkit uninstall');
      if (plan.empty) {
        logger.info('No dxkit footprint found in this repo — nothing to remove.');
        process.exit(0);
      }

      const active = plan.actions.filter((a) => a.status === 'pending');
      logger.info(`Will restore the pre-dxkit state by ${active.length} change(s):`);
      for (const a of active) {
        const verb = a.kind.startsWith('revert')
          ? 'revert'
          : a.kind === 'git-config-unset'
            ? 'unset'
            : 'remove';
        process.stdout.write(`  ${verb.padEnd(6)} ${a.target}  (${a.detail})\n`);
      }
      for (const w of plan.warnings) logger.warn(w);
      if (!opts.removeDevDependency) {
        logger.dim(
          '  (package.json @vyuhlabs/dxkit devDependency kept — pass --remove-devdep to remove it)',
        );
      }

      if (!values.yes) {
        logger.info('');
        logger.info(
          `Dry run — nothing changed. Re-run with ${dxkitCli('uninstall --yes')} to apply.`,
        );
        process.exit(0);
      }

      const result = executeUninstall(targetPath, plan, opts);
      logger.success(
        `Removed ${result.removed.length}, reverted ${result.reverted.length}` +
          (result.skipped.length
            ? `, skipped ${result.skipped.length} (edited — use --force)`
            : '') +
          '. dxkit has been uninstalled.',
      );

      // When we edited package.json (devDep removed), the lockfile is now stale.
      // Point the user at their PM's install so the prune completes. pnpm has an
      // extra wrinkle when a release-age policy pinned dxkit — see the skill.
      if (opts.removeDevDependency && result.reverted.includes('package.json')) {
        const { detectPackageManager, provisionCommand } = await import('./package-manager');
        const pm = detectPackageManager(targetPath);
        logger.info('');
        logger.info(
          `package.json changed — run \`${provisionCommand(pm)}\` to prune @vyuhlabs/dxkit from your lockfile.`,
        );
        if (pm === 'pnpm') {
          logger.dim(
            '  (pnpm + a release-age policy: keep any minimumReleaseAgeExclude for dxkit until AFTER this install prunes it, then remove it and install again.)',
          );
        }
      }

      // Optional, skippable feedback — a prefilled GitHub issue the user opens
      // themselves (no telemetry, no auto-submit).
      if (!values['no-feedback']) {
        const { buildIssueUrl, readDxkitVersion } = await import('./issue-cli');
        const url = buildIssueUrl({
          type: 'uninstall',
          about: '',
          dxkitVersion: readDxkitVersion(),
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
        });
        logger.info('');
        logger.info(
          'Mind sharing why? It genuinely helps. Open a prefilled issue (nothing is sent automatically):',
        );
        logger.dim(`  ${url}`);
        logger.dim('  (skip with --no-feedback)');
      }
      process.exit(0);
      break;
    }

    case 'floor': {
      const subCommand = positionals[1];
      if (subCommand !== 'check') {
        logger.fail(
          `Unknown floor subcommand: ${subCommand ?? '(missing)'}. ` +
            `Available: vyuh-dxkit floor check [path] [--surface pre-push|ci] [--base <ref>] ` +
            `[--correctness | --no-correctness] [--json]`,
        );
        process.exit(1);
      }
      const targetPath = resolveRepoPath(positionals[2]);
      const surfaceRaw = (values.surface as string | undefined) ?? 'pre-push';
      if (surfaceRaw !== 'pre-push' && surfaceRaw !== 'ci') {
        logger.fail(`Unknown --surface value: ${surfaceRaw}. Expected one of: pre-push, ci.`);
        process.exit(1);
      }
      // --correctness / --no-correctness → the explicit enable/disable override.
      const flag = values.correctness ? true : values['no-correctness'] ? false : undefined;
      const { runFloorForSurface } = await import('./analyzers/correctness/surface-run');
      const outcome = runFloorForSurface({
        surface: surfaceRaw,
        cwd: targetPath,
        base: values.base as string | undefined,
        flag,
      });
      if (values.json) {
        await emitJson({
          surface: outcome.surface,
          enabled: outcome.enabled,
          ran: outcome.ran,
          blocks: outcome.blocks,
          reason: outcome.reason,
          checks: outcome.result?.checks ?? [],
        });
      } else {
        if (outcome.blocks) {
          logger.fail(outcome.summary);
          for (const c of outcome.result?.checks.filter((c) => c.status === 'fail') ?? []) {
            if (c.output) process.stdout.write(`\n[${c.pack} ${c.label}]\n${c.output}\n`);
          }
        } else {
          logger.success(outcome.summary);
        }
      }
      process.exit(outcome.blocks ? 1 : 0);
      break;
    }

    case 'setup-branch-protection': {
      const { runSetupBranchProtection } = await import('./setup-branch-protection');
      const requireReviewsRaw = values['require-reviews'] as string | undefined;
      await runSetupBranchProtection(cwd, {
        branch: values.branch as string | undefined,
        requireReviews: requireReviewsRaw ? parseInt(requireReviewsRaw, 10) : undefined,
        force: !!values.force,
      });
      break;
    }

    case 'protect': {
      // Friendly alias for setup-branch-protection, dry-run by DEFAULT: dxkit
      // never silently writes a repo's settings. `--apply` / `--yes` applies.
      const { runSetupBranchProtection } = await import('./setup-branch-protection');
      const requireReviewsRaw = values['require-reviews'] as string | undefined;
      await runSetupBranchProtection(cwd, {
        branch: values.branch as string | undefined,
        requireReviews: requireReviewsRaw ? parseInt(requireReviewsRaw, 10) : undefined,
        force: !!values.force,
        dryRun: !(values.apply || values.yes),
      });
      break;
    }

    case 'setup-prebuild': {
      const { runSetupPrebuild } = await import('./setup-prebuild');
      await runSetupPrebuild(cwd, {
        branch: values.branch as string | undefined,
        regions: values.regions as string | undefined,
        force: !!values.force,
      });
      break;
    }

    case 'upgrade': {
      const { runUpgrade } = await import('./upgrade');
      await runUpgrade(cwd, {
        target: values.target as string | undefined,
        yes: !!values.yes,
        dryRun: !!values['dry-run'],
        planOnly: !!values.plan,
        json: !!values.json,
      });
      break;
    }

    case 'allowlist': {
      const { runAllowlist } = await import('./allowlist/cli');
      // positionals[1] = subcommand (add | list | show | audit | prune | remove | export)
      // positionals[2] = optional target (file:line for add; fingerprint for show / remove)
      await runAllowlist(cwd, positionals[1], {
        positionalAfter: positionals[2],
        values: values as Record<string, unknown>,
      });
      break;
    }

    case 'ingest': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { runIngest } = await import('./ingest-cli');
      const { execSync } = await import('child_process');
      let commitSha: string | undefined;
      try {
        commitSha = execSync('git rev-parse HEAD', {
          cwd: targetPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
      } catch {
        commitSha = undefined;
      }
      await runIngest(targetPath, {
        sarif: values.sarif as string | undefined,
        fromSnyk: !!values['from-snyk'],
        snykCli: !!values['snyk-cli'],
        codeql: !!values.codeql,
        engine: values.engine as string | undefined,
        org: values.org as string | undefined,
        project: values.project as string | undefined,
        noEnvFile: !!values['no-env-file'],
        envFile: values['env-file'] as string | undefined,
        generatedAt: new Date().toISOString(),
        commitSha,
      });
      break;
    }

    case 'issue': {
      const { runIssueSubmit } = await import('./issue-cli');
      await runIssueSubmit(cwd, {
        type: values.type as string | undefined,
        fingerprint: values.fingerprint as string | undefined,
        about: values.about as string | undefined,
        noBrowser: !!values['no-browser'],
      });
      break;
    }

    case 'reviewers': {
      const { runReviewers } = await import('./reviewers-cli');
      const limitRaw = values.limit as string | undefined;
      const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
      runReviewers(cwd, {
        base: values.base as string | undefined,
        staged: !!values.staged,
        json: !!values.json,
        ...(Number.isFinite(limit) ? { limit } : {}),
      });
      break;
    }

    case 'explore': {
      const { runExplore } = await import('./explore-cli');
      // positionals[0] is 'explore'; positionals[1..] are the
      // explore subcommand name + any subcommand args.
      await runExplore(cwd, positionals.slice(1), {
        json: !!values.json,
        limit: values.limit as string | undefined,
        refresh: !!values.refresh,
        substring: !!values.substring,
        filter: values.filter as string | undefined,
        budget: values.budget as string | undefined,
        depth: values.depth as string | undefined,
      });
      break;
    }

    case 'context': {
      // Top-level alias for `explore context` — the token-reduction
      // surface gets first-class billing. positionals[0] is 'context';
      // positionals[1..] are the query + args. Routes through the
      // explore dispatcher so graph loading + --refresh are shared.
      const { runExplore } = await import('./explore-cli');
      await runExplore(cwd, ['context', ...positionals.slice(1)], {
        json: !!values.json,
        refresh: !!values.refresh,
        substring: !!values.substring,
        budget: values.budget as string | undefined,
        depth: values.depth as string | undefined,
      });
      break;
    }

    case 'context-hook': {
      // Internal — the Claude Code PreToolUse hook body. Reads the tool
      // call on stdin, injects a slim graph subgraph as additionalContext.
      // Fail-open: never blocks the tool, silent no-op on any problem.
      const { runContextHook } = await import('./explore/context-hook');
      await runContextHook(cwd);
      break;
    }

    case 'hook': {
      // Claude Code lifecycle-hook bodies for the loop pack.
      // positionals[1] = hook name (stop-gate | ...).
      const hookName = positionals[1];
      if (hookName === 'stop-gate') {
        const { runStopGate } = await import('./loop/stop-gate');
        await runStopGate(cwd);
        break;
      }
      logger.fail(`Unknown hook: ${hookName ?? '(missing)'}. Available: vyuh-dxkit hook stop-gate`);
      process.exit(1);
      break;
    }

    case 'loop': {
      // Loop-pack utilities. positionals[1] = subcommand (ledger | ...).
      const sub = positionals[1];
      if (sub === 'ledger') {
        const { runLoopLedger } = await import('./loop/ledger-cli');
        // positionals[2] = ledger action (show | summarize | clear); default show.
        await runLoopLedger(cwd, positionals[2], {
          json: !!values.json,
          limit: values.limit as string | undefined,
        });
        break;
      }
      if (sub === 'doctor') {
        const { runLoopDoctor } = await import('./loop/doctor');
        await runLoopDoctor(cwd, { json: !!values.json });
        break;
      }
      if (sub === 'snapshot') {
        // Capture the correctness-floor entry snapshot — the already-broken set
        // on the current (pristine) tree — so later Stops block only on
        // NET-NEW failures. Run at loop activation, before the agent changes
        // anything, or the recorded set won't be genuinely pre-existing.
        const { captureFloorSnapshot } = await import('./loop/floor-gate');
        const { describeCorrectnessFloor } = await import('./analyzers/correctness/run');
        const result = captureFloorSnapshot(cwd);
        if (result === null) {
          logger.info(
            'No active language pack provides a correctness floor — nothing to snapshot.',
          );
          break;
        }
        const failing = result.checks.filter((c) => c.status === 'fail').length;
        logger.success(
          `Captured correctness-floor entry snapshot (${result.checks.length} check(s), ` +
            `${failing} already failing). ${describeCorrectnessFloor(result)}`,
        );
        break;
      }
      logger.fail(
        `Unknown loop subcommand: ${sub ?? '(missing)'}. ` +
          `Available: vyuh-dxkit loop ledger [show | summarize | clear], ` +
          `vyuh-dxkit loop doctor, vyuh-dxkit loop snapshot`,
      );
      process.exit(1);
      break;
    }

    case 'demo': {
      // No-API, offline demonstrations. positionals[1] = demo name; bare
      // `demo` defaults to the flagship loop-guardrail walkthrough so the
      // launch command is as forgiving as possible.
      const which = positionals[1];
      if (which === undefined || which === 'loop-guardrail') {
        const { runLoopGuardrailDemo } = await import('./loop/demo');
        await runLoopGuardrailDemo();
        break;
      }
      logger.fail(`Unknown demo: ${which}. Available: vyuh-dxkit demo loop-guardrail`);
      process.exit(1);
      break;
    }

    default: {
      /* slop-ok */ console.error(`Unknown command: ${command}`);
      const near = suggestCommand(command);
      if (near.length > 0) {
        /* slop-ok */ console.error(`Did you mean: ${near.join(', ')}?`);
      }
      /* slop-ok */ console.error('');
      /* slop-ok */ console.error('Available commands:');
      for (const line of renderCommandIndex()) /* slop-ok */ console.error(line);
      /* slop-ok */ console.error("Run 'vyuh-dxkit --help' for full usage and options.");
      process.exit(1);
    }
  }
}

function formatMarkdownReport(
  report: import('./analyzers/types').HealthReport,
  elapsed: string,
): string {
  const lines: string[] = [];
  lines.push('# Codebase Health Audit');
  lines.push('');
  lines.push(`**Date:** ${report.analyzedAt.slice(0, 10)}`);
  lines.push(`**Repository:** ${report.repo}`);
  lines.push(`**Branch:** ${report.branch}`);
  lines.push(`**Commit:** ${report.commitSha}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `## Overall Health Score: ${report.summary.overallScore}/100 (Rating: ${report.summary.rating})`,
  );
  lines.push('');
  lines.push('| Dimension | Score | Status |');
  lines.push('|---|---|---|');

  const dimNames: Record<string, string> = {
    testing: 'Tests',
    quality: 'Code Quality',
    documentation: 'Documentation',
    security: 'Security',
    maintainability: 'Maintainability',
    developerExperience: 'Developer Experience (DX)',
  };

  for (const [key, dim] of Object.entries(report.dimensions)) {
    const name = dimNames[key] || key;
    lines.push(`| ${name} | ${dim.score}/100 | ${dim.rating} |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // Dimension details
  for (const [key, dim] of Object.entries(report.dimensions)) {
    const name = dimNames[key] || key;
    lines.push(`## ${name} (${dim.score}/100) -- ${dim.rating}`);
    lines.push('');
    lines.push(dim.details);
    lines.push('');
    const topActions = formatTopActionsBlock(dim);
    for (const line of topActions) lines.push(line);
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    for (const [mk, mv] of Object.entries(dim.metrics)) {
      if (mv !== null && mv !== undefined) {
        lines.push(`| ${mk} | ${mv} |`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // 2.4.7: top-N largest files. Surfaces the file-size distribution
  // beyond the single "largest" callout in the Code Quality /
  // Maintainability dimensions. Skipped when the array is empty
  // (no source files counted or autogen excluded everything).
  if (report.largestFiles && report.largestFiles.length > 0) {
    lines.push('## Top Files by Size');
    lines.push('');
    lines.push('| Rank | File | Lines |');
    lines.push('|-----:|------|------:|');
    // Top 10 is the render contract — the underlying metric carries
    // every file over the threshold (consumed by the baseline producer).
    report.largestFiles.slice(0, 10).forEach((f, i) => {
      lines.push(`| ${i + 1} | \`${f.path}\` | ${f.lines.toLocaleString()} |`);
    });
    lines.push('');

    // Advisory: when largest-files contain paths matching a known
    // vendored-code convention not already in the customer's
    // exclusion chain, surface a single tip pointing at the
    // `.dxkit-ignore` escape hatch. Bundled defaults already cover
    // `vendor/`, `third_party/`, `playground/`, `lexical-playground/`,
    // etc.; the remaining cases (most commonly `/libs/`) live in
    // customer-specific paths that can't be defaulted-away without
    // false-positives on first-party monorepo layouts.
    // Scope the vendored advisor to the rendered top 10 — the tip
    // calls out files the user can see in the table above.
    const suspects = suspectVendoredEntries(report.largestFiles.slice(0, 10));
    if (suspects.length > 0) {
      lines.push(
        `> **Tip — possibly vendored:** ${suspects
          .map((s) => `\`${s.path}\``)
          .join(
            ', ',
          )} match path conventions for external / vendored code. If these aren't authored by your team, add them (or their parent directory) to \`.dxkit-ignore\` to keep largest-files, Maintainability scoring, and the densest-file metric focused on first-party code.`,
      );
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Score calculation table
  lines.push('## Score Calculation');
  lines.push('');
  lines.push('| Dimension | Weight | Score | Weighted |');
  lines.push('|---|---|---|---|');

  const weights: Record<string, number> = {
    testing: 0.25,
    quality: 0.2,
    documentation: 0.1,
    security: 0.2,
    maintainability: 0.1,
    developerExperience: 0.15,
  };

  for (const [key, dim] of Object.entries(report.dimensions)) {
    const name = dimNames[key] || key;
    const w = weights[key] || 0;
    lines.push(
      `| ${name} | ${(w * 100).toFixed(0)}% | ${dim.score} | ${(dim.score * w).toFixed(2)} |`,
    );
  }
  lines.push(`| **Overall** | **100%** | | **${report.summary.overallScore}** |`);
  lines.push('');

  // Footer
  lines.push('---');
  lines.push('');
  // Drop languages that round to 0% — a single .py file alongside a
  // 300K-LOC C# codebase shouldn't surface as "Python (0%)" in the
  // header. Filter at the renderer rather than the detector so the
  // raw HealthReport.languages still carries everything for
  // programmatic consumers.
  const visibleLanguages = report.languages.filter((l) => l.percentage >= 1);
  if (visibleLanguages.length > 0) {
    lines.push(
      '**Languages:** ' + visibleLanguages.map((l) => `${l.name} (${l.percentage}%)`).join(', '),
    );
    lines.push('');
  }
  lines.push(`**Tools used:** ${report.toolsUsed.join(', ')}`);
  lines.push(...renderToolsUnavailableLines(report.toolsUnavailable));
  lines.push(`**Analysis time:** ${elapsed}s`);
  lines.push('');
  lines.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');

  return lines.join('\n');
}

const STEALTH_HEADER = '# dxkit (stealth mode — local only, not committed)';

/**
 * Add only files created in this run to .gitignore.
 * Collapses directory files into directory entries.
 */
function enableStealthMode(cwd: string, createdFiles: string[]): void {
  const gitignorePath = path.join(cwd, '.gitignore');

  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
    if (existing.includes(STEALTH_HEADER)) {
      logger.warn('.gitignore already has dxkit stealth entries');
      return;
    }
  }

  // Collapse into top-level directories where possible
  const dirs = new Set<string>();
  const files: string[] = [];

  for (const f of createdFiles) {
    const topDir = f.split('/')[0];
    if (f.includes('/') && topDir.startsWith('.')) {
      dirs.add(topDir + '/');
    } else {
      files.push(f);
    }
  }
  // Always include the manifest + the runtime analyzer-output dir.
  // `.dxkit/` isn't in `createdFiles` (generator.ts only emits
  // scaffolded files; `.dxkit/reports/*.md` shows up later when the
  // user actually runs an analyzer) — adding it preemptively means
  // stealth mode doesn't need a second pass after the first scan.
  files.push('.vyuh-dxkit.json');
  dirs.add('.dxkit/');

  // Dedupe against existing .gitignore
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  const newEntries: string[] = [];

  for (const d of dirs) {
    if (!existingLines.has(d)) newEntries.push(d);
  }
  for (const f of files) {
    if (!existingLines.has(f)) newEntries.push(f);
  }

  if (newEntries.length === 0) {
    logger.warn('.gitignore already covers generated files');
    return;
  }

  const block = '\n' + STEALTH_HEADER + '\n' + newEntries.join('\n') + '\n';
  fs.appendFileSync(gitignorePath, block, 'utf-8');
  logger.success(
    `.gitignore updated — ${newEntries.length} generated path${newEntries.length !== 1 ? 's' : ''} added (stealth mode)`,
  );
}
