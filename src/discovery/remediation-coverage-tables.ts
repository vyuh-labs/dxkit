/**
 * Registry-emitted remediation coverage table for
 * `docs/learn/operating-the-lanes.md` (4.4.7 V4).
 *
 * Which pack supports which remediation recipe, and why the agent-tier
 * cells are agent-tier, is a REGISTRY fact: every pack's declarations live
 * on `LanguageSupport.remediation` (a provider or a reasoned exemption,
 * never silence). So the table is EMITTED from those declarations into a
 * marked region, never hand-written (hand-written copies of registry facts
 * are the README-matrix drift class, the same reasoning as the
 * policy-guide tables).
 *
 * `scripts/generate-remediation-coverage.js` writes the region;
 * `test/remediation-coverage-docs.test.ts` pins the committed guide
 * against a fresh render, so a declaration change (or a new pack) that
 * forgets the regen step fails CI with a pointer to the command.
 */
import { LANGUAGES } from '../languages';
import type { LanguageSupport } from '../languages';
import {
  REMEDIATION_CAPABILITY_IDS,
  type RemediationCapabilityId,
} from '../languages/capabilities/remediation';
import { replaceMarkedRegion } from './docs-tables';

export const REMEDIATION_COVERAGE_BEGIN =
  '<!-- BEGIN GENERATED: remediation-coverage (edit the pack declarations, then: npm run build && npm run docs:remediation-coverage) -->';
export const REMEDIATION_COVERAGE_END = '<!-- END GENERATED: remediation-coverage -->';

/**
 * Reader-facing label per capability id, keyed by the full union so a new
 * capability cannot ship without a docs label (it fails to compile here).
 */
export const REMEDIATION_CAPABILITY_LABELS: Record<RemediationCapabilityId, string> = {
  resyncLockfile: 'lockfile resync',
  pinTransitive: 'transitive pin',
  declareDependency: 'declare dependency',
  lintFix: 'lint autofix',
};

/**
 * Render the coverage matrix (pack x capability, `recipe` or `agent tier`)
 * plus the pack-declared exemption reasons. `packs` is injectable so the
 * drift test can prove a mutated declaration changes the render.
 */
export function renderRemediationCoverage(packs: readonly LanguageSupport[] = LANGUAGES): string {
  const labels = REMEDIATION_CAPABILITY_IDS.map((id) => REMEDIATION_CAPABILITY_LABELS[id]);
  const lines = [
    `| Pack | ${labels.join(' | ')} |`,
    `|---|${REMEDIATION_CAPABILITY_IDS.map(() => '---').join('|')}|`,
  ];
  for (const pack of packs) {
    const cells = REMEDIATION_CAPABILITY_IDS.map((id) =>
      pack.remediation[id].kind === 'capability' ? 'recipe' : 'agent tier',
    );
    lines.push(`| \`${pack.id}\` | ${cells.join(' | ')} |`);
  }
  const exemptions: string[] = [];
  for (const pack of packs) {
    for (const id of REMEDIATION_CAPABILITY_IDS) {
      const declaration = pack.remediation[id];
      if (declaration.kind === 'exemption') {
        exemptions.push(
          `- \`${pack.id}\` ${REMEDIATION_CAPABILITY_LABELS[id]}: ${declaration.reason}`,
        );
      }
    }
  }
  if (exemptions.length > 0) {
    lines.push('', "The agent-tier cells, in each pack's own words:", '', ...exemptions);
  }
  return lines.join('\n');
}

/** Rewrite the guide's generated region from the registry. */
export function replaceRemediationCoverage(
  text: string,
  packs: readonly LanguageSupport[] = LANGUAGES,
): string {
  return replaceMarkedRegion(
    text,
    REMEDIATION_COVERAGE_BEGIN,
    REMEDIATION_COVERAGE_END,
    renderRemediationCoverage(packs),
  );
}
