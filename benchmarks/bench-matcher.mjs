/**
 * Benchmark #2 - Matcher robustness under drift (deterministic, no API key).
 *
 * The foundation under the guardrail: a finding's identity must survive
 * mechanical churn (reformat, line-shifts, file renames) so the gate doesn't
 * cry "net-new!" at code that didn't actually change. A noisy matcher → false
 * blocks → teams disable dxkit, so this number IS the adoption risk, quantified.
 *
 * Method: baseline the target, apply a transform that introduces NO new finding,
 * re-run the guardrail. Any net-new verdict is a FALSE REGRESSION (matcher miss).
 *
 * Output per transform: { blocked, netNew } - both should be 0 / false.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DXKIT, BENCH_MODE, sh, resetTo, saveBaseline, restoreBaseline, createBaseline, guardrailExitCode } from './lib.mjs';

function sourceFiles(repoDir) {
  try {
    return sh(`git ls-files '*.js' '*.ts' | head -200`, repoDir)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const TRANSFORMS = [
  {
    name: 'line-shift (+3 comment lines per file)',
    apply(repoDir) {
      for (const f of sourceFiles(repoDir)) {
        const abs = path.join(repoDir, f);
        const banner = '// dxkit-bench\n// drift\n// shim\n';
        fs.writeFileSync(abs, banner + fs.readFileSync(abs, 'utf8'));
      }
    },
  },
  {
    name: 'file-rename (move a few source files)',
    apply(repoDir) {
      const files = sourceFiles(repoDir).slice(0, 5);
      for (const f of files) {
        const moved = f.replace(/(\.[jt]s)$/, '.renamed$1');
        try {
          sh(`git mv ${JSON.stringify(f)} ${JSON.stringify(moved)} 2>/dev/null || mv ${JSON.stringify(f)} ${JSON.stringify(moved)}`, repoDir);
        } catch {
          /* skip files that can't move */
        }
      }
    },
  },
];

function netNewCount(repoDir) {
  // Prefer a structured verdict if the guardrail exposes JSON; else fall back
  // to exit code only (netNew unknown → reported as null).
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

export function runMatcherBench(config) {
  const repoDir = config.repoDir;
  const tmpBase = path.join(repoDir, '..', '_baseline_matcher.json');

  resetTo(repoDir, config.pinnedCommit);
  const baseline = createBaseline(repoDir);
  saveBaseline(repoDir, tmpBase);

  const results = [];
  for (const t of TRANSFORMS) {
    resetTo(repoDir, config.pinnedCommit);
    restoreBaseline(repoDir, tmpBase);
    t.apply(repoDir);
    sh(`git add -A 2>/dev/null || true`, repoDir);
    // Commit the transform so dxkit's git-aware line/rename relocation can
    // diff baseline-commit → HEAD. Staging alone leaves only the content
    // fingerprint's ±2-line fuzz, which a +3-line insertion exceeds - a
    // benchmark-harness artifact, not a matcher miss. The isolation +
    // guardrail benches already commit their changes; this matches them
    // (and the real CI/PR flow the matcher models).
    sh(`git -c user.email=bench@dxkit -c user.name=bench commit -qm ${JSON.stringify('matcher-transform: ' + t.name)} 2>/dev/null || true`, repoDir);
    const code = guardrailExitCode(repoDir);
    results.push({ transform: t.name, blocked: code !== 0, netNew: netNewCount(repoDir) });
  }
  resetTo(repoDir, config.pinnedCommit);

  const falseRegressions = results.filter((r) => r.blocked).length;
  return { baseline, falseRegressionRate: falseRegressions / results.length, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = JSON.parse(fs.readFileSync(process.argv[2] || 'pilot.json', 'utf8'));
  console.log(JSON.stringify(runMatcherBench(config), null, 2));
}
