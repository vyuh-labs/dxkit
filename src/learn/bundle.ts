/**
 * The learn bundle — the ONE content assembly the learn page, the search
 * index, and the `--serve` assistant grounding all read (Rule 2.30: one
 * concept, one code path; the page and the assistant can never drift from
 * each other).
 *
 * Three content classes, each with its own drift net
 * (`test/learn/kb-coverage.test.ts`):
 *
 *   1. GENERATED from live registries compiled into this package — the
 *      command catalog (`COMMANDS`), posture knobs (`POSTURE_KNOBS`), the
 *      remediation task registry (`REMEDIATE_TASKS`), and the agent skills
 *      dxkit installs (enumerated from the packaged templates). Cannot
 *      drift from the product by construction.
 *   2. The REFERENCE SHELF: the repo's entire `docs/` tree, shipped
 *      verbatim (packaged at build). Every doc is either in the bundle or
 *      in `KB_EXCLUDED` with a reason — a new doc that skips the KB fails
 *      the coverage test.
 *   3. CURATED learn narratives (`docs/learn/`), the guided reading path.
 *
 * All of it works with NO repo, no git, and no network (the zero-context
 * path is first-class).
 */
import * as fs from 'fs';
import * as path from 'path';
import { CORE_COMMAND_IDS, GROUP_LABELS, GROUP_ORDER, userCommands } from '../discovery/commands';
import { POSTURE_KNOBS } from '../discovery/posture-knobs';
import { REMEDIATE_TASKS } from '../remediate/tasks';
import { templatesDir } from '../ship-installers';
import { VERSION } from '../constants';

export interface LearnDoc {
  slug: string;
  /** First `# ` heading of the file. */
  title: string;
  markdown: string;
}

export interface ReferenceDoc {
  /** docs/-relative POSIX path, e.g. `configuration/policy.md`. */
  relPath: string;
  /** Display group on the page (Commands / Configuration / Benchmarks / Guides). */
  group: string;
  title: string;
  markdown: string;
  /** Whether this doc is included in the assistant's grounding (the page and
   *  search always carry everything; grounding is size-budgeted). */
  grounded: boolean;
}

export interface LearnCapability {
  id: string;
  group: string;
  groupLabel: string;
  tier: 'core' | 'more';
  summary: string;
  docsBlurb?: string;
  typicalRuntime?: string;
  aliases?: readonly string[];
  skill?: string;
}

export interface LearnKnob {
  path: string;
  command: string;
  note?: string;
}

export interface LearnSkill {
  name: string;
  description: string;
}

export interface LearnTask {
  id: string;
  summary: string;
  tier: string;
}

export interface LearnBundle {
  version: string;
  /** Core tier first (registry order), then the remaining user-facing
   *  commands in group display order. */
  capabilities: LearnCapability[];
  knobs: LearnKnob[];
  docs: LearnDoc[];
  reference: ReferenceDoc[];
  skills: LearnSkill[];
  tasks: LearnTask[];
}

/** Display order of the curated docs on the page. */
const DOC_SLUGS = [
  'how-dxkit-thinks',
  'capabilities-and-limits',
  'quickstart-developer',
  'quickstart-reviewer',
  'quickstart-admin',
  'extending-dxkit',
] as const;

/**
 * docs/-relative paths deliberately NOT in the bundle, each with a reason —
 * the `DEFERRED_KINDS` discipline: an exclusion is a declared decision,
 * never a silent omission. The coverage test enforces that every doc on
 * disk is bundled or listed here (and that listed paths actually exist).
 */
export const KB_EXCLUDED: ReadonlyArray<{ relPath: string; reason: string }> = [
  {
    relPath: 'MIGRATING-TO-2.4.7-SCORING.md',
    reason: 'historical one-time migration note for a 2.x upgrade; not current-product knowledge',
  },
];

/** Which reference docs join the assistant grounding (size-budgeted: the
 *  command pages duplicate the registry blurbs and the deep benchmark pages
 *  are large; both stay page+search-only). */
function isGrounded(relPath: string): boolean {
  if (relPath.startsWith('configuration/')) return true;
  return ['getting-started.md', 'why-dxkit.md', 'extension-sdk.md', 'benchmarks.md'].includes(
    relPath,
  );
}

function referenceGroup(relPath: string): string {
  if (relPath.startsWith('commands/')) return 'Command reference';
  if (relPath.startsWith('configuration/')) return 'Configuration reference';
  if (relPath.startsWith('benchmarks/') || relPath === 'benchmarks.md') return 'Benchmarks';
  return 'Guides';
}

/**
 * Locate the packaged content: the compiled copy next to this module
 * (`dist/learn/docs`, written by the build), falling back to the repo tree
 * when running from source (tests, tsx).
 */
export function learnDocsDir(): string {
  const packaged = path.join(__dirname, 'docs');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'docs', 'learn');
}

/** The packaged reference shelf (`dist/learn/docs-ref`), or the repo docs/. */
export function referenceDocsDir(): string {
  const packaged = path.join(__dirname, 'docs-ref');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'docs');
}

function titleOf(markdown: string, fallback: string): string {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : fallback;
}

function loadDocs(): LearnDoc[] {
  const dir = learnDocsDir();
  const docs: LearnDoc[] = [];
  for (const slug of DOC_SLUGS) {
    const p = path.join(dir, `${slug}.md`);
    let markdown: string;
    try {
      markdown = fs.readFileSync(p, 'utf-8');
    } catch {
      // A missing doc is a packaging bug; degrade to a visible stub rather
      // than a broken page, and let the bundle test catch it in CI.
      markdown = `# ${slug}\n\nThis document was not packaged with this build.`;
    }
    docs.push({ slug, title: titleOf(markdown, slug), markdown });
  }
  return docs;
}

/** Recursive .md listing of a docs tree, as sorted docs/-relative POSIX paths. */
export function listDocsTree(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(root, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.name.endsWith('.md')) out.push(childRel);
    }
  };
  try {
    walk('');
  } catch {
    return [];
  }
  return out.sort();
}

const EXCLUDED_SET = new Set(KB_EXCLUDED.map((e) => e.relPath));

function loadReference(): ReferenceDoc[] {
  const root = referenceDocsDir();
  const out: ReferenceDoc[] = [];
  for (const relPath of listDocsTree(root)) {
    // The curated learn docs are class 3, loaded separately; the generated
    // README command table is a projection of the registry (class 1).
    if (relPath.startsWith('learn/') || relPath === 'README.md') continue;
    if (EXCLUDED_SET.has(relPath)) continue;
    let markdown: string;
    try {
      markdown = fs.readFileSync(path.join(root, relPath), 'utf-8');
    } catch {
      continue;
    }
    out.push({
      relPath,
      group: referenceGroup(relPath),
      title: titleOf(markdown, relPath),
      markdown,
      grounded: isGrounded(relPath),
    });
  }
  return out;
}

/** The agent skills dxkit installs, enumerated from the packaged templates —
 *  a registry read, never a hand-maintained list. */
function loadSkills(): LearnSkill[] {
  const dir = path.join(templatesDir(), '.claude', 'skills');
  const out: LearnSkill[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  for (const name of entries) {
    const skillMd = path.join(dir, name, 'SKILL.md');
    let description = '';
    try {
      const raw = fs.readFileSync(skillMd, 'utf-8');
      const m = raw.match(/^description:\s*(.+)$/m);
      description = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    } catch {
      continue;
    }
    out.push({ name, description });
  }
  return out;
}

export function buildLearnBundle(): LearnBundle {
  const caps: LearnCapability[] = [];
  const all = userCommands();
  for (const id of CORE_COMMAND_IDS) {
    const c = all.find((x) => x.id === id);
    if (!c || c.group === 'internal') continue;
    caps.push({
      id: c.id,
      group: c.group,
      groupLabel: GROUP_LABELS[c.group],
      tier: 'core',
      summary: c.summary,
      docsBlurb: c.docsBlurb,
      typicalRuntime: c.typicalRuntime,
      aliases: c.aliases,
      skill: c.skill,
    });
  }
  for (const group of GROUP_ORDER) {
    for (const c of all) {
      if (c.group !== group) continue;
      if ((CORE_COMMAND_IDS as readonly string[]).includes(c.id)) continue;
      caps.push({
        id: c.id,
        group: c.group,
        groupLabel: GROUP_LABELS[group],
        tier: 'more',
        summary: c.summary,
        docsBlurb: c.docsBlurb,
        typicalRuntime: c.typicalRuntime,
        aliases: c.aliases,
        skill: c.skill,
      });
    }
  }
  return {
    version: VERSION,
    capabilities: caps,
    knobs: POSTURE_KNOBS.map((k) => ({ path: k.path, command: k.command, note: k.note })),
    docs: loadDocs(),
    reference: loadReference(),
    skills: loadSkills(),
    tasks: REMEDIATE_TASKS.map((t) => ({ id: t.id, summary: t.summary, tier: String(t.tier) })),
  };
}

/**
 * The KB coverage checker — PURE so the drift net can synthetic-inject
 * (mirror of the registry playbooks): given the docs on disk and the bundle,
 * report anything that is neither bundled nor declared-excluded, plus any
 * declared exclusion that no longer exists.
 */
export function checkKbCoverage(
  docsOnDisk: readonly string[],
  bundledRelPaths: readonly string[],
  curatedSlugs: readonly string[],
  excluded: ReadonlyArray<{ relPath: string; reason: string }> = KB_EXCLUDED,
): { uncovered: string[]; staleExclusions: string[]; reasonless: string[] } {
  const bundled = new Set(bundledRelPaths);
  const curated = new Set(curatedSlugs.map((s) => `learn/${s}.md`));
  const excludedSet = new Set(excluded.map((e) => e.relPath));
  const uncovered = docsOnDisk.filter(
    (p) => p !== 'README.md' && !bundled.has(p) && !curated.has(p) && !excludedSet.has(p),
  );
  const onDisk = new Set(docsOnDisk);
  const staleExclusions = excluded.map((e) => e.relPath).filter((p) => !onDisk.has(p));
  const reasonless = excluded.filter((e) => e.reason.trim().length < 10).map((e) => e.relPath);
  return { uncovered, staleExclusions, reasonless };
}

/** The curated slugs, exported for the coverage test. */
export const CURATED_DOC_SLUGS: readonly string[] = DOC_SLUGS;
