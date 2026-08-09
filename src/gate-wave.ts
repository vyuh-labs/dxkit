/**
 * `vyuh-dxkit gate <dir> --workspace` — the estate WAVE gate
 * (4.4.0 WP7 / P2-6): judge N member trees as ONE composition.
 *
 * Members are the workspace directory's immediate subdirectories
 * (dot-dirs and the `--flows` directory excluded), each judged by the
 * ONE engine as its own fresh-prior tree gate (fold of member
 * verdicts), plus the WAVE layer: each member's flow model — gathered
 * through the policy-aware per-member arm, never merged prematurely —
 * composed into one served mesh, evaluated by the pure wave evaluator
 * (`src/analyzers/flow/wave.ts`) for unresolved calls, dead routes,
 * and broken declared flows (`flow.v1` documents from `--flows <dir>`).
 *
 * ONE wave verdict: blocked if any member blocks or any wave finding
 * blocks; cannot_gate if any member refuses (and nothing blocks);
 * else passed. Same 0/1/2 exit contract as the single-tree gate.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WireFlow, WireVerdictCheck, WireVerdictDoc } from '@vyuhlabs/dxkit-sdk';
import { evaluateWaveGate, type WaveGateResult } from './analyzers/flow/wave';
import { gatherFlowModel } from './analyzers/flow/gather';
import { readFlowConfig } from './analyzers/flow/config';
import type { RepoFlowModel } from './analyzers/flow/model';
import { describeBrokenIntegration } from './analyzers/flow/gate';
import { VERSION } from './constants';
import { policyContentHash } from './baseline/policy';
import { runGateCommand, type GateCommandOutcome } from './gate-cli';

export interface WaveCommandOptions {
  /** Directory of `flow.v1` documents (or bare `{id, steps}` files). */
  readonly flowsDir?: string;
  readonly policyPath?: string;
  readonly trusted?: boolean;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

export interface WaveMemberOutcome {
  readonly name: string;
  readonly outcome: GateCommandOutcome;
}

export interface WaveCommandOutcome {
  readonly exitCode: 0 | 1 | 2;
  readonly verdict: 'passed' | 'blocked' | 'cannot_gate';
  readonly members: ReadonlyArray<WaveMemberOutcome>;
  readonly wave: WaveGateResult;
  /** Flow documents that could not be parsed — disclosed, never silent. */
  readonly malformedFlowDocs: ReadonlyArray<{ readonly file: string; readonly error: string }>;
  readonly flowCount: number;
}

/** Read every declared flow from the `--flows` directory. Accepts a
 *  `flow.v1` document, a bare array of flows, or a single bare
 *  `{id, steps}` object per file. Unreadable files are DISCLOSED. */
export function readDeclaredFlows(flowsDir: string): {
  flows: WireFlow[];
  malformed: Array<{ file: string; error: string }>;
} {
  const flows: WireFlow[] = [];
  const malformed: Array<{ file: string; error: string }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(flowsDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    return { flows, malformed: [{ file: flowsDir, error: (err as Error).message }] };
  }
  for (const name of entries.sort()) {
    const file = path.join(flowsDir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      const candidates: unknown[] = Array.isArray(raw)
        ? raw
        : raw !== null &&
            typeof raw === 'object' &&
            Array.isArray((raw as { flows?: unknown }).flows)
          ? ((raw as { flows: unknown[] }).flows ?? [])
          : [raw];
      for (const c of candidates) {
        const flow = c as { id?: unknown; steps?: unknown };
        if (typeof flow.id === 'string' && Array.isArray(flow.steps)) {
          flows.push(c as WireFlow);
        } else {
          malformed.push({ file, error: 'entry lacks a string `id` + `steps` array' });
        }
      }
    } catch (err) {
      malformed.push({ file, error: (err as Error).message });
    }
  }
  return { flows, malformed };
}

/** Discover wave members: immediate subdirectories, dot-dirs and the
 *  flows dir excluded. Disclosed in the verdict — never inferred silently. */
export function discoverMembers(dir: string, flowsDir?: string): string[] {
  const flowsAbs = flowsDir !== undefined ? path.resolve(flowsDir) : undefined;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => path.resolve(dir, name) !== flowsAbs)
    .sort();
}

/** Wave URL semantics: an absolute URL's host joins the mesh namespace. */
function stripAbsoluteHost(rawUrl: string): string | null {
  const m = rawUrl.match(/^https?:\/\/[^/]+(\/.*)?$/i);
  if (!m) return null;
  return m[1] && m[1].length > 0 ? m[1] : '/';
}

/** Workspace-relative identity: prefix every locator with the member name. */
function prefixMemberFiles(name: string, model: RepoFlowModel): RepoFlowModel {
  const pre = (f: string): string => `${name}/${f}`;
  return {
    ...model,
    calls: model.calls.map((c) => ({ ...c, file: pre(c.file) })),
    routes: model.routes.map((r) => ({ ...r, file: pre(r.file) })),
    bindings: model.bindings.map((b) => ({
      ...b,
      call: { ...b.call, file: pre(b.call.file) },
      route: b.route ? { ...b.route, file: pre(b.route.file) } : b.route,
    })),
    dynamicCalls: model.dynamicCalls.map((d) => ({ ...d, file: pre(d.file) })),
  };
}

export async function runWaveCommand(
  dir: string,
  options: WaveCommandOptions = {},
): Promise<WaveCommandOutcome> {
  const root = path.resolve(dir);
  const flowsDir =
    options.flowsDir !== undefined ? path.resolve(root, options.flowsDir) : undefined;
  const memberNames = discoverMembers(root, flowsDir);
  if (memberNames.length === 0) {
    throw new Error(
      `gate --workspace: no member directories found under ${root} ` +
        `(members are immediate subdirectories; dot-dirs and the --flows dir are excluded).`,
    );
  }

  // Fold layer 1: each member through the ONE engine (fresh prior), the
  // wave's DoD policy applied uniformly.
  const members: WaveMemberOutcome[] = [];
  for (const name of memberNames) {
    const outcome = await runGateCommand(path.join(root, name), {
      ...(options.policyPath !== undefined ? { policyPath: options.policyPath } : {}),
      ...(options.trusted !== undefined ? { trusted: options.trusted } : {}),
      ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
    });
    members.push({ name, outcome });
  }

  // Fold layer 2: the wave itself. Per-member flow models via the RAW
  // explicit-config arm — the documented use for callers composing repos
  // themselves: each member's OWN flow config applies (the
  // stripUrlPrefixes class), plus the wave's host-strip rewrite (an
  // absolute URL joins the mesh namespace — the composition judges every
  // called host as potentially estate-internal; a genuinely external
  // call that stays unresolved is visible + allowlistable). Files are
  // prefixed with the member name so fingerprints are WORKSPACE-relative
  // (environment-independent AND member-unique — Rule 9).
  const waveMembers = [];
  for (const name of memberNames) {
    const memberRoot = path.join(root, name);
    const config = readFlowConfig(memberRoot);
    // The wave IS a multi-repo composer — the documented raw-arm class
    // (two-ref gate / cross-repo publish / this) — supplying each
    // member's OWN config explicitly (readFlowConfig above).
    const model = await gatherFlowModel({
      roots: [memberRoot],
      specs: config.specs.map((spec: string) => path.resolve(memberRoot, spec)),
      stripUrlPrefixes: config.stripUrlPrefixes,
      sources: config.sources,
      sourcesBase: memberRoot,
      relativeTo: memberRoot,
      rewriteUrl: stripAbsoluteHost,
    });
    waveMembers.push({ name, model: prefixMemberFiles(name, model) });
  }
  const declared =
    flowsDir !== undefined ? readDeclaredFlows(flowsDir) : { flows: [], malformed: [] };
  const wave = evaluateWaveGate({ members: waveMembers, flows: declared.flows });

  const anyMemberBlocked = members.some((m) => m.outcome.exitCode === 1);
  const anyMemberRefused = members.some((m) => m.outcome.exitCode === 2);
  let verdict: WaveCommandOutcome['verdict'];
  let exitCode: 0 | 1 | 2;
  if (anyMemberBlocked || wave.blocks) {
    verdict = 'blocked';
    exitCode = 1;
  } else if (anyMemberRefused) {
    verdict = 'cannot_gate';
    exitCode = 2;
  } else {
    verdict = 'passed';
    exitCode = 0;
  }

  return {
    exitCode,
    verdict,
    members,
    wave,
    malformedFlowDocs: declared.malformed,
    flowCount: declared.flows.length,
  };
}

/** Render the wave outcome: human text, or a `verdict.v1` document with
 *  `mode: 'wave'` (member verdicts as checks; wave findings first-class). */
export function renderWaveOutcome(outcome: WaveCommandOutcome, json: boolean): string {
  const policyOfFirst = outcome.members[0]?.outcome.result.policy;
  if (json) {
    const checks: WireVerdictCheck[] = outcome.members.map((m) => ({
      id: `member:${m.name}`,
      status: m.outcome.exitCode === 0 ? 'passed' : m.outcome.exitCode === 1 ? 'failed' : 'skipped',
      ...(m.outcome.exitCode === 2 ? { cause: 'member gate refused (cannot_gate)' } : {}),
    }));
    for (const d of outcome.malformedFlowDocs) {
      checks.push({ id: `flows:${path.basename(d.file)}`, status: 'skipped', cause: d.error });
    }
    const doc: WireVerdictDoc = {
      schema: 'verdict.v1',
      engine: { name: 'dxkit', version: VERSION },
      policy: policyOfFirst
        ? {
            hash: policyContentHash(policyOfFirst),
            ...(policyOfFirst.id !== undefined ? { id: policyOfFirst.id } : {}),
            ...(policyOfFirst.version !== undefined ? { version: policyOfFirst.version } : {}),
          }
        : { hash: '' },
      status: outcome.verdict,
      exitCode: outcome.exitCode,
      mode: 'wave',
      findings: [
        ...outcome.wave.seamFindings.map((f) => ({
          kind: 'flow-binding',
          rule: f.reason,
          file: f.file,
          line: f.line,
          message: `${f.method} ${f.path}`,
          fingerprint: f.id,
          blocking: f.verdict === 'block',
        })),
        ...outcome.wave.flowFindings.map((f) => ({
          kind: 'broken-flow',
          rule: 'flow-incomplete',
          message: `${f.flowId}: ${f.missingSteps.map((s) => `${s.method} ${s.path}`).join(', ')} unresolved`,
          fingerprint: f.id,
          blocking: true,
        })),
      ],
      checks,
      floor: {
        ran: false,
        skippedWithCause: 'wave mode: per-member floors ride each member gate (see member checks)',
      },
      receipt: renderWaveOutcome({ ...outcome }, false),
      meta: {
        members: outcome.wave.members,
        flowsEvaluated: outcome.flowCount,
        malformedFlowSteps: outcome.wave.malformedFlowSteps,
      },
    };
    return JSON.stringify(doc, null, 2);
  }

  const lines: string[] = ['Wave gate — estate composition', ''];
  for (const m of outcome.wave.members) {
    lines.push(`  member ${m.name}: ${m.routes} route(s), ${m.calls} call(s)`);
  }
  for (const m of outcome.members) {
    lines.push(`  member ${m.name}: gate ${m.outcome.verdict} (exit ${m.outcome.exitCode})`);
  }
  if (outcome.wave.seamFindings.length > 0) {
    lines.push('', `Seam findings (${outcome.wave.seamFindings.length}):`);
    for (const f of outcome.wave.seamFindings) {
      lines.push(`  [${f.verdict}] ${describeBrokenIntegration(f)}`);
    }
  }
  if (outcome.wave.flowFindings.length > 0) {
    lines.push('', `Broken flows (${outcome.wave.flowFindings.length}):`);
    for (const f of outcome.wave.flowFindings) {
      lines.push(
        `  [block] ${f.flowId}: ${f.missingSteps.map((s) => `${s.method} ${s.path}`).join(', ')} unresolved (${f.missingSteps.length}/${f.stepCount} steps)`,
      );
    }
  }
  for (const d of outcome.malformedFlowDocs) {
    lines.push('', `Flow doc SKIPPED (${path.basename(d.file)}): ${d.error}`);
  }
  lines.push('', `Wave verdict: ${outcome.verdict.toUpperCase()} (exit ${outcome.exitCode})`);
  return lines.join('\n');
}
