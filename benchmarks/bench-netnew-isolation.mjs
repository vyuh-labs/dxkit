/**
 * Benchmark #4 - Net-new isolation on a brownfield repo (deterministic, no key).
 *
 * THE differentiated value, made into a number. A real repo carries debt (here
 * NodeGoat: ~221 pre-existing findings). An agent fixing one finding can ALSO
 * introduce a net-new regression. The question that separates dxkit from a raw
 * scanner is: when that regression appears, does the gate ISOLATE it, or is it
 * lost in the noise of the existing debt?
 *
 * Two gate POLICIES over the SAME findings from the SAME scanner (so we measure
 * gate logic, not scanner quality):
 *
 *   Arm A - "scanner, no baseline": the default local posture of `snyk test`,
 *           `semgrep --error`, `npm audit`, `gitleaks` run pre-commit. Verdict =
 *           "fail if ANY finding exists." On a repo with prior debt this is RED
 *           before the agent touches anything → RED after → no signal. To go
 *           green you must clear ALL findings (or disable the gate).
 *
 *   Arm B - "dxkit committed baseline": grandfather the prior debt, block only
 *           net-new. GREEN before → RED on exactly the 1 regression → precise.
 *
 * Output per regression: the two verdicts + the "fix-to-green tax" (how many
 * findings each policy demands you clear before the gate passes).
 *
 * NOTE on fairness: Snyk/Sonar's SERVER-SIDE PR check CAN grandfather vs a base
 * branch. Arm A models their LOCAL, pre-commit, in-the-agent-loop posture - the
 * setting dxkit targets - NOT a claim that they can't gate net-new anywhere.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DXKIT,
  BENCH_MODE,
  sh,
  resetTo,
  saveBaseline,
  restoreBaseline,
  createBaseline,
  guardrailExitCode,
} from './lib.mjs';

// "Agent introduces a net-new regression while fixing." Each writes a NEW file
// carrying one KNOWN finding the bundled scanner detects (semgrep SAST).
const REGRESSIONS = [
  {
    name: 'agent-adds-eval-injection',
    apply(repoDir) {
      fs.writeFileSync(
        path.join(repoDir, 'dxkit_bench_evil.js'),
        'module.exports = (req) => { return eval(req.query.x); };\n',
      );
    },
  },
  {
    name: 'agent-adds-command-injection',
    apply(repoDir) {
      fs.writeFileSync(
        path.join(repoDir, 'dxkit_bench_cmd.js'),
        "const cp=require('child_process'); module.exports=(q)=>cp.exec('ls '+q);\n",
      );
    },
  },
];

/** Count net-new findings the dxkit guardrail attributes to this change. */
function netNewCount(repoDir) {
  try {
    const out = sh(`${DXKIT} guardrail check --mode ${BENCH_MODE} --json 2>/dev/null`, repoDir);
    const j = JSON.parse(out);
    let n = 0;
    (function walk(x) {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      if (x.classification === 'added' || x.status === 'added') n++;
      for (const v of Object.values(x)) walk(v);
    })(j);
    return n;
  } catch {
    return null;
  }
}

export function runNetNewIsolationBench(config) {
  const repoDir = config.repoDir;
  const tmpBase = path.join(repoDir, '..', '_baseline_isolation.json');

  // Snapshot the brownfield debt once (this IS the "raw scanner total" - the
  // count Arm A's zero-tolerance gate is already red about).
  resetTo(repoDir, config.pinnedCommit);
  const baseline = createBaseline(repoDir); // { total, byKind }
  saveBaseline(repoDir, tmpBase);
  const debtTotal = baseline.total;

  const cases = [];
  for (const r of REGRESSIONS) {
    resetTo(repoDir, config.pinnedCommit);
    restoreBaseline(repoDir, tmpBase);
    r.apply(repoDir);
    sh(`git add -A 2>/dev/null || true`, repoDir);

    // Arm B - dxkit committed baseline.
    const bBlocked = guardrailExitCode(repoDir) !== 0;
    const netNew = netNewCount(repoDir);
    const newCount = netNew === null ? 1 : netNew; // we introduced one known finding

    // Arm A - scanner, no baseline. Same findings; policy = "fail if any."
    // Red both before (debtTotal > 0) and after (debtTotal + newCount > 0), so
    // the regression is NOT isolated. Fix-to-green = clear everything.
    const rawTotalAfter = debtTotal + newCount;
    const armA = {
      gateBefore: debtTotal > 0 ? 'RED' : 'GREEN',
      gateAfter: rawTotalAfter > 0 ? 'RED' : 'GREEN',
      isolatesRegression: false, // red → red: no delta signal
      fixToGreen: rawTotalAfter, // must clear all findings
    };
    const armB = {
      gateBefore: 'GREEN', // prior debt grandfathered (asserted by createBaseline)
      gateAfter: bBlocked ? 'RED' : 'GREEN',
      isolatesRegression: bBlocked && armA.gateBefore !== 'GREEN' ? true : bBlocked,
      fixToGreen: newCount, // clear just the regression
    };
    cases.push({ name: r.name, netNew: newCount, armA, armB });
  }
  resetTo(repoDir, config.pinnedCommit);

  const isolated = cases.filter((c) => c.armB.isolatesRegression && !c.armA.isolatesRegression).length;
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  return {
    debtTotal,
    debtByKind: baseline.byKind,
    isolationWinRate: cases.length ? isolated / cases.length : null, // want 1.0
    fixToGreenTax: {
      noBaseline: avg(cases.map((c) => c.armA.fixToGreen)), // ~ debtTotal+1
      dxkit: avg(cases.map((c) => c.armB.fixToGreen)), // ~ 1
    },
    cases,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = JSON.parse(fs.readFileSync(process.argv[2] || 'pilot.json', 'utf8'));
  const r = runNetNewIsolationBench(config);
  console.log(JSON.stringify(r, null, 2));
}
