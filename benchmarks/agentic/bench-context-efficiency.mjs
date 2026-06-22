/**
 * DETERMINISTIC context-efficiency benchmark (no LLM, fully reproducible).
 *
 * Claim under test: to understand a finding in context, an agent reads the
 * surrounding code; dxkit instead hands it a structural slice. How much smaller
 * is dxkit's context than what the agent would otherwise read — and how does it
 * scale with file size? (Saving is the whole point on large brownfield repos.)
 *
 * Per finding: wholeFileTokens (what the agent reads to see the finding in
 * context) vs dxkitContextTokens (`dxkit context file:line`). This is a
 * CONSERVATIVE lower bound — real agents also grep + read caller files, which
 * would inflate the baseline further; dxkit's slice already includes the
 * cross-file blast radius.
 *
 * Usage: node bench-context-efficiency.mjs <detailed-scan.json> <repoDir> [sampleN]
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const [scanPath, repoDir, sampleArg] = process.argv.slice(2);
const SAMPLE = Number(sampleArg || 120);
const DXKIT = `node ${path.resolve('../../dist/index.js')}`;
const tok = (s) => Math.round(s.length / 4); // ~4 chars/token

const raw = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
const found = [];
(function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach(walk);
  if (typeof n.file === 'string' && typeof n.rule === 'string' && typeof n.fingerprint === 'string' &&
      (n.category || n.kind) !== 'dep-vuln') {
    found.push({ rule: n.rule, file: n.file, line: n.line || 1, fp: n.fingerprint });
  }
  for (const v of Object.values(n)) walk(v);
})(raw);

const seen = new Set();
const isSrc = (f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f);
const isExc = (f) => /(^|\/)(test|tests|spec|__tests__|node_modules|dist|build)\//.test(f) || /\.(spec|test)\./.test(f);
let code = found.filter((f) => isSrc(f.file) && !isExc(f.file) && (seen.has(f.fp) ? false : (seen.add(f.fp), true)));

// Sample evenly across the list (deterministic) to bound runtime.
if (code.length > SAMPLE) {
  const step = code.length / SAMPLE;
  code = Array.from({ length: SAMPLE }, (_, i) => code[Math.floor(i * step)]);
}
console.log(`Measuring ${code.length} real code findings (of the full set) in ${repoDir}…`);

const rows = [];
for (const f of code) {
  const abs = path.join(repoDir, f.file);
  let fileTok = 0, loc = 0;
  try { const t = fs.readFileSync(abs, 'utf8'); fileTok = tok(t); loc = t.split('\n').length; } catch { continue; }
  let ctxTok = 0;
  try {
    const out = execSync(`${DXKIT} context ${JSON.stringify(f.file + ':' + f.line)}`, { cwd: repoDir, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    ctxTok = tok(out);
  } catch { ctxTok = 0; }
  if (!ctxTok) continue;
  rows.push({ file: f.file, loc, fileTok, ctxTok, ratio: +(fileTok / ctxTok).toFixed(2), saved: fileTok - ctxTok });
}

const med = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const bucket = (loc) => (loc <= 100 ? '≤100 LOC' : loc <= 300 ? '101-300' : loc <= 700 ? '301-700' : '>700 LOC');
console.log(`\n── Context size: whole-file read vs dxkit slice (n=${rows.length}) ──`);
console.log('  bucket       n   med file-tok   med dxkit-tok   med ratio   dxkit smaller?');
for (const bk of ['≤100 LOC', '101-300', '301-700', '>700 LOC']) {
  const r = rows.filter((x) => bucket(x.loc) === bk);
  if (!r.length) continue;
  const smaller = Math.round(100 * r.filter((x) => x.ctxTok < x.fileTok).length / r.length);
  console.log(`  ${bk.padEnd(10)} ${String(r.length).padStart(3)}   ${String(med(r.map(x=>x.fileTok))).padStart(10)}   ${String(med(r.map(x=>x.ctxTok))).padStart(12)}   ${String(med(r.map(x=>x.ratio))+'x').padStart(8)}   ${smaller}%`);
}
const totFile = rows.reduce((s, x) => s + x.fileTok, 0), totCtx = rows.reduce((s, x) => s + x.ctxTok, 0);
console.log(`\n  ALL n=${rows.length}: median ratio ${med(rows.map(x=>x.ratio))}x · ` +
  `dxkit smaller in ${Math.round(100*rows.filter(x=>x.ctxTok<x.fileTok).length/rows.length)}% of findings`);
console.log(`  Aggregate (review all sampled findings): whole-file read ${totFile} tok vs dxkit ${totCtx} tok → ` +
  `${totFile?Math.round(100*(totFile-totCtx)/totFile):0}% less context`);
fs.writeFileSync('context-efficiency-results.json', JSON.stringify(rows, null, 2));
