import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { POLICY_PARAMS, POLICY_STANZAS, POLICY_GUIDE_URL } from '../src/baseline/policy-metadata';
import { replacePolicyGuideTables } from '../src/discovery/policy-guide-tables';
import { REMEDIATE_TASKS } from '../src/remediate/tasks';
import { AGENT_DRIVERS } from '../src/remediate/registry';

/**
 * The guide gates (design §9 E1/E4/E5): every anchor the metadata table
 * emits — into scaffold comments and schema hover text — must land on a
 * real heading here (E4 forward); the knob index is REGISTRY-emitted so a
 * renamed knob regenerates it and stale content fails the parity pin (E4
 * reverse, via E5); and the registry tables (task tiers, driver mapping)
 * are pinned committed == freshly rendered, so a registry change that
 * forgets `npm run docs:policy-guide` fails CI with the command named. A
 * hand-written "haiku currently means <dated id>" line can never exist:
 * the guide contains no dated model ids at all.
 */

const guidePath = join(__dirname, '..', 'docs', 'configuration', 'policy-guide.md');
const guide = readFileSync(guidePath, 'utf8');

/** GitHub-style heading slug. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const headingSlugs = new Set(
  guide
    .split('\n')
    .filter((l) => /^#{1,4} /.test(l))
    .map((l) => slug(l.replace(/^#+ /, ''))),
);

describe('E1 — every taught knob has a guide section', () => {
  const anchors = new Set([
    ...POLICY_PARAMS.map((p) => p.anchor),
    ...POLICY_STANZAS.map((s) => s.anchor),
  ]);
  for (const anchor of [...anchors].sort()) {
    it(`anchor '#${anchor}' resolves to a real heading`, () => {
      expect(headingSlugs.has(anchor), `no heading slugs to '${anchor}'`).toBe(true);
    });
  }
});

describe('E4 — every emitted link lands', () => {
  it('every #anchor reference INSIDE the guide resolves to a heading', () => {
    const refs = [...guide.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of refs) {
      expect(headingSlugs.has(ref), `dangling in-guide link '#${ref}'`).toBe(true);
    }
  });

  it('the guide URL the scaffold/schema link to is this file', () => {
    expect(POLICY_GUIDE_URL.endsWith('docs/configuration/policy-guide.md')).toBe(true);
  });
});

describe('E5 — registry tables are emitted, never hand-written', () => {
  it('committed guide matches a fresh render — if this fails: npm run build && npm run docs:policy-guide', () => {
    // prettier reflows the generated tables; compare content ignoring
    // inter-cell padding and separator-dash width, exactly like the
    // command-table pin.
    const normalize = (s: string) =>
      s
        .replace(/-{3,}/g, '---')
        .replace(/[ \t]*\|[ \t]*/g, '|')
        .replace(/[ \t]+/g, ' ');
    expect(normalize(replacePolicyGuideTables(guide))).toBe(normalize(guide));
  });

  it('the generated tables carry every task and driver', () => {
    for (const t of REMEDIATE_TASKS) expect(guide).toContain(`\`${t.id}\``);
    for (const d of AGENT_DRIVERS) expect(guide).toContain(`\`${d.id}\``);
  });

  it('no dated model id anywhere in the guide (the README-matrix ban)', () => {
    expect(guide).not.toMatch(/claude-[a-z-]*\d-\d{8}/);
    expect(guide).not.toMatch(/\d{8}/);
  });
});
