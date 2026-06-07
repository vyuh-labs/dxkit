/**
 * CodeQL on-demand runner.
 *
 * Builds a CodeQL database and runs the per-language security suite,
 * emitting SARIF that flows through the same `parseSarif` → aggregate →
 * graph pipeline as every other ingested engine. This is the
 * open-source / GitHub-Advanced-Security path to interprocedural SAST
 * (the license gate is enforced by `resolveDeepSastEngine`; this module
 * only runs once the caller has cleared it).
 *
 * CodeQL is heavy — a database build plus query evaluation runs for
 * minutes, not seconds. It is intended for CI / on-demand "deep scan",
 * never the pre-push hook (the bundled semgrep tier owns that path).
 *
 * Detection + install go through the canonical tool registry (Rule 1):
 * the runner sets the opt-in env flag so the registry's
 * applicability-guarded `codeql` entry resolves, then calls `findTool`.
 * The arg-builders are pure so the command shape is unit-tested without
 * a (40-minute) real run.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { runDetached } from '../analyzers/tools/runner';
import { parseSarif } from './sarif';
import type { ExternalFinding } from './types';

/** Env flag the opt-in paths (`ingest --codeql`, `tools install codeql`)
 *  set so the registry's applicability-guarded `codeql` entry resolves.
 *  Absent ⇒ CodeQL reports `n/a` and stays out of the default toolchain. */
export const CODEQL_OPTIN_ENV = 'DXKIT_CODEQL';

/** True when CodeQL has been explicitly opted into for this process. */
export function codeqlOptedIn(): boolean {
  return process.env[CODEQL_OPTIN_ENV] === '1';
}

/** Default security query suite for a CodeQL language id. Honors a
 *  per-pack override (`deepSast.codeqlQuerySuite`). */
export function codeqlQuerySuiteFor(lang: string, override?: string): string {
  return override ?? `codeql/${lang}-queries:codeql-suites/${lang}-security-extended.qls`;
}

/** `codeql database create` argv (no shell). */
export function codeqlDbCreateArgs(lang: string, dbPath: string, sourceRoot: string): string[] {
  return [
    'database',
    'create',
    dbPath,
    `--language=${lang}`,
    `--source-root=${sourceRoot}`,
    '--overwrite',
  ];
}

/** `codeql database analyze` argv (no shell). */
export function codeqlAnalyzeArgs(dbPath: string, querySuite: string, sarifPath: string): string[] {
  return [
    'database',
    'analyze',
    dbPath,
    querySuite,
    '--format=sarifv2.1.0',
    `--output=${sarifPath}`,
    '--threads=0',
  ];
}

export interface CodeqlTarget {
  /** CodeQL language id (e.g. `javascript`, `python`, `java`). */
  language: string;
  /** Optional per-pack query-suite override. */
  querySuite?: string;
}

export interface RunCodeqlOptions {
  cwd: string;
  targets: CodeqlTarget[];
  /** DB build + analyze are slow; default 30 min per phase. */
  timeoutMs?: number;
  /** Progress sink (one line per phase); defaults to no-op. */
  onLog?: (msg: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run CodeQL across the requested languages and return the union of
 * findings. Throws when the `codeql` binary isn't installed (with an
 * install hint) so the caller can surface it; a language whose DB build
 * or analysis fails is logged and skipped rather than aborting the rest.
 */
export async function runCodeql(opts: RunCodeqlOptions): Promise<ExternalFinding[]> {
  // Opt in so the registry's guarded entry resolves, then detect via
  // the canonical path (Rule 1) — never a hardcoded binary path.
  process.env[CODEQL_OPTIN_ENV] = '1';
  const status = findTool(TOOL_DEFS.codeql, opts.cwd);
  if (!status.available || !status.path) {
    throw new Error('CodeQL is not installed. Run `vyuh-dxkit tools install codeql` first.');
  }
  const log = opts.onLog ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const out: ExternalFinding[] = [];

  for (const target of opts.targets) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `dxkit-codeql-${target.language}-`));
    const dbPath = path.join(workDir, 'db');
    const sarifPath = path.join(workDir, 'results.sarif');
    try {
      log(`codeql: building database for ${target.language} (this can take minutes)…`);
      const create = await runDetached(
        status.path,
        codeqlDbCreateArgs(target.language, dbPath, opts.cwd),
        { cwd: opts.cwd, timeoutMs },
      );
      if (create.code !== 0) {
        log(
          `codeql: database build failed for ${target.language} (exit ${create.code}) — skipped. ` +
            (create.stderr.split('\n').find((l) => l.trim()) ?? ''),
        );
        continue;
      }
      const suite = codeqlQuerySuiteFor(target.language, target.querySuite);
      log(`codeql: analyzing ${target.language} with ${suite}…`);
      const analyze = await runDetached(status.path, codeqlAnalyzeArgs(dbPath, suite, sarifPath), {
        cwd: opts.cwd,
        timeoutMs,
      });
      if (analyze.code !== 0) {
        log(`codeql: analysis failed for ${target.language} (exit ${analyze.code}) — skipped.`);
        continue;
      }
      let raw = '';
      try {
        raw = fs.readFileSync(sarifPath, 'utf-8');
      } catch {
        raw = '';
      }
      const findings = parseSarif(raw, 'codeql');
      log(`codeql: ${target.language} → ${findings.length} finding(s).`);
      out.push(...findings);
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  return out;
}
