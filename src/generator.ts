import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig, GenerationMode, Manifest } from './types';
import { buildVariables, buildConditions, VERSION } from './constants';
import { processTemplate } from './template-engine';
import { writeFile, copyFile, sha256 } from './files';
import { activeLanguagesFromStack } from './languages';
import { dxkitCli } from './self-invocation';
import * as logger from './logger';

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
                  command: dxkitCli('context-hook'),
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
  // dxkit-uninstall: cleanly remove all of dxkit from a repo, restoring the
  // pre-dxkit state (reverse each additive merge, delete created files),
  // dry-run first. Also captures optional, opt-in feedback via a prefilled
  // GitHub issue. The graceful-exit surface.
  'dxkit-uninstall',
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

  const opts = (evolving: boolean) => ({ force, evolving, skipIfExists: !force });

  function track(
    outputPath: string,
    content: string | null,
    writeResult: string,
    evolving: boolean,
  ) {
    const rel = path.relative(targetDir, outputPath);
    if (writeResult === 'created') result.created.push(rel);
    else if (writeResult === 'skipped') result.skipped.push(rel);
    else if (writeResult === 'overwritten') result.overwritten.push(rel);

    // Provenance is what uninstall trusts to decide what it may remove. A
    // SKIPPED file already existed — the user owns it — so we record that fact
    // and store no hash (the hash would be dxkit's template, not the user's
    // content, and mistaking one for the other is how --force could delete a
    // project's own AGENTS.md / CLAUDE.md).
    const provenance =
      writeResult === 'created'
        ? 'created'
        : writeResult === 'overwritten'
          ? 'overwritten'
          : 'skipped';
    result.manifest.files[rel] = {
      hash: provenance === 'skipped' ? null : evolving ? null : content ? sha256(content) : null,
      evolving,
      provenance,
    };
  }

  async function writeTemplate(templatePath: string, outputRel: string, evolving = false) {
    const raw = readTemplate(templatePath);
    const processed = processTemplate(raw, variables, conditions);
    const outputPath = path.join(targetDir, outputRel);
    const res = await writeFile(outputPath, processed, opts(evolving));
    track(outputPath, processed, res, evolving);
  }

  function copyStatic(templatePath: string, outputRel: string, evolving = false) {
    const srcPath = path.join(templatesDir, templatePath);
    if (!fs.existsSync(srcPath)) return;
    const outputPath = path.join(targetDir, outputRel);
    const res = copyFile(srcPath, outputPath, opts(evolving));
    const content = evolving ? null : fs.readFileSync(srcPath, 'utf-8');
    track(outputPath, content, res, evolving);
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
    const settingsPath = path.join(targetDir, '.claude', 'settings.json');
    const settingsRes = await writeFile(settingsPath, settingsContent, opts(false));
    track(settingsPath, settingsContent, settingsRes, false);
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
