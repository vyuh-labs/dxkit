/**
 * Shared fixtures for the recipe-executor tests: minimal work-order
 * builders, a temp fixture repo, and a recording fake exec whose behavior
 * is scripted per command. Everything spawnable is injected, so no test
 * here runs a real package manager or linter.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandOutcome, RunnableCommand } from '../../../src/analyzers/tools/bounded-exec';
import { trustedLocalContext } from '../../../src/analysis-trust';
import type { DepVulnFinding } from '../../../src/languages/capabilities/types';
import type { RecipeExecuteContext } from '../../../src/remediate/recipes/types';
import type {
  WorkOrder,
  WorkOrderEnvelope,
  WorkOrderFinding,
} from '../../../src/remediate/work-orders/types';

export function tempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-recipes-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

export interface ScriptedCall {
  readonly cmd: RunnableCommand;
  readonly cwd: string;
}

export type ExecScript = (cmd: RunnableCommand, cwd: string) => Partial<CommandOutcome> | void;

/** A fake bounded exec: records every call and lets a script override the
 *  default clean outcome (exit 0, empty output) per command. */
export function fakeExec(script?: ExecScript): {
  exec: (cmd: RunnableCommand, cwd: string) => CommandOutcome;
  calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  return {
    calls,
    exec: (cmd, cwd) => {
      calls.push({ cmd, cwd });
      const overrides = script?.(cmd, cwd) ?? {};
      return { available: true, code: 0, output: '', ...overrides };
    },
  };
}

export function makeCtx(
  cwd: string,
  overrides: Partial<RecipeExecuteContext> & { exec: RecipeExecuteContext['exec'] },
): RecipeExecuteContext {
  return {
    cwd,
    trust: trustedLocalContext(),
    queryOsv: async () => [],
    auditDepVulns: async () => [],
    ...overrides,
  };
}

export function makeOrder(
  overrides: Partial<WorkOrder> & Pick<WorkOrder, 'id' | 'class'>,
): WorkOrder {
  return {
    findings: [],
    envelope: { paths: ['package.json', 'package-lock.json'], manifests: true },
    constraints: { install: { bin: 'npm', args: ['ci'] }, forbidden: [] },
    done: { absentIds: [], verifier: 'floor', command: 'x' },
    budget: { turns: 1, minutes: 1, usd: 1, derivation: 'x' },
    tier: 'recipe',
    provenance: { source: 'guardrail-blocking' },
    ...overrides,
  };
}

export function floorFinding(
  id: string,
  pack: string,
  label: string,
  extra?: { specifier?: string; importingFiles?: string[] },
): WorkOrderFinding {
  return {
    kind: 'floor-check',
    id,
    attribution: 'pre-existing',
    evidence: { type: 'floor', pack, label, command: '', ...extra },
  };
}

export function advisoryFinding(
  id: string,
  pkg: string,
  advisoryId: string,
  fixedVersion?: string,
): WorkOrderFinding {
  return {
    kind: 'dep-vuln',
    id,
    attribution: 'deferred',
    evidence: {
      type: 'dep-vuln',
      package: pkg,
      advisoryId,
      ...(fixedVersion !== undefined ? { fixedVersion } : {}),
    },
  };
}

export function lintFinding(
  id: string,
  check: string,
  file: string,
  rule: string,
): WorkOrderFinding {
  return {
    kind: 'custom-check',
    id,
    attribution: 'pre-existing',
    evidence: { type: 'custom-check', check, file, rule, line: 1 },
  };
}

export function depFinding(pkg: string, advisoryId: string): DepVulnFinding {
  return { id: advisoryId, package: pkg, tool: 'test', severity: 'high' };
}

export const ROOT_ENVELOPE: WorkOrderEnvelope = {
  paths: ['package.json', 'package-lock.json'],
  manifests: true,
};
