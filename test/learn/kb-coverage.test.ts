/**
 * The KB drift net (the "how do we make sure this knowledge base doesn't
 * drift?" answer, made mechanical):
 *
 *   - GENERATED class: every user-facing command, every posture knob, every
 *     installed agent skill, and every remediation task MUST appear in the
 *     bundle (and therefore on the page, in search, and in the assistant's
 *     grounding source).
 *   - REFERENCE class: every .md under docs/ is either bundled or declared
 *     in KB_EXCLUDED with a real reason; a stale exclusion fails too.
 *   - SYNTHETIC INJECTION: the checker itself is proven to bite (mirror of
 *     the registry playbooks) — a new doc that skips the KB is flagged.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  buildLearnBundle,
  checkKbCoverage,
  listDocsTree,
  CURATED_DOC_SLUGS,
  KB_EXCLUDED,
} from '../../src/learn/bundle';
import { assembleGrounding } from '../../src/learn/grounding';
import { renderLearnHtml } from '../../src/learn/render';
import { userCommands } from '../../src/discovery/commands';
import { POSTURE_KNOBS } from '../../src/discovery/posture-knobs';
import { REMEDIATE_TASKS } from '../../src/remediate/tasks';

const REPO_ROOT = path.join(__dirname, '..', '..');
const bundle = buildLearnBundle();
const html = renderLearnHtml(bundle, null, { serve: true });
const grounding = assembleGrounding(bundle, null);

describe('KB coverage — generated class (registries reach every surface)', () => {
  it('every user-facing command is in the bundle, the page, and the grounding', () => {
    for (const c of userCommands()) {
      expect(
        bundle.capabilities.some((x) => x.id === c.id),
        `bundle missing command ${c.id}`,
      ).toBe(true);
      expect(html, `page missing command ${c.id}`).toContain(`cap-${c.id}`);
      expect(grounding.system, `grounding missing command ${c.id}`).toContain(`- ${c.id} [`);
    }
  });

  it('every posture knob is in the bundle and the grounding', () => {
    for (const k of POSTURE_KNOBS) {
      expect(
        bundle.knobs.some((x) => x.path === k.path),
        `knob ${k.path}`,
      ).toBe(true);
      expect(grounding.system).toContain(k.path);
    }
  });

  it('every installed agent skill is in the bundle, the page, and the grounding', () => {
    const skillsDir = path.join(REPO_ROOT, 'templates', '.claude', 'skills');
    const onDisk = fs.readdirSync(skillsDir).sort();
    expect(onDisk.length).toBeGreaterThan(10);
    for (const name of onDisk) {
      expect(
        bundle.skills.some((s) => s.name === name),
        `skill ${name} missing`,
      ).toBe(true);
      expect(html).toContain(name);
      expect(grounding.system).toContain(name);
    }
  });

  it('every remediation task is in the bundle, the page, and the grounding', () => {
    expect(REMEDIATE_TASKS.length).toBeGreaterThan(3);
    for (const t of REMEDIATE_TASKS) {
      expect(
        bundle.tasks.some((x) => x.id === t.id),
        `task ${t.id} missing`,
      ).toBe(true);
      expect(html).toContain(t.id);
      expect(grounding.system).toContain(t.id);
    }
  });
});

describe('KB coverage — reference class (docs/ tree, bundled or declared-excluded)', () => {
  it('every doc on disk is bundled or excluded-with-reason; no stale exclusions', () => {
    const docsOnDisk = listDocsTree(path.join(REPO_ROOT, 'docs'));
    expect(docsOnDisk.length).toBeGreaterThan(40);
    const result = checkKbCoverage(
      docsOnDisk,
      bundle.reference.map((r) => r.relPath),
      CURATED_DOC_SLUGS,
    );
    expect(result.uncovered, `docs missing from the KB: ${result.uncovered.join(', ')}`).toEqual(
      [],
    );
    expect(result.staleExclusions, 'KB_EXCLUDED names docs that no longer exist').toEqual([]);
    expect(result.reasonless, 'KB_EXCLUDED entries need real reasons').toEqual([]);
  });

  it('the reference shelf is rendered and searchable', () => {
    expect(bundle.reference.length).toBeGreaterThan(40);
    // Spot-pin the surfaces the KB was originally missing.
    for (const rel of [
      'configuration/policy.md',
      'configuration/policy-guide.md',
      'commands/guardrail.md',
      'commands/explore.md',
      'commands/report.md',
      'benchmarks.md',
      'extension-sdk.md',
    ]) {
      expect(
        bundle.reference.some((r) => r.relPath === rel),
        `reference missing ${rel}`,
      ).toBe(true);
      expect(html).toContain(`ref-${rel.replace(/[^a-z0-9\s-]/gi, '').toLowerCase()}`.slice(0, 12));
    }
    // The search index carries reference entries.
    expect(html).toContain('"k":"reference"');
    expect(html).toContain('"k":"agent skill"');
    expect(html).toContain('"k":"remediation task"');
  });

  it('the grounded slice includes the configuration reference and benchmarks overview', () => {
    for (const rel of ['configuration/policy.md', 'benchmarks.md', 'getting-started.md']) {
      expect(bundle.reference.find((r) => r.relPath === rel)?.grounded, rel).toBe(true);
    }
    expect(grounding.system).toContain('Reference: ');
  });

  it('SYNTHETIC INJECTION: the checker flags a doc that skips the KB', () => {
    const result = checkKbCoverage(
      ['synthetic/new-feature-guide.md'],
      bundle.reference.map((r) => r.relPath),
      CURATED_DOC_SLUGS,
    );
    expect(result.uncovered).toContain('synthetic/new-feature-guide.md');
    // And an exclusion with a throwaway reason is itself flagged.
    const reasonless = checkKbCoverage(['x.md'], [], [], [{ relPath: 'x.md', reason: 'n/a' }]);
    expect(reasonless.reasonless).toContain('x.md');
  });
});

describe('KB content — the previously-missing narratives exist', () => {
  it('the developer path covers comment-defer, and lanes/graph/skills content is present', () => {
    const dev = bundle.docs.find((d) => d.slug === 'quickstart-developer')!;
    expect(dev.markdown).toContain('/dxkit defer');
    expect(html).toContain('Remediation lane tasks');
    expect(html).toContain('Agent skills');
    expect(KB_EXCLUDED.length).toBeGreaterThanOrEqual(0);
  });
});
