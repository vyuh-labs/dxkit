/**
 * THE SIMPLE EXPERIMENT (as it should be): same prompt, two Claude Code sessions
 * — one with dxkit installed, one vanilla — compare full USAGE + outcome.
 * No elaborate scoring. Just: what did each session cost, and what did it do.
 *
 *   naive arm = truly vanilla repo (git clean -fdx → no leftover dxkit)
 *   dxkit arm = dxkit-init'd (skills + graph + AGENTS.md/CLAUDE.md) + onboarding
 *
 * Captures per session: cost, input/output/cache tokens, turns, wall-min,
 * whether it actually USED dxkit (skills/commands), and #edits — from the real
 * `claude -p --output-format stream-json` trace (saved per run).
 *
 * Run: ANTHROPIC_API_KEY=… node bench-sessions.mjs --config <cfg> --out <json>
 *   config.prompts = [{name, prompt}, ...]
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
const REPO = config.repoDir, PIN = config.pinnedCommit, MODEL = config.model || 'claude-sonnet-4-6';
const SCAFFOLD = config.scaffold || `${REPO}-scaffold`;
const GRAPH_BAK = config.graphBak || '/tmp/dxkit-bench-graph.json';
const ONBOARDING = config.onboarding; // optional path to the onboarding md to drop in
const OUT = args.out || 'agent-results-sessions.json';

function sh(cmd, cwd, t = 300000) { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: t, maxBuffer: 96 * 1024 * 1024 }); }

function resetRepo(arm) {
  sh(`git reset --hard ${PIN} >/dev/null 2>&1 && git clean -fdxq`, REPO);
  if (arm === 'dxkit') {
    execSync(`cp -r ${SCAFFOLD}/.claude ${REPO}/ && cp ${SCAFFOLD}/AGENTS.md ${SCAFFOLD}/CLAUDE.md ${REPO}/ 2>/dev/null || true`, { shell: '/bin/bash' });
    fs.mkdirSync(path.join(REPO, '.dxkit/reports'), { recursive: true });
    try { fs.copyFileSync(GRAPH_BAK, path.join(REPO, '.dxkit/reports/graph.json')); } catch { /* */ }
    if (ONBOARDING) { try { fs.copyFileSync(ONBOARDING, path.join(REPO, 'DXKIT-ONBOARDING.md')); } catch { /* */ } }
  }
}

function run(arm, promptObj, rep) {
  resetRepo(arm);
  // Clear the passive-hook dedup ledgers so this run's fires are attributable.
  // The 2.11 context-hook injects PreToolUse `additionalContext` SILENTLY — it
  // is NOT an event in the stream-json trace, so the ONLY reliable fire signal
  // is the per-session ledger /tmp/dxkit-context-hook-<sessionId>.json.
  try { for (const f of fs.readdirSync('/tmp')) if (/^dxkit-context-hook-.*\.json$/.test(f)) fs.rmSync(`/tmp/${f}`); } catch { /* */ }
  const traceFile = path.resolve(`sess-trace-${promptObj.name}-${arm}-r${rep}.jsonl`);
  const t0 = Date.now();
  let raw = '';
  try {
    raw = execSync(`claude -p ${shq(promptObj.prompt)} --output-format stream-json --verbose --permission-mode bypassPermissions --model ${shq(MODEL)}`,
      { cwd: REPO, encoding: 'utf8', timeout: 2400000, maxBuffer: 256 * 1024 * 1024, env: process.env });
  } catch (e) { raw = (e.stdout || '').toString(); }
  try { fs.writeFileSync(traceFile, raw); } catch { /* */ }
  let cost = null, turns = null, u = {}, sessionId = null;
  let edits = 0, ranDxkit = false; const skills = new Set(); const filesTouched = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trim(); if (!t.startsWith('{')) continue;
    let j; try { j = JSON.parse(t); } catch { continue; }
    if (j.session_id) sessionId = j.session_id;
    if (j.type === 'result') { cost = j.total_cost_usd ?? cost; turns = j.num_turns ?? turns; u = j.usage || u; }
    if (j.type === 'assistant' && j.message?.content) for (const c of j.message.content) {
      if (c.type !== 'tool_use') continue;
      if (c.name === 'Edit' || c.name === 'Write') edits++;
      if (c.input?.file_path) filesTouched.add(c.input.file_path);
      if (c.name === 'Skill' && /dxkit/.test(JSON.stringify(c.input || {}))) skills.add(c.input?.skill || 'dxkit');
      if (/(vyuh-dxkit|dxkit)\s+(vulnerabilities|health|report|explore|context|baseline|guardrail)/.test(c.input?.command || '')) ranDxkit = true;
    }
  }
  // Passive-hook fire detection via the ledger (the primary 2.11 metric).
  let hookFiles = [];
  if (sessionId) {
    try { hookFiles = JSON.parse(fs.readFileSync(`/tmp/dxkit-context-hook-${sessionId}.json`, 'utf8')); } catch { /* no fire */ }
  }
  const inTok = u.input_tokens || 0, outTok = u.output_tokens || 0;
  const cacheTok = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return {
    prompt: promptObj.name, arm, rep, costUsd: cost, inputTok: inTok, outputTok: outTok, cacheTok,
    totalTok: inTok + outTok + cacheTok, turns, edits, wallMin: +((Date.now() - t0) / 60000).toFixed(1),
    usedDxkit: ranDxkit || skills.size > 0, skills: [...skills],
    sessionId, hookFired: hookFiles.length > 0, hookFireCount: hookFiles.length, hookFiles,
    trace: path.basename(traceFile),
  };
}

const REPS = args.reps ? +args.reps : (config.reps || 1);

function main() {
  const rows = [];
  for (const p of config.prompts) {
    for (const arm of ['naive', 'dxkit']) {
      for (let rep = 1; rep <= REPS; rep++) {
        const r = run(arm, p, rep);
        rows.push(r);
        console.log(`  [${p.name}] ${arm.padEnd(6)} r${rep}/${REPS}  hookFired=${r.hookFired}(${r.hookFireCount})  cost=$${(r.costUsd||0).toFixed(2)}  tok=${r.totalTok}  turns=${r.turns}  edits=${r.edits}  usedDxkit=${r.usedDxkit}${r.skills.length?'('+r.skills.join(',')+')':''}  ${r.wallMin}m`);
        fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
      }
    }
  }
  sh(`git reset --hard ${PIN} >/dev/null 2>&1 && git clean -fdxq`, REPO);
  const med = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const cell = (name, arm) => rows.filter((x) => x.prompt === name && x.arm === arm);
  const medOf = (name, arm, key) => med(cell(name, arm).map((r) => r[key]).filter((v) => v != null));

  console.log(`\n╔═══ SESSION USAGE — median across ${REPS} rep(s), vanilla vs dxkit ═══╗`);
  for (const p of config.prompts) {
    console.log(`\n  ── ${p.name} ──`);
    console.log('  arm     hookFire%  cost     tokens(med)  turns(med)  edits(med)');
    for (const arm of ['naive', 'dxkit']) {
      const c = cell(p.name, arm); if (!c.length) continue;
      const firePct = Math.round(100 * c.filter((r) => r.hookFired).length / c.length);
      console.log(`  ${arm.padEnd(6)}  ${String(firePct + '%').padEnd(9)}  $${String(medOf(p.name, arm, 'costUsd').toFixed(2)).padEnd(6)} ${String(medOf(p.name, arm, 'totalTok')).padEnd(11)}  ${String(medOf(p.name, arm, 'turns')).padEnd(10)}  ${medOf(p.name, arm, 'edits')}`);
    }
  }
  // Aggregate: the headline 2.11 metrics. Hook-fire rate (mechanism), then
  // the per-finding overhead (dxkit − naive) on this SMALL-repo target — the X
  // in the "small-repo overhead vs large-repo savings" asymmetry. Median across
  // reps tames per-session LLM variance.
  const dx = rows.filter((r) => r.arm === 'dxkit');
  const fireRate = dx.length ? Math.round(100 * dx.filter((r) => r.hookFired).length / dx.length) : 0;
  console.log('\n╔═══ HEADLINE ═══╗');
  console.log(`  Hook-fire rate (dxkit arm): ${fireRate}%  (${dx.filter((r) => r.hookFired).length}/${dx.length} sessions)`);
  for (const key of ['totalTok', 'turns', 'costUsd']) {
    const ds = config.prompts.map((p) => ({ name: p.name, naive: medOf(p.name, 'naive', key), dxkit: medOf(p.name, 'dxkit', key) }));
    const wins = ds.filter((d) => d.dxkit < d.naive).length, ties = ds.filter((d) => d.dxkit === d.naive).length;
    console.log(`  ${key}: naive med ${med(ds.map((d) => d.naive))} vs dxkit med ${med(ds.map((d) => d.dxkit))}  · dxkit lower in ${wins}/${ds.length} (ties ${ties})`);
  }
  console.log('  (per-cell medians above; raw per-session rows in the output JSON. Run summarize-overhead.mjs for the overhead decomposition.)');
}

function shq(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }
function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) { const k = a[i].slice(2); o[k] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; } } return o; }

main();
