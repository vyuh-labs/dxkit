/**
 * Benchmark B — Claude-as-gate vs dxkit-the-gate (needs ANTHROPIC_API_KEY).
 *
 * The real choice when an agent self-assesses "is my change safe to commit?":
 * a DETERMINISTIC gate (dxkit) vs asking an LLM to BE the gate. Same seeded
 * cases the deterministic benches use (eval-inj / cmd-inj / private-key
 * regressions, comment-edit cleans, line-shift + rename churn). The LLM arm
 * gets the diff + the list of KNOWN prior findings and must answer, as strict
 * JSON, whether the change introduces a NET-NEW finding. We score three things
 * the deterministic gate aces by construction:
 *
 *   1. Reproducibility    — flip-rate across K reps (a gate that flip-flops
 *                           isn't a gate). dxkit = 0 by construction.
 *   2. Faithfulness/scale  — accuracy as the grandfathered baseline grows
 *                           (1 → full). LLM recall decays; dxkit is flat-exact.
 *   3. Identity-under-churn — does the LLM call a line-shifted / renamed OLD
 *                           finding net-new? (dxkit relocates exactly post-2.12.)
 *
 * Method note: the seeded cases MUTATE a shared git checkout, so we do all git
 * work FIRST (sequential, per the methodology caveat), capturing each case's
 * diff string + the baseline finding list, then RESET. Every API call runs off
 * the captured strings — zero git mutation during the API loop, so the run is
 * race-free and the API arm can never accidentally explore the working tree.
 *
 * Run: ANTHROPIC_API_KEY=… node bench-llm-gate.mjs <cfg.json> [out.json]
 *   cfg adds (over the shared bench config): { models[], reps, scalePoints[] }
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sh, resetTo, createBaseline, guardrailExitCode, saveBaseline, restoreBaseline } from '../lib.mjs';

// Secret-shaped seed payloads are assembled from fragments at RUNTIME so the
// contiguous trigger only exists in the temp repo the harness scans — never in
// this committed source. (dxkit dogfoods its own gitleaks gate; a literal key
// here would block the commit. Same pattern as the fixtures in the main repo.)
const asm = (...parts) => parts.join('');

// ── seeded cases (mirror bench-guardrail REGRESSIONS/CLEANS + bench-matcher
//    TRANSFORMS; kept co-located so this harness is self-contained, with the
//    same ground-truth the deterministic suite certifies). truthNetNew is what
//    the gate SHOULD say. ──────────────────────────────────────────────────
function existingJs(repoDir) {
  return sh(`git ls-files '*.js'`, repoDir).split('\n').map((s) => s.trim()).filter(Boolean);
}

export const CASES = [
  // Regressions: a genuinely NEW finding lands → a correct gate BLOCKS (netNew=true).
  // Each is backed by a bundled detector (community semgrep / gitleaks); the
  // dxkit arm MEASURES rather than assumes detection, so a class the bundled
  // engine misses (the interprocedural/ingest class) shows up honestly.
  {
    name: 'regression-eval-injection',
    truthNetNew: true,
    apply(repoDir) {
      fs.writeFileSync(path.join(repoDir, 'dxkit_bench_evil.js'),
        'module.exports = (req) => { return eval(req.query.x); };\n');
    },
  },
  {
    name: 'regression-command-injection',
    truthNetNew: true,
    apply(repoDir) {
      fs.writeFileSync(path.join(repoDir, 'dxkit_bench_cmd.js'),
        "const cp=require('child_process'); module.exports=(q)=>cp.exec('ls '+q);\n");
    },
  },
  {
    name: 'regression-function-constructor',
    truthNetNew: true,
    apply(repoDir) {
      fs.writeFileSync(path.join(repoDir, 'dxkit_bench_fn.js'),
        'module.exports = (req) => new Function("return " + req.body.code)();\n');
    },
  },
  {
    name: 'regression-private-key',
    truthNetNew: true,
    apply(repoDir) {
      const begin = asm('-----BEGIN ', 'RSA PRIVATE KEY', '-----');
      const end = asm('-----END ', 'RSA PRIVATE KEY', '-----');
      fs.writeFileSync(path.join(repoDir, 'dxkit_bench_secret.js'),
        '// embedded credential\n' +
        'const KEY = `' + begin + '\n' +
        'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Q\n' +
        'uKUpRKfFLfRYC9AIKjbJTWit+Cqvj3Fx001wEAQABAkA=\n' +
        end + '`;\nmodule.exports = KEY;\n');
    },
  },
  {
    name: 'regression-aws-access-key',
    truthNetNew: true,
    apply(repoDir) {
      // gitleaks aws-access-token rule: AKIA + 16 upper/digit chars.
      const akid = asm('AKIA', '2E0A8F3B244C9986');
      const asecret = asm('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY');
      fs.writeFileSync(path.join(repoDir, 'dxkit_bench_aws.js'),
        'const AWS_ACCESS_KEY_ID = "' + akid + '";\n' +
        'const AWS_SECRET_ACCESS_KEY = "' + asecret + '";\n' +
        'module.exports = { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY };\n');
    },
  },
  {
    name: 'regression-github-token',
    truthNetNew: true,
    apply(repoDir) {
      // gitleaks github-pat rule: ghp_ + 36 alnum.
      const ghtok = asm('ghp', '_1A2b3C4d5E6f7G8h9I0jK1l2M3n4O5p6Q7r8');
      fs.writeFileSync(path.join(repoDir, 'dxkit_bench_gh.js'),
        'const GITHUB_TOKEN = "' + ghtok + '";\n' +
        'module.exports = GITHUB_TOKEN;\n');
    },
  },
  {
    name: 'regression-open-redirect',
    truthNetNew: true,
    apply(repoDir) {
      // express open-redirect: user-controlled value as redirect target.
      fs.writeFileSync(path.join(repoDir, 'dxkit_bench_redir.js'),
        "module.exports = (app) => app.get('/go', (req, res) => res.redirect(req.query.url));\n");
    },
  },
  // Clean: harmless comment churn, no finding → a correct gate PASSES (netNew=false).
  {
    name: 'clean-comment-edit',
    truthNetNew: false,
    apply(repoDir) {
      const f = existingJs(repoDir)[0];
      fs.appendFileSync(path.join(repoDir, f), '\n// dxkit-bench: harmless trailing comment\n');
    },
  },
  // Churn: mechanical drift that RELOCATES existing findings. They are OLD, not
  // net-new → a correct gate PASSES. This is the identity-under-churn case.
  {
    name: 'churn-line-shift',
    truthNetNew: false,
    churn: true,
    apply(repoDir) {
      for (const f of existingJs(repoDir).slice(0, 60)) {
        const abs = path.join(repoDir, f);
        fs.writeFileSync(abs, '// dxkit-bench\n// drift\n// shim\n' + fs.readFileSync(abs, 'utf8'));
      }
    },
  },
  {
    name: 'churn-file-rename',
    truthNetNew: false,
    churn: true,
    apply(repoDir) {
      for (const f of existingJs(repoDir).slice(0, 5)) {
        const moved = f.replace(/(\.js)$/, '.renamed$1');
        sh(`git mv ${JSON.stringify(f)} ${JSON.stringify(moved)} 2>/dev/null || mv ${JSON.stringify(f)} ${JSON.stringify(moved)}`, repoDir);
      }
    },
  },
  // Relocation: cut a PRE-EXISTING (baseline) secret line out of its file and
  // paste it into a new file — a diff-visible move (`-` in the origin, `+` in the
  // new file, NOT a git rename). truthNetNew=false: the finding is old, just
  // moved. dxkit's content-hash matcher grandfathers it; a stateless naive LLM
  // sees `+<secret>` in a new file and false-flags it. This is THE case that
  // separates "holds durable identity" from "judges the diff on its face".
  // Needs ctx.baseFindings; degrades to a no-op (skipped) if none is relocatable.
  {
    name: 'relocation-existing-secret',
    truthNetNew: false,
    relocation: true,
    apply(repoDir, ctx) {
      const cands = (ctx?.baseFindings || []).filter(
        (f) => (f.kind === 'secret' || f.kind === 'code') && f.file && f.line > 0 && /\.(js|ts)$/.test(f.file),
      );
      for (const f of cands) {
        const abs = path.join(repoDir, f.file);
        if (!fs.existsSync(abs)) continue;
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const idx = f.line - 1;
        if (idx < 0 || idx >= lines.length || !lines[idx].trim()) continue;
        const moved = lines[idx];
        lines.splice(idx, 1); // remove from origin (origin file still exists → no rename)
        fs.writeFileSync(abs, lines.join('\n'));
        fs.writeFileSync(path.join(repoDir, 'dxkit_bench_relocated.js'),
          `// relocated from ${f.file}\n${moved}\n`);
        ctx.relocatedFrom = f.file; // record for logging
        return;
      }
      ctx && (ctx.relocationSkipped = true); // no relocatable finding found
    },
  },
];

// Approx public list price ($/Mtok in, $/Mtok out) — tokens are the hard number;
// cost is a convenience rollup.
const PRICE = {
  'claude-sonnet-4-6': [3, 15],
  'claude-opus-4-8': [15, 75],
};

function findingLine(f) {
  return `${f.file}:${f.line ?? '?'} ${f.rule ?? f.kind}${f.kind && f.rule ? ` [${f.kind}]` : ''}`;
}

export function buildPrompt(priorFindings, diff) {
  const list = priorFindings.length
    ? priorFindings.map(findingLine).join('\n')
    : '(none)';
  return (
    'You are a commit gate. Below is a BASELINE of KNOWN pre-existing findings — ' +
    'these are GRANDFATHERED and must NOT be reported. Then a DIFF of a proposed change. ' +
    'Decide whether the diff introduces any NET-NEW security/quality finding that is not ' +
    'already represented in the baseline. A finding that merely MOVED to a different line ' +
    '(because surrounding code shifted) or whose FILE WAS RENAMED is NOT net-new — it is the ' +
    'same grandfathered finding relocated.\n\n' +
    `KNOWN BASELINE FINDINGS (file:line rule [kind]), ${priorFindings.length} total:\n${list}\n\n` +
    `PROPOSED DIFF:\n${diff}\n\n` +
    'Respond with ONLY strict JSON, no prose, no code fence: ' +
    '{"netNew": true|false, "which": ["<short description per net-new finding>"]}'
  );
}

// NAIVE arm — no baseline, no prior-findings list. This is how an LLM gate is
// actually deployed in a loop ("here's my diff, is it safe?"). It exposes the
// LLM's statelessness: on a diff-visible RELOCATION of a pre-existing finding it
// has no way to know the finding is old → false-positive. dxkit grandfathers it.
export function buildNaivePrompt(diff) {
  return (
    'You are a commit gate reviewing a proposed change. You have NO record of any ' +
    'pre-existing issues — judge only the diff below. Does this change introduce a ' +
    'security or quality regression that should BLOCK the commit?\n\n' +
    `PROPOSED DIFF:\n${diff}\n\n` +
    'Respond with ONLY strict JSON, no prose, no code fence: ' +
    '{"netNew": true|false, "which": ["<short description per regression>"]}'
  );
}

export async function callClaude(model, prompt, { retries = 4 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        throw new Error(`retryable ${res.status}`);
      }
      if (!res.ok) throw new Error(`api ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      return { text, usage: j.usage || {} };
    } catch (e) {
      lastErr = e;
      // backoff: 1s, 2s, 4s, 8s. No Date/random in scripts elsewhere, but this
      // is a standalone node harness so timers are fine.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export function parseVerdict(text) {
  // tolerate a stray code fence / leading prose
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { netNew: null, which: [], parseError: true };
  try {
    const j = JSON.parse(m[0]);
    return { netNew: typeof j.netNew === 'boolean' ? j.netNew : null, which: Array.isArray(j.which) ? j.which : [] };
  } catch {
    return { netNew: null, which: [], parseError: true };
  }
}

export function sampleFindings(all, n) {
  if (n >= all.length) return all;
  if (n <= 0) return [];
  // even stride sample so the subset spans the repo, not just the first files
  const step = all.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(all[Math.floor(i * step)]);
  return out;
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const out = process.argv[3] || 'bench-llm-gate.json';
  const repoDir = cfg.repoDir;
  const models = cfg.models || ['claude-sonnet-4-6', 'claude-opus-4-8'];
  const reps = cfg.reps || 5;

  // ── Phase 1: git work (sequential, mutates the shared checkout) ──────────
  resetTo(repoDir, cfg.pinnedCommit);
  createBaseline(repoDir); // writes + pre-flight asserts .dxkit/baselines/main.json
  const tmpBase = path.join(repoDir, '..', '_baseline_llmgate.json');
  saveBaseline(repoDir, tmpBase); // mirror bench-matcher: restore fresh per case so
  // committing the case never entangles the baseline with git tracking (a commit +
  // reset --hard otherwise deletes the untracked baseline, false-blocking later cases)
  const baselineFile = JSON.parse(fs.readFileSync(path.join(repoDir, '.dxkit/baselines/main.json'), 'utf8'));
  const baseFindings = (baselineFile.findings || baselineFile.entries || []).map((f) => ({
    file: f.file, line: f.line, rule: f.rule, kind: f.kind,
  }));
  const fullN = baseFindings.length;
  const scalePoints = (cfg.scalePoints || [1, fullN]).filter((n) => n <= fullN);

  const activeCases = cfg.onlyCases ? CASES.filter((c) => cfg.onlyCases.includes(c.name)) : CASES;
  const capturedDiffs = [];
  for (const c of activeCases) {
    resetTo(repoDir, cfg.pinnedCommit); // preserves .dxkit (baseline) via -e .dxkit
    restoreBaseline(repoDir, tmpBase); // fresh baseline each case (see saveBaseline note)
    const ctx = { baseFindings };
    c.apply(repoDir, ctx);
    if (ctx.relocationSkipped) { console.error(`  [skip] ${c.name} — no relocatable baseline finding`); continue; }
    sh(`git add -A 2>/dev/null || true`, repoDir);
    // Cap the diff so the prompt stays bounded (churn touches many files; the
    // gate only needs to SEE the shape of the change). Full file lists in the
    // baseline still convey scale. EXCLUDE .dxkit/ — the committed baseline
    // artifact is our measurement infrastructure, not part of the developer's
    // proposed change; left in, its huge JSON dominates the byte budget and
    // truncates the actual code diff.
    const diff = sh(`git diff --cached --no-color -- . ':(exclude).dxkit/**' | head -c 24000`, repoDir);
    // dxkit ARM — measured, not assumed. Commit so the git-aware matcher can
    // diff baseline-commit → HEAD (mirrors bench-matcher / the real PR flow),
    // then read the guardrail's deterministic verdict.
    sh(`git -c user.email=bench@dxkit -c user.name=bench commit -qm ${JSON.stringify('llm-gate-case: ' + c.name)} 2>/dev/null || true`, repoDir);
    const dxkitBlocked = guardrailExitCode(repoDir) !== 0;
    const dxkitCorrect = dxkitBlocked === c.truthNetNew;
    capturedDiffs.push({ name: c.name, truthNetNew: c.truthNetNew, churn: !!c.churn, relocation: !!c.relocation, diff, dxkitBlocked, dxkitCorrect });
    console.error(`  [dxkit] ${c.name.padEnd(30)} blocked=${dxkitBlocked} correct=${dxkitCorrect}${ctx.relocatedFrom ? ` (moved from ${ctx.relocatedFrom})` : ''}`);
  }
  resetTo(repoDir, cfg.pinnedCommit);
  const dxkitAcc = capturedDiffs.filter((c) => c.dxkitCorrect).length / capturedDiffs.length;
  console.error(`[git] baseline=${fullN} findings; ${capturedDiffs.length} cases; scalePoints=${JSON.stringify(scalePoints)}; dxkit-arm acc=${Math.round(100 * dxkitAcc)}%`);

  // ── Phase 2: API calls (no git mutation) ────────────────────────────────
  const rows = [];
  // Build the per-(model,case) arm runner so naive + each baseline scale share
  // identical verdict/flip/accuracy bookkeeping.
  const runArm = async (model, cap, scale, prompt, priorCount) => {
    const verdicts = [];
    let inTok = 0, outTok = 0;
    for (let r = 0; r < reps; r++) {
      const { text, usage } = await callClaude(model, prompt);
      inTok += usage.input_tokens || 0;
      outTok += usage.output_tokens || 0;
      verdicts.push(parseVerdict(text).netNew);
    }
    const trues = verdicts.filter((v) => v === true).length;
    const falses = verdicts.filter((v) => v === false).length;
    const modal = trues >= falses;
    const flips = verdicts.filter((v) => v !== null && v !== modal).length;
    const correct = verdicts.filter((v) => v === cap.truthNetNew).length;
    const [pin, pout] = PRICE[model] || [0, 0];
    const row = {
      model, case: cap.name, churn: cap.churn, relocation: !!cap.relocation, truthNetNew: cap.truthNetNew,
      scale, priorCount, reps,
      verdicts, modal, flipRate: +(flips / reps).toFixed(2), accuracy: +(correct / reps).toFixed(2),
      inTok, outTok, costUsd: +((inTok * pin + outTok * pout) / 1e6).toFixed(4),
      dxkitBlocked: cap.dxkitBlocked, dxkitCorrect: cap.dxkitCorrect,
    };
    rows.push(row);
    console.error(
      `  ${model.padEnd(20)} ${cap.name.padEnd(28)} ${String(scale).padStart(6)} ` +
      `acc=${Math.round(100 * row.accuracy)}% flip=${Math.round(100 * row.flipRate)}% ` +
      `verdicts=[${verdicts.map((v) => (v === null ? '?' : v ? 'T' : 'F')).join('')}] $${row.costUsd}`,
    );
    fs.writeFileSync(out, JSON.stringify({ meta: { repoDir, models, reps, scalePoints, fullN }, rows }, null, 2));
    return row;
  };
  for (const model of models) {
    for (const cap of capturedDiffs) {
      // NAIVE arm — no baseline (scale-independent), one block per (model, case).
      await runArm(model, cap, 'naive', buildNaivePrompt(cap.diff), 0);
      // BASELINE-PROVIDED arm — one block per scale point (the steelman: LLM
      // handed the same state dxkit has).
      for (const scale of scalePoints) {
        const prior = sampleFindings(baseFindings, scale);
        await runArm(model, cap, scale, buildPrompt(prior, cap.diff), prior.length);
      }
    }
  }

  // ── Rollups ─────────────────────────────────────────────────────────────
  const byModelScale = {};
  for (const row of rows) {
    const k = `${row.model}@${row.scale}`;
    (byModelScale[k] ||= []).push(row);
  }
  const summary = Object.entries(byModelScale).map(([k, rs]) => ({
    key: k,
    meanAccuracy: +(rs.reduce((a, r) => a + r.accuracy, 0) / rs.length).toFixed(3),
    meanFlipRate: +(rs.reduce((a, r) => a + r.flipRate, 0) / rs.length).toFixed(3),
    anyFlip: rs.some((r) => r.flipRate > 0), // determinism: did the LLM flip on ANY case at this scale?
    churnFalseNetNew: +(rs.filter((r) => r.churn).reduce((a, r) => a + (r.modal === true ? 1 : 0), 0) /
      Math.max(1, rs.filter((r) => r.churn).length)).toFixed(3),
    totalCostUsd: +(rs.reduce((a, r) => a + r.costUsd, 0)).toFixed(4),
  }));
  // dxkit arm is scale-independent — one verdict per case, measured in Phase 1.
  const dxkitArm = {
    accuracy: +(capturedDiffs.filter((c) => c.dxkitCorrect).length / capturedDiffs.length).toFixed(3),
    flipRate: 0, // deterministic by construction
    costUsd: 0, // free per check
    perCase: capturedDiffs.map((c) => ({ case: c.name, blocked: c.dxkitBlocked, correct: c.dxkitCorrect })),
  };
  fs.writeFileSync(out, JSON.stringify({ meta: { repoDir, models, reps, scalePoints, fullN }, dxkitArm, summary, rows }, null, 2));

  console.error('\n=== HEAD-TO-HEAD ===');
  console.error(`  dxkit-gate (any scale)       acc=${Math.round(100 * dxkitArm.accuracy)}% flip=0% cost=$0`);
  for (const s of summary) {
    console.error(`  LLM ${s.key.padEnd(24)} acc=${Math.round(100 * s.meanAccuracy)}% flip=${Math.round(100 * s.meanFlipRate)}%${s.anyFlip ? ' (NONZERO)' : ''} churn-FNN=${Math.round(100 * s.churnFalseNetNew)}% $${s.totalCostUsd}`);
  }
  console.error('\n  dxkit per-case:');
  for (const pc of dxkitArm.perCase) console.error(`    ${pc.case.padEnd(30)} blocked=${pc.blocked} correct=${pc.correct}`);

  // Statefulness highlight: on the relocation case, the naive LLM (no state)
  // should false-flag the moved-but-old finding while dxkit grandfathers it.
  const relCap = capturedDiffs.find((c) => c.relocation);
  if (relCap) {
    const naiveRows = rows.filter((r) => r.relocation && r.scale === 'naive');
    console.error('\n=== STATEFULNESS (relocation case) ===');
    console.error(`  dxkit: blocked=${relCap.dxkitBlocked} (correct=${relCap.dxkitCorrect}; truth=PASS — it is a relocated OLD finding)`);
    for (const r of naiveRows) {
      console.error(`  naive LLM ${r.model.padEnd(20)} flagged-as-regression=${r.modal} (correct=${r.modal === false}) verdicts=[${r.verdicts.map((v) => (v === null ? '?' : v ? 'T' : 'F')).join('')}]`);
    }
  }
  console.error(`\nwrote ${out}`);
}

// Guard: only run the full bench when invoked directly, not when another module
// (e.g. the explain diagnostic) imports the exported helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
