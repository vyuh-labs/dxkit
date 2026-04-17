/**
 * CVSS v4.0 base score calculator.
 *
 * Port of FIRST's reference implementation into deterministic TypeScript.
 * Source: https://github.com/FIRSTdotorg/cvss-v4-calculator
 *
 * The lookup table, max-severity data, and max-composed vectors are taken
 * verbatim from the upstream project. The scoring algorithm (macrovector
 * computation + severity-distance refinement) mirrors cvss_score.js.
 *
 * Copyright FIRST, Red Hat, and contributors (for embedded data tables
 * and algorithm shape). SPDX-License-Identifier: BSD-2-Clause.
 * See THIRD_PARTY_NOTICES.md for full attribution.
 *
 * Typical usage:
 *   const score = parseCvssV4BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N');
 *   // => 9.3
 */

import { CVSS_V4_LOOKUP } from './cvss-v4-lookup';

type Metrics = Map<string, string>;

/** Max severity depth per equivalence set (lower macrovector distance). */
const MAX_SEVERITY = {
  eq1: { 0: 1, 1: 4, 2: 5 } as Record<number, number>,
  eq2: { 0: 1, 1: 2 } as Record<number, number>,
  eq3eq6: {
    0: { 0: 7, 1: 6 } as Record<number, number>,
    1: { 0: 8, 1: 8 } as Record<number, number>,
    2: { 1: 10 } as Record<number, number>,
  } as Record<number, Record<number, number>>,
  eq4: { 0: 6, 1: 5, 2: 4 } as Record<number, number>,
  eq5: { 0: 1, 1: 1, 2: 1 } as Record<number, number>,
};

/** Max-composed vectors per (eq, level) — representative highest-severity vectors. */
const MAX_COMPOSED: Record<string, Record<number, string[] | Record<string, string[]>>> = {
  eq1: {
    0: ['AV:N/PR:N/UI:N/'],
    1: ['AV:A/PR:N/UI:N/', 'AV:N/PR:L/UI:N/', 'AV:N/PR:N/UI:P/'],
    2: ['AV:P/PR:N/UI:N/', 'AV:A/PR:L/UI:P/'],
  },
  eq2: {
    0: ['AC:L/AT:N/'],
    1: ['AC:H/AT:N/', 'AC:L/AT:P/'],
  },
  eq3: {
    0: {
      '0': ['VC:H/VI:H/VA:H/CR:H/IR:H/AR:H/'],
      '1': ['VC:H/VI:H/VA:L/CR:M/IR:M/AR:H/', 'VC:H/VI:H/VA:H/CR:M/IR:M/AR:M/'],
    },
    1: {
      '0': ['VC:L/VI:H/VA:H/CR:H/IR:H/AR:H/', 'VC:H/VI:L/VA:H/CR:H/IR:H/AR:H/'],
      '1': [
        'VC:L/VI:H/VA:L/CR:H/IR:M/AR:H/',
        'VC:L/VI:H/VA:H/CR:H/IR:M/AR:M/',
        'VC:H/VI:L/VA:H/CR:M/IR:H/AR:M/',
        'VC:H/VI:L/VA:L/CR:M/IR:H/AR:H/',
        'VC:L/VI:L/VA:H/CR:H/IR:H/AR:M/',
      ],
    },
    2: { '1': ['VC:L/VI:L/VA:L/CR:H/IR:H/AR:H/'] },
  },
  eq4: {
    0: ['SC:H/SI:S/SA:S/'],
    1: ['SC:H/SI:H/SA:H/'],
    2: ['SC:L/SI:L/SA:L/'],
  },
  eq5: {
    0: ['E:A/'],
    1: ['E:P/'],
    2: ['E:U/'],
  },
};

/** Ordinal weights per metric value — used in severity-distance calculation. */
const LEVELS: Record<string, Record<string, number>> = {
  AV: { N: 0.0, A: 0.1, L: 0.2, P: 0.3 },
  PR: { N: 0.0, L: 0.1, H: 0.2 },
  UI: { N: 0.0, P: 0.1, A: 0.2 },
  AC: { L: 0.0, H: 0.1 },
  AT: { N: 0.0, P: 0.1 },
  VC: { H: 0.0, L: 0.1, N: 0.2 },
  VI: { H: 0.0, L: 0.1, N: 0.2 },
  VA: { H: 0.0, L: 0.1, N: 0.2 },
  SC: { H: 0.1, L: 0.2, N: 0.3 },
  SI: { S: 0.0, H: 0.1, L: 0.2, N: 0.3 },
  SA: { S: 0.0, H: 0.1, L: 0.2, N: 0.3 },
  CR: { H: 0.0, M: 0.1, L: 0.2 },
  IR: { H: 0.0, M: 0.1, L: 0.2 },
  AR: { H: 0.0, M: 0.1, L: 0.2 },
};

const STEP = 0.1;

/**
 * Resolve a metric value accounting for "X" (not defined) defaults and
 * environmental modifiers (M-prefixed metrics override base values).
 *
 * Defaults when X:
 *   E  → A (Attacked)
 *   CR, IR, AR → H (High)
 *   Modified metrics (M*) → base metric value
 */
function m(metrics: Metrics, metric: string): string {
  const selected = metrics.get(metric) ?? 'X';

  if (metric === 'E' && selected === 'X') return 'A';
  if ((metric === 'CR' || metric === 'IR' || metric === 'AR') && selected === 'X') return 'H';

  // For base metrics, check if a Modified override is present
  const modifiedKey = 'M' + metric;
  if (metrics.has(modifiedKey)) {
    const mod = metrics.get(modifiedKey);
    if (mod && mod !== 'X') return mod;
  }

  return selected;
}

/** Compute the 6-digit macrovector string for a metrics map. */
function macroVector(metrics: Metrics): string {
  // EQ1: 0 = AV:N AND PR:N AND UI:N
  //      1 = (AV:N OR PR:N OR UI:N) AND NOT (all three N) AND NOT AV:P
  //      2 = AV:P OR NOT (AV:N OR PR:N OR UI:N)
  const av = m(metrics, 'AV');
  const pr = m(metrics, 'PR');
  const ui = m(metrics, 'UI');
  let eq1: number;
  if (av === 'N' && pr === 'N' && ui === 'N') eq1 = 0;
  else if (
    (av === 'N' || pr === 'N' || ui === 'N') &&
    !(av === 'N' && pr === 'N' && ui === 'N') &&
    av !== 'P'
  )
    eq1 = 1;
  else eq1 = 2; // AV:P OR none of them N

  // EQ2: 0 = AC:L AND AT:N, else 1
  const ac = m(metrics, 'AC');
  const at = m(metrics, 'AT');
  const eq2 = ac === 'L' && at === 'N' ? 0 : 1;

  // EQ3: 0 = VC:H AND VI:H
  //      1 = NOT (VC:H AND VI:H) AND (VC:H OR VI:H OR VA:H)
  //      2 = NOT (VC:H OR VI:H OR VA:H)
  const vc = m(metrics, 'VC');
  const vi = m(metrics, 'VI');
  const va = m(metrics, 'VA');
  let eq3: number;
  if (vc === 'H' && vi === 'H') eq3 = 0;
  else if (!(vc === 'H' && vi === 'H') && (vc === 'H' || vi === 'H' || va === 'H')) eq3 = 1;
  else eq3 = 2;

  // EQ4: 0 = MSI:S OR MSA:S
  //      1 = NOT (MSI:S OR MSA:S) AND (SC:H OR SI:H OR SA:H)
  //      2 = NOT (MSI:S OR MSA:S) AND NOT (SC:H OR SI:H OR SA:H)
  const msi = m(metrics, 'MSI');
  const msa = m(metrics, 'MSA');
  const sc = m(metrics, 'SC');
  const si = m(metrics, 'SI');
  const sa = m(metrics, 'SA');
  let eq4: number;
  if (msi === 'S' || msa === 'S') eq4 = 0;
  else if (sc === 'H' || si === 'H' || sa === 'H') eq4 = 1;
  else eq4 = 2;

  // EQ5: 0 = E:A, 1 = E:P, 2 = E:U
  const e = m(metrics, 'E');
  const eq5 = e === 'A' ? 0 : e === 'P' ? 1 : 2;

  // EQ6: 0 = (CR:H AND VC:H) OR (IR:H AND VI:H) OR (AR:H AND VA:H)
  //      1 = otherwise
  const cr = m(metrics, 'CR');
  const ir = m(metrics, 'IR');
  const ar = m(metrics, 'AR');
  const eq6 =
    (cr === 'H' && vc === 'H') || (ir === 'H' && vi === 'H') || (ar === 'H' && va === 'H') ? 0 : 1;

  return `${eq1}${eq2}${eq3}${eq4}${eq5}${eq6}`;
}

/** Pull a metric's value out of a composed-vector fragment like "AV:N/PR:L/UI:N/". */
function extractValueMetric(metric: string, str: string): string {
  const idx = str.indexOf(metric + ':');
  if (idx < 0) return '';
  const start = idx + metric.length + 1;
  const end = str.indexOf('/', start);
  return end < 0 ? str.slice(start) : str.slice(start, end);
}

/** Get max composed vectors for (eq, macrovector). eq=3 is indexed by both eq3 and eq6. */
function getEqMaxes(mv: string, eq: number): string[] {
  const key = 'eq' + eq;
  const level = parseInt(mv[eq - 1], 10);
  const entry = MAX_COMPOSED[key][level];
  if (Array.isArray(entry)) return entry;
  // eq3 — entry is a map keyed by eq6
  const eq6 = mv[5];
  return (entry as Record<string, string[]>)[eq6] ?? [];
}

/**
 * Main entry point: compute a CVSS v4 base score from a vector string.
 * Returns null on malformed input. Range: 0.0 to 10.0, one decimal.
 */
export function parseCvssV4BaseScore(vector: string): number | null {
  if (!vector.startsWith('CVSS:4.')) return null;

  const metrics: Metrics = new Map();
  for (const kv of vector.split('/').slice(1)) {
    const [k, v] = kv.split(':');
    if (k && v) metrics.set(k, v);
  }

  // Required base metrics
  for (const req of ['AV', 'AC', 'AT', 'PR', 'UI', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA']) {
    if (!metrics.has(req)) return null;
  }

  // Shortcut: no impact at all → 0
  const impactMetrics = ['VC', 'VI', 'VA', 'SC', 'SI', 'SA'];
  if (impactMetrics.every((k) => m(metrics, k) === 'N')) return 0;

  const mv = macroVector(metrics);
  const baseScore = CVSS_V4_LOOKUP[mv];
  if (baseScore === undefined) return null;

  // Severity-distance refinement (see cvss_score.js in upstream).
  const eq1 = parseInt(mv[0], 10);
  const eq2 = parseInt(mv[1], 10);
  const eq3 = parseInt(mv[2], 10);
  const eq4 = parseInt(mv[3], 10);
  const eq5 = parseInt(mv[4], 10);
  const eq6 = parseInt(mv[5], 10);

  // Compute next-lower macrovectors per eq (may not exist).
  const nextLower = (digits: number[]) => digits.join('');
  const mvEq1Lower = nextLower([eq1 + 1, eq2, eq3, eq4, eq5, eq6]);
  const mvEq2Lower = nextLower([eq1, eq2 + 1, eq3, eq4, eq5, eq6]);

  // eq3 and eq6 are entangled (spec quirk).
  let mvEq3Eq6LowerLeft: string | null = null;
  let mvEq3Eq6LowerRight: string | null = null;
  let mvEq3Eq6Lower: string | null = null;
  if (eq3 === 1 && eq6 === 1) {
    mvEq3Eq6Lower = nextLower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]);
  } else if (eq3 === 0 && eq6 === 1) {
    mvEq3Eq6Lower = nextLower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]);
  } else if (eq3 === 1 && eq6 === 0) {
    mvEq3Eq6Lower = nextLower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]);
  } else if (eq3 === 0 && eq6 === 0) {
    mvEq3Eq6LowerLeft = nextLower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]);
    mvEq3Eq6LowerRight = nextLower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]);
  } else {
    // 21 → 32 (doesn't exist, produces NaN lookup which is fine)
    mvEq3Eq6Lower = nextLower([eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1]);
  }

  const mvEq4Lower = nextLower([eq1, eq2, eq3, eq4 + 1, eq5, eq6]);
  const mvEq5Lower = nextLower([eq1, eq2, eq3, eq4, eq5 + 1, eq6]);

  const scoreEq1Lower = CVSS_V4_LOOKUP[mvEq1Lower];
  const scoreEq2Lower = CVSS_V4_LOOKUP[mvEq2Lower];
  let scoreEq3Eq6Lower: number | undefined;
  if (eq3 === 0 && eq6 === 0) {
    const left = CVSS_V4_LOOKUP[mvEq3Eq6LowerLeft!];
    const right = CVSS_V4_LOOKUP[mvEq3Eq6LowerRight!];
    // Upstream uses the higher — NaN-safe
    scoreEq3Eq6Lower = (left ?? -Infinity) > (right ?? -Infinity) ? left : right;
  } else if (mvEq3Eq6Lower !== null) {
    scoreEq3Eq6Lower = CVSS_V4_LOOKUP[mvEq3Eq6Lower];
  }
  const scoreEq4Lower = CVSS_V4_LOOKUP[mvEq4Lower];
  const scoreEq5Lower = CVSS_V4_LOOKUP[mvEq5Lower];

  // Find a max-severity composed vector within the current macrovector.
  const eq1Maxes = getEqMaxes(mv, 1);
  const eq2Maxes = getEqMaxes(mv, 2);
  const eq3Eq6Maxes = getEqMaxes(mv, 3);
  const eq4Maxes = getEqMaxes(mv, 4);
  const eq5Maxes = getEqMaxes(mv, 5);

  const maxVectors: string[] = [];
  for (const a of eq1Maxes)
    for (const b of eq2Maxes)
      for (const c of eq3Eq6Maxes)
        for (const d of eq4Maxes)
          for (const eMax of eq5Maxes) maxVectors.push(a + b + c + d + eMax);

  // Pick the first max-vector where every severity distance is ≥ 0.
  type DistResult = {
    AV: number;
    PR: number;
    UI: number;
    AC: number;
    AT: number;
    VC: number;
    VI: number;
    VA: number;
    SC: number;
    SI: number;
    SA: number;
    CR: number;
    IR: number;
    AR: number;
  };
  let distances: DistResult | null = null;
  for (const max of maxVectors) {
    const d: DistResult = {
      AV: LEVELS.AV[m(metrics, 'AV')] - LEVELS.AV[extractValueMetric('AV', max)],
      PR: LEVELS.PR[m(metrics, 'PR')] - LEVELS.PR[extractValueMetric('PR', max)],
      UI: LEVELS.UI[m(metrics, 'UI')] - LEVELS.UI[extractValueMetric('UI', max)],
      AC: LEVELS.AC[m(metrics, 'AC')] - LEVELS.AC[extractValueMetric('AC', max)],
      AT: LEVELS.AT[m(metrics, 'AT')] - LEVELS.AT[extractValueMetric('AT', max)],
      VC: LEVELS.VC[m(metrics, 'VC')] - LEVELS.VC[extractValueMetric('VC', max)],
      VI: LEVELS.VI[m(metrics, 'VI')] - LEVELS.VI[extractValueMetric('VI', max)],
      VA: LEVELS.VA[m(metrics, 'VA')] - LEVELS.VA[extractValueMetric('VA', max)],
      SC: LEVELS.SC[m(metrics, 'SC')] - LEVELS.SC[extractValueMetric('SC', max)],
      SI: LEVELS.SI[m(metrics, 'SI')] - LEVELS.SI[extractValueMetric('SI', max)],
      SA: LEVELS.SA[m(metrics, 'SA')] - LEVELS.SA[extractValueMetric('SA', max)],
      CR: LEVELS.CR[m(metrics, 'CR')] - LEVELS.CR[extractValueMetric('CR', max)],
      IR: LEVELS.IR[m(metrics, 'IR')] - LEVELS.IR[extractValueMetric('IR', max)],
      AR: LEVELS.AR[m(metrics, 'AR')] - LEVELS.AR[extractValueMetric('AR', max)],
    };
    // Any NaN or negative → not the right max
    const values = Object.values(d);
    if (values.some((v) => Number.isNaN(v) || v < 0)) continue;
    distances = d;
    break;
  }

  // If no valid max found, treat distances as zero (no refinement).
  const sevDistEq1 = distances ? distances.AV + distances.PR + distances.UI : 0;
  const sevDistEq2 = distances ? distances.AC + distances.AT : 0;
  const sevDistEq3Eq6 = distances
    ? distances.VC + distances.VI + distances.VA + distances.CR + distances.IR + distances.AR
    : 0;
  const sevDistEq4 = distances ? distances.SC + distances.SI + distances.SA : 0;
  // EQ5 proportion is always 0 in upstream (max severity depth stays flat), so no sevDistEq5.

  const maxSevEq1 = MAX_SEVERITY.eq1[eq1] * STEP;
  const maxSevEq2 = MAX_SEVERITY.eq2[eq2] * STEP;
  const maxSevEq3Eq6 = (MAX_SEVERITY.eq3eq6[eq3]?.[eq6] ?? 0) * STEP;
  const maxSevEq4 = MAX_SEVERITY.eq4[eq4] * STEP;

  const availEq1 = baseScore - (scoreEq1Lower ?? NaN);
  const availEq2 = baseScore - (scoreEq2Lower ?? NaN);
  const availEq3Eq6 = baseScore - (scoreEq3Eq6Lower ?? NaN);
  const availEq4 = baseScore - (scoreEq4Lower ?? NaN);
  const availEq5 = baseScore - (scoreEq5Lower ?? NaN);

  let nExistingLower = 0;
  let normEq1 = 0;
  let normEq2 = 0;
  let normEq3Eq6 = 0;
  let normEq4 = 0;
  let normEq5 = 0;

  if (!Number.isNaN(availEq1)) {
    nExistingLower++;
    normEq1 = maxSevEq1 > 0 ? availEq1 * (sevDistEq1 / maxSevEq1) : 0;
  }
  if (!Number.isNaN(availEq2)) {
    nExistingLower++;
    normEq2 = maxSevEq2 > 0 ? availEq2 * (sevDistEq2 / maxSevEq2) : 0;
  }
  if (!Number.isNaN(availEq3Eq6)) {
    nExistingLower++;
    normEq3Eq6 = maxSevEq3Eq6 > 0 ? availEq3Eq6 * (sevDistEq3Eq6 / maxSevEq3Eq6) : 0;
  }
  if (!Number.isNaN(availEq4)) {
    nExistingLower++;
    normEq4 = maxSevEq4 > 0 ? availEq4 * (sevDistEq4 / maxSevEq4) : 0;
  }
  if (!Number.isNaN(availEq5)) {
    nExistingLower++;
    // EQ5 proportion is always 0 in upstream (max severity stays flat)
    normEq5 = availEq5 * 0;
  }

  const meanDistance =
    nExistingLower === 0
      ? 0
      : (normEq1 + normEq2 + normEq3Eq6 + normEq4 + normEq5) / nExistingLower;

  let finalScore = baseScore - meanDistance;
  if (finalScore < 0) finalScore = 0;
  if (finalScore > 10) finalScore = 10;
  return Math.round(finalScore * 10) / 10;
}
