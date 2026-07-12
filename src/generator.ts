import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig, GenerationMode, Manifest } from './types';
import { buildVariables, buildConditions, VERSION } from './constants';
import { processTemplate } from './template-engine';
import { sha256 } from './files';
import { activeLanguagesFromStack } from './languages';
import { dxkitCli, claudeHookCommand } from './self-invocation';
import { decideUpdateDisposition } from './update-disposition';
import * as logger from './logger';

/**
 * Files the user extends rather than owns outright — a full template overwrite
 * always destroys their additions (a Stop hook in settings.json, project prose
 * in CLAUDE.md / AGENTS.md). Update refreshes these only while unmodified;
 * once user-edited they are preserved even under --force.
 */
const USER_MERGE_TARGETS = new Set(['.claude/settings.json', 'CLAUDE.md', 'AGENTS.md']);

function getTemplatesDir(): string {
  return path.join(__dirname, '..', 'templates');
}

function readTemplate(templatePath: string): string {
  const fullPath = path.join(getTemplatesDir(), templatePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

/**
 * Narrowed permission list for the dxkit-specific agent surface.
 * Carries only the binaries the six dxkit-* skills actually run:
 * git status/diff/log/branch (read-only inspection), the dxkit binary
 * itself (every analyzer / hook / baseline command), and the active
 * language packs' contributed commands (so the dxkit-action skill
 * can run `npm test` / `pytest` / etc. to verify a fix without
 * prompting on every step).
 *
 * Pre-2.5.1 the file carried Stop-hook noise about a `/learn` slash
 * command that no longer ships, plus conditional gcloud / pulumi /
 * docker entries tied to generic skills that also no longer ship.
 * Dropped here.
 */
function buildSettingsJson(config: ResolvedConfig): string {
  const perms: string[] = [
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git branch:*)',
    `Bash(${dxkitCli()}:*)`,
    'Bash(./node_modules/.bin/vyuh-dxkit:*)',
    'Bash(vyuh-dxkit:*)',
  ];
  for (const lang of activeLanguagesFromStack(config)) {
    if (lang.permissions) perms.push(...lang.permissions);
  }

  return (
    JSON.stringify(
      {
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        permissions: {
          allow: perms,
          deny: [],
        },
        // PreToolUse hook on the tools agents ACTUALLY use to navigate:
        // Read/Edit (keyed on the file touched → that file's structural
        // map), Bash (parses grep/rg commands), and Grep/Glob (symbol
        // match). Injects a slim graph slice as additional context so the
        // agent needs fewer follow-up whole-file reads (the navigation-
        // layer token win). Pre-2.10 only Grep/Glob were wired, and the
        // hook almost never fired because real agents search via
        // `Bash grep` and read files directly — the Read + Bash surfaces
        // are what make the passive delivery actually engage.
        // ADDITIVE + FAIL-OPEN by construction — `context-hook` only ever
        // adds context and silently no-ops when graph.json is
        // absent/stale, so the tool always works normally.
        hooks: {
          PreToolUse: [
            {
              matcher: 'Read|Edit|Bash|Grep|Glob',
              hooks: [
                {
                  type: 'command',
                  command: claudeHookCommand('context-hook'),
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * The dxkit-specific skills shipped under `--with-dxkit-agents`.
 * Each lives at `.claude/skills/<name>/SKILL.md` in the template dir;
 * generator copies them verbatim (no template substitution — the
 * skill content references the canonical `vyuh-dxkit` CLI surface
 * and doesn't need per-project variables).
 */
export const DXKIT_SKILLS = [
  'dxkit-learn',
  'dxkit-init',
  'dxkit-config',
  'dxkit-hooks',
  'dxkit-reports',
  'dxkit-action',
  // dxkit-fix (2.5.2): reactive repair surface. Consumes
  // `vyuh-dxkit doctor --json` output and walks the customer through
  // each fixable check. Lands after the doctor pivot adds structured
  // output + fix metadata in 2.5.2.
  'dxkit-fix',
  // dxkit-update (2.5.2): existing-install upgrade orchestrator.
  // Consumes `vyuh-dxkit upgrade --plan --json` output and drives
  // conversational upgrade with version-delta analysis, warnings,
  // and per-step confirmation.
  'dxkit-update',
  // dxkit-onboard (2.5.2): fresh-install orchestrator. Walks the
  // customer through the full first-time setup journey (install,
  // doctor, fix-gaps, baseline, hooks, branch protection, prebuild).
  // Dispatches into the other lifecycle skills for sub-decisions.
  'dxkit-onboard',
  // dxkit-feature: forward-development orchestrator. Orients via the
  // code graph (context / explore) to find where a new feature plugs
  // in and what it touches, then runs the analyzers + guardrail on the
  // change so net-new development doesn't ship a regression. The
  // proactive counterpart to dxkit-action's reactive fix loop.
  'dxkit-feature',
  // dxkit-docs: documentation generator. Reads the Documentation
  // dimension's gaps, orients on the real code via the graph, and
  // writes grounded README / docstrings / API + architecture docs —
  // re-running the slop check so generated prose doesn't trade
  // Documentation score for Quality score.
  'dxkit-docs',
  // dxkit-ingest: brings an external interprocedural-SAST engine's
  // findings (Snyk Code, CodeQL, any SARIF) into dxkit so they're
  // fingerprinted, baselined, guardrailed, graph-linked, and fixable
  // by dxkit-action. License-aware engine selection; quota-free Snyk
  // read; committed snapshot so the token is needed only at ingest time.
  'dxkit-ingest',
  // dxkit-allowlist: suppression-lifecycle surface. Reviews, audits
  // (including orphans after a re-baseline), removes stale entries,
  // prunes expired ones, and exports Snyk-originated suppressions to a
  // `.snyk` policy. The fix-vs-suppress decision + the `add` path stay
  // in dxkit-action; this owns everything after an entry exists.
  'dxkit-allowlist',
  // dxkit-test: test-generation surface, the testing mirror of
  // dxkit-docs. Reads the blast-radius-weighted test-gaps worklist,
  // orients on real behavior via the graph, and writes meaningful tests
  // that close the highest-risk gaps + move the Tests score without
  // coverage theater. dxkit-action triages WHETHER to test; this WRITES.
  'dxkit-test',
  // dxkit-pr: opens a pull request with a title + body grounded in the
  // branch's real commits/diff (features, fixes, findings closed) plus
  // the dxkit signals (guardrail verdict, allowlist activity, score
  // deltas) and a tailored reviewer checklist. The close of the
  // dxkit-feature / dxkit-action loop.
  'dxkit-pr',
  // dxkit-loop: operate the autonomous-loop Stop-gate. Sets it up
  // (init --claude-loop / loop doctor), explains a block, reads the
  // ledger, and switches the security-only / full-debt posture. The
  // operator surface for the deterministic preflight/postflight layer.
  'dxkit-loop',
  // dxkit-flow: configure/diagnose/fix the UI→API integration gate.
  // Thin orchestration over the CLI — setup folds into `init --flow`,
  // diagnose reads `doctor`'s flow section, fix repairs a net-new
  // broken integration the guardrail flagged (never suppresses it),
  // and the handshake mode drives `flow publish` for cross-repo meshes.
  'dxkit-flow',
  // dxkit-schema: configure/read/act-on the model-schema drift gate.
  // Thin orchestration over the CLI — setup folds into `configure`,
  // inventory + pre-push preview via `schema` / `schema diff`, and the
  // fix mode ships a deliberate breaking change the safe way (migration
  // + expiring accepted-risk allowlist entry), never a posture bypass.
  'dxkit-schema',
  // dxkit-extensions: plug the repo's own extractors/inventories/sinks into
  // dxkit as rung-2 declared artifacts or rung-3 external extensions; owns
  // the authoring loop (extensions dev/init) and the trust-model explainer.
  'dxkit-extensions',
  // dxkit-author-extension (3.5 / #11c): the agent WRITES an extension from
  // a prose description of the repo's convention — rung selection, manifest/
  // adapter/plugin generation, and the `extensions dev` loop until green.
  'dxkit-author-extension',
  // dxkit-uninstall: cleanly remove all of dxkit from a repo, restoring the
  // pre-dxkit state (reverse each additive merge, delete created files),
  // dry-run first. Also captures optional, opt-in feedback via a prefilled
  // GitHub issue. The graceful-exit surface.
  'dxkit-uninstall',
  // dxkit-checks (3.0): declare + operate custom repo-invariant gates and the
  // pack-declared built-in lint gate — the guardrail fingerprints their
  // failures and blocks only net-new ones (pre-existing debt grandfathered).
  // Drives `vyuh-dxkit checks` + the policy.json:checks/lint config. Rule 17.
  'dxkit-checks',
  // dxkit-evaluate: the zero-write trial. Replays recent landings through
  // the gate in disposable worktrees and reports what would have blocked
  // plus what enabling dxkit costs — the honest pre-adoption answer, and
  // useful post-install for "would the gate have caught this range".
  'dxkit-evaluate',
] as const;

interface GenerateResult {
  created: string[];
  skipped: string[];
  overwritten: string[];
  manifest: Manifest;
}

export async function generate(
  targetDir: string,
  config: ResolvedConfig,
  mode: GenerationMode,
  force: boolean,
  _noScan = false,
  withDxkitAgents = false,
): Promise<GenerateResult> {
  const variables = buildVariables(config);
  const conditions = buildConditions(config);
  const templatesDir = getTemplatesDir();

  const result: GenerateResult = {
    created: [],
    skipped: [],
    overwritten: [],
    manifest: {
      version: VERSION,
      mode,
      generatedAt: new Date().toISOString(),
      config,
      files: {},
    },
  };

  // On UPDATE (or a re-init over an existing install) the prior manifest tells
  // us, per file, whether dxkit owns it and what dxkit last wrote — so we can
  // REFRESH dxkit-owned files that shipped fixes while NEVER clobbering files
  // the user owns (the #10 / #11 class). On a fresh init (no prior manifest) we
  // fall back to the historical skip-if-exists behavior, unchanged.
  let priorManifest: Manifest | null = null;
  try {
    const mp = path.join(targetDir, '.vyuh-dxkit.json');
    if (fs.existsSync(mp)) priorManifest = JSON.parse(fs.readFileSync(mp, 'utf-8')) as Manifest;
  } catch {
    priorManifest = null;
  }

  function trackWritten(
    rel: string,
    writeResult: 'created' | 'overwritten',
    content: string | null,
    evolving: boolean,
  ) {
    if (writeResult === 'created') result.created.push(rel);
    else result.overwritten.push(rel);
    result.manifest.files[rel] = {
      hash: evolving ? null : content ? sha256(content) : null,
      evolving,
      provenance: writeResult,
    };
  }

  function trackSkipped(rel: string, evolving: boolean) {
    result.skipped.push(rel);
    // Carry the prior lineage forward so uninstall still knows what dxkit owns;
    // an existing file dxkit never tracked becomes a user-owned 'skipped' entry
    // (never a stored hash — the hash would be dxkit's template, not the user's
    // content, and mistaking one for the other is how --force deleted a
    // project's own AGENTS.md / CLAUDE.md before this).
    result.manifest.files[rel] = priorManifest?.files[rel] ?? {
      hash: null,
      evolving,
      provenance: 'skipped',
    };
  }

  /**
   * Write one managed file, honoring provenance on update. `copyFrom` set → copy
   * that file; otherwise write `content`. Returns nothing — it tracks the result.
   */
  function applyManaged(
    outputPath: string,
    content: string,
    evolving: boolean,
    copyFrom: string | null,
  ) {
    const rel = path.relative(targetDir, outputPath);
    const exists = fs.existsSync(outputPath);

    const decision =
      priorManifest === null
        ? // Fresh init — the historical skip-if-exists semantics, verbatim.
          exists && (evolving || !force)
          ? 'skip'
          : 'write'
        : decideUpdateDisposition({
            exists,
            evolving,
            priorEntry: priorManifest.files[rel],
            onDiskHash: () => sha256(fs.readFileSync(outputPath, 'utf-8')),
            force,
            userMergeTarget: USER_MERGE_TARGETS.has(rel),
          });

    if (decision === 'skip') {
      trackSkipped(rel, evolving);
      return;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (copyFrom) fs.copyFileSync(copyFrom, outputPath);
    else fs.writeFileSync(outputPath, content, 'utf-8');
    trackWritten(rel, exists ? 'overwritten' : 'created', content || null, evolving);
  }

  async function writeTemplate(templatePath: string, outputRel: string, evolving = false) {
    const raw = readTemplate(templatePath);
    const processed = processTemplate(raw, variables, conditions);
    applyManaged(path.join(targetDir, outputRel), processed, evolving, null);
  }

  function copyStatic(templatePath: string, outputRel: string, evolving = false) {
    const srcPath = path.join(templatesDir, templatePath);
    if (!fs.existsSync(srcPath)) return;
    // For a non-evolving copy we hash the source content; an evolving copy stores
    // no hash (pass '' so trackWritten records null).
    const content = evolving ? '' : fs.readFileSync(srcPath, 'utf-8');
    applyManaged(path.join(targetDir, outputRel), content, evolving, srcPath);
  }

  if (withDxkitAgents) {
    logger.header('Generating dxkit agent context');

    // Open-standard project prose — read by every coding agent
    // (Claude / Codex / Cursor / Aider). Pre-2.5.1 this content lived
    // in CLAUDE.md; AGENTS.md is the cross-platform replacement.
    await writeTemplate('AGENTS.md.template', 'AGENTS.md');
    logger.success('AGENTS.md');

    // CLAUDE.md becomes a small shim that points at AGENTS.md. Claude
    // Code reads both at session start; the shim carries Claude-
    // specific config (skill list, rules pointer) and defers shared
    // context to AGENTS.md.
    await writeTemplate('CLAUDE.md.template', 'CLAUDE.md');
    logger.success('CLAUDE.md');

    // Narrowed settings.json — drops the Stop-hook noise + conditional
    // gcloud/pulumi/docker entries that referenced generic skills that
    // no longer ship.
    const settingsContent = buildSettingsJson(config);
    applyManaged(path.join(targetDir, '.claude', 'settings.json'), settingsContent, false, null);
    logger.success('.claude/settings.json');

    // The six dxkit-specific skills. Each ships as a single SKILL.md
    // under `.claude/skills/dxkit-<name>/`. Auto-discovered by Claude
    // Code via skill frontmatter (`name` + `description`).
    for (const skill of DXKIT_SKILLS) {
      copyStatic(`.claude/skills/${skill}/SKILL.md`, `.claude/skills/${skill}/SKILL.md`);
    }
    logger.success('.claude/skills/dxkit-*');

    // Per-language rules from each active pack — still useful as
    // contextual hints to any agent (coding conventions, lint rule
    // exceptions, etc.).
    for (const lang of activeLanguagesFromStack(config)) {
      if (lang.ruleFile) {
        copyStatic(`.claude/rules/${lang.ruleFile}`, `.claude/rules/${lang.ruleFile}`);
      }
    }
    // Framework-specific rules — NOT pack-owned. Frameworks
    // (nextjs/loopback/express) live under the top-level `framework`
    // signal, not in `languages`. Stay hardcoded here until a
    // framework-pack abstraction exists.
    if (conditions.IF_NEXTJS) copyStatic('.claude/rules/nextjs.md', '.claude/rules/nextjs.md');
    if (config.framework === 'loopback')
      copyStatic('.claude/rules/loopback.md', '.claude/rules/loopback.md');
    if (config.framework === 'express')
      copyStatic('.claude/rules/express.md', '.claude/rules/express.md');
    logger.success('.claude/rules/');
  }

  // Always write the manifest — `vyuh-dxkit update` / `doctor` / etc.
  // read it to know what was configured even when no agent scaffold
  // is present.
  const manifestContent = JSON.stringify(result.manifest, null, 2) + '\n';
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, '.vyuh-dxkit.json'), manifestContent, 'utf-8');

  return result;
}
