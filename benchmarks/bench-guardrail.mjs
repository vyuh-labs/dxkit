/**
 * Benchmark #1 - Guardrail efficacy (deterministic, no API key).
 *
 * The product's reason to exist: block net-new regressions, pass clean changes,
 * grandfather pre-existing debt. We baseline the target, then apply controlled
 * commits and check the guardrail's verdict, building a confusion matrix:
 *
 *   regression commit (introduces a KNOWN new finding)  → expect BLOCK (exit 1)
 *   clean commit      (changes code, no new finding)    → expect PASS  (exit 0)
 *
 *   TP = regression blocked   FN = regression passed (MISS)
 *   TN = clean passed         FP = clean blocked (false alarm - the adoption killer)
 *
 * Output: { catchRate, falseBlockRate, cases[] }.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sh, resetTo, saveBaseline, restoreBaseline, createBaseline, guardrailExitCode } from './lib.mjs';

function existingSourceFiles(repoDir) {
  try {
    return sh(`git ls-files '*.js'`, repoDir)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Regressions write a NEW file carrying a KNOWN net-new finding (semgrep SAST /
// gitleaks private-key). A private-key block is detected by structure, so -
// unlike the AWS documented example key - it can't be allowlisted away.
const REGRESSIONS = [
  {
    name: 'sast-eval-injection',
    apply(repoDir) {
      fs.writeFileSync(
        path.join(repoDir, 'dxkit_bench_evil.js'),
        'module.exports = (req) => { return eval(req.query.x); };\n', // semgrep: eval
      );
    },
  },
  {
    name: 'sast-command-injection',
    apply(repoDir) {
      fs.writeFileSync(
        path.join(repoDir, 'dxkit_bench_cmd.js'),
        "const cp=require('child_process'); module.exports=(q)=>cp.exec('ls '+q);\n",
      );
    },
  },
  {
    name: 'secret-private-key',
    apply(repoDir) {
      fs.writeFileSync(
        path.join(repoDir, 'dxkit_bench_secret.js'),
        '// embedded credential - gitleaks private-key rule matches the header\n' +
          'const KEY = `-----BEGIN RSA PRIVATE KEY-----\n' +
          'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Q\n' +
          'uKUpRKfFLfRYC9AIKjbJTWit+Cqvj3Fx001wEAQABAkA=\n' +
          '-----END RSA PRIVATE KEY-----`;\nmodule.exports = KEY;\n',
      );
    },
  },
];

// Clean cases churn EXISTING source (a trailing comment) - the realistic shape
// the matcher must survive without crying "net-new". They introduce no finding,
// so the guardrail must PASS.
const CLEANS = [
  {
    name: 'comment-existing-file-A',
    apply(repoDir) {
      const f = existingSourceFiles(repoDir)[0];
      if (!f) throw new Error('no existing source file to churn');
      const abs = path.join(repoDir, f);
      fs.appendFileSync(abs, '\n// dxkit-bench: harmless trailing comment\n');
    },
  },
  {
    name: 'comment-existing-file-B',
    apply(repoDir) {
      const files = existingSourceFiles(repoDir);
      const f = files[Math.min(1, files.length - 1)];
      if (!f) throw new Error('no existing source file to churn');
      const abs = path.join(repoDir, f);
      fs.appendFileSync(abs, '\n// dxkit-bench: another harmless comment\n');
    },
  },
];

export function runGuardrailBench(config) {
  const repoDir = config.repoDir;
  const tmpBase = path.join(repoDir, '..', '_baseline_guardrail.json');

  // Fresh baseline at the pinned commit (mode-locked + pre-flight asserted).
  resetTo(repoDir, config.pinnedCommit);
  const baseline = createBaseline(repoDir);
  saveBaseline(repoDir, tmpBase);

  const cases = [];
  const runOne = (kind, c, expectBlock) => {
    resetTo(repoDir, config.pinnedCommit);
    restoreBaseline(repoDir, tmpBase);
    c.apply(repoDir);
    sh(`git add -A 2>/dev/null || true`, repoDir);
    const code = guardrailExitCode(repoDir);
    const blocked = code !== 0;
    cases.push({
      kind,
      name: c.name,
      expectedBlock: expectBlock,
      blocked,
      correct: blocked === expectBlock,
    });
  };

  for (const c of REGRESSIONS) runOne('regression', c, true);
  for (const c of CLEANS) runOne('clean', c, false);

  resetTo(repoDir, config.pinnedCommit);

  const reg = cases.filter((c) => c.kind === 'regression');
  const clean = cases.filter((c) => c.kind === 'clean');
  const tp = reg.filter((c) => c.blocked).length;
  const fp = clean.filter((c) => c.blocked).length;
  return {
    baseline, // { total, byKind } - proof the prior debt was grandfathered
    catchRate: reg.length ? tp / reg.length : null, // want 1.0
    falseBlockRate: clean.length ? fp / clean.length : null, // want 0.0
    matrix: { tp, fn: reg.length - tp, tn: clean.length - fp, fp },
    cases,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = JSON.parse(fs.readFileSync(process.argv[2] || 'pilot.json', 'utf8'));
  const r = runGuardrailBench(config);
  console.log(JSON.stringify(r, null, 2));
}
