/**
 * The learn bundle — the ONE content assembly both the learn page and (next)
 * the `--serve` assistant grounding read (Rule 2.30: one concept, one code
 * path; the page and the assistant can never drift from each other).
 *
 * Two content sources, by design (issue #244):
 *   - GENERATED: capability + knob facts come from the live registries
 *     (`COMMANDS`, `POSTURE_KNOBS`) compiled into this package — they cannot
 *     drift from the product;
 *   - CURATED: the narrative docs under `docs/learn/` (mental model, persona
 *     quickstarts, the capabilities-and-limits statement), copied into
 *     `dist/learn/docs/` at build time so the bundle works with NO repo, no
 *     git, and no network (the zero-context path is first-class).
 */
import * as fs from 'fs';
import * as path from 'path';
import { CORE_COMMAND_IDS, GROUP_LABELS, GROUP_ORDER, userCommands } from '../discovery/commands';
import { POSTURE_KNOBS } from '../discovery/posture-knobs';
import { VERSION } from '../constants';

export interface LearnDoc {
  slug: string;
  /** First `# ` heading of the file. */
  title: string;
  markdown: string;
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

export interface LearnBundle {
  version: string;
  /** Core tier first (registry order), then the remaining user-facing
   *  commands in group display order. */
  capabilities: LearnCapability[];
  knobs: LearnKnob[];
  docs: LearnDoc[];
}

/** Display order of the curated docs on the page. */
const DOC_SLUGS = [
  'how-dxkit-thinks',
  'capabilities-and-limits',
  'quickstart-developer',
  'quickstart-reviewer',
  'quickstart-admin',
] as const;

/**
 * Locate the curated docs: the packaged copy next to the compiled module
 * (`dist/learn/docs/`, written by the build), falling back to the repo's
 * `docs/learn/` when running from source (tests, tsx).
 */
export function learnDocsDir(): string {
  const packaged = path.join(__dirname, 'docs');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'docs', 'learn');
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
    const h1 = markdown.match(/^#\s+(.+)$/m);
    docs.push({ slug, title: h1 ? h1[1].trim() : slug, markdown });
  }
  return docs;
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
  };
}
