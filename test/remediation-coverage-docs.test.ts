import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LANGUAGES } from '../src/languages';
import type { LanguageSupport } from '../src/languages';
import {
  renderRemediationCoverage,
  replaceRemediationCoverage,
  REMEDIATION_CAPABILITY_LABELS,
  REMEDIATION_COVERAGE_BEGIN,
  REMEDIATION_COVERAGE_END,
} from '../src/discovery/remediation-coverage-tables';
import { REMEDIATION_CAPABILITY_IDS } from '../src/languages/capabilities/remediation';

/**
 * The remediation coverage table in the lanes guide is EMITTED from the
 * pack declarations (4.4.7 V4), never hand-maintained: the committed
 * region must match a fresh render, so a declaration change (or a new
 * pack) that forgets `npm run build && npm run docs:remediation-coverage`
 * fails here with the command named. The mutation test proves the pin
 * itself bites: a changed declaration MUST change the render, otherwise
 * this file would pass on a renderer that stopped reading the registry.
 */

const guidePath = join(__dirname, '..', 'docs', 'learn', 'operating-the-lanes.md');
const guide = readFileSync(guidePath, 'utf8');

/** Prettier reflows table padding; compare content, not padding (the same
 *  normalization the policy-guide pin uses). */
const normalize = (s: string) =>
  s
    .replace(/-{3,}/g, '---')
    .replace(/[ \t]*\|[ \t]*/g, '|')
    .replace(/[ \t]+/g, ' ');

describe('remediation coverage table is emitted, never hand-written', () => {
  it('the guide carries the generated region markers', () => {
    expect(guide).toContain(REMEDIATION_COVERAGE_BEGIN);
    expect(guide).toContain(REMEDIATION_COVERAGE_END);
  });

  it('committed guide matches a fresh render (if this fails: npm run build && npm run docs:remediation-coverage)', () => {
    expect(normalize(replaceRemediationCoverage(guide))).toBe(normalize(guide));
  });

  it('every registered pack has a row and every capability a column', () => {
    const table = renderRemediationCoverage();
    for (const lang of LANGUAGES) expect(table).toContain(`| \`${lang.id}\` |`);
    for (const id of REMEDIATION_CAPABILITY_IDS) {
      expect(table).toContain(REMEDIATION_CAPABILITY_LABELS[id]);
    }
  });

  it('every declared exemption reason reaches the guide verbatim', () => {
    for (const lang of LANGUAGES) {
      for (const id of REMEDIATION_CAPABILITY_IDS) {
        const declaration = lang.remediation[id];
        if (declaration.kind === 'exemption') {
          expect(guide, `${lang.id}.${id} reason missing from the guide`).toContain(
            declaration.reason,
          );
        }
      }
    }
  });

  it('the pin bites: a mutated declaration changes the render', () => {
    const [first, ...rest] = LANGUAGES;
    const mutated: LanguageSupport = {
      ...first,
      remediation: {
        ...first.remediation,
        resyncLockfile: {
          kind: 'exemption',
          reason: 'synthetic mutation: this sentence must change the rendered table',
        },
      },
    };
    const fresh = replaceRemediationCoverage(guide, [mutated, ...rest]);
    expect(normalize(fresh)).not.toBe(normalize(guide));
    expect(fresh).toContain('synthetic mutation: this sentence must change the rendered table');
  });
});
