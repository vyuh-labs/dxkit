/**
 * `vyuh-dxkit jobs` — the operability answer to "which jobs run here, when,
 * and did they work?" (4.3.4).
 *
 * One read-only view over the installed dxkit workflows: trigger(s), the
 * actual cron GitHub runs (parsed from the WORKFLOW FILE — the truth of what
 * executes; policy⇄file drift is the parity gate's job, not this view's),
 * the computed next run (UTC), the last run's outcome when the `gh` CLI is
 * available, and the run-it-now command for anything dispatchable.
 *
 * Rows come from the dxkit-owned workflow namespace on disk
 * (`.github/workflows/dxkit-*.yml`), so a future lane appears here the day
 * its workflow is installed — no registry edit, no forgotten row.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

import * as logger from './logger';
import { dxkitCli } from './self-invocation';

export interface JobRow {
  readonly workflow: string;
  /** The workflow's `name:` (falls back to the filename). */
  readonly name: string;
  /** Human trigger list: `cron 0 6 * * *`, `pull_request`, `push`, … */
  readonly triggers: readonly string[];
  /** Crons parsed from `schedule:` (usually 0 or 1). */
  readonly crons: readonly string[];
  /** Next scheduled fire in UTC (`YYYY-MM-DD HH:MM`), when a cron exists. */
  readonly nextRunUtc?: string;
  /** Last run conclusion via `gh` (`success` / `failure` / …); absent when
   *  gh is unavailable or the workflow has never run. */
  readonly lastRun?: { readonly conclusion: string; readonly updatedAt: string };
  /** True when the workflow can be started from the Actions tab / `gh`. */
  readonly dispatchable: boolean;
}

export interface JobsOptions {
  readonly json?: boolean;
  /** Injected for tests: replaces the `gh run list` probe. */
  readonly lastRunProbe?: (workflowFile: string) => JobRow['lastRun'] | undefined;
  /** Injected for tests: the clock `nextRunUtc` computes from. */
  readonly now?: Date;
}

// ── cron (the strict 5-field grammar our own validator allows) ─────────────

/** Expand one cron field into a sorted numeric set. Null = unparseable. */
function expandField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[4] ? Number(m[4]) : 1;
    if (step < 1) return null;
    const lo = m[1] === '*' ? min : Number(m[2]);
    const hi = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : lo;
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Next UTC fire time strictly after `now`, or null when unparseable / none
 * within a year. Standard cron day semantics: when BOTH day-of-month and
 * day-of-week are restricted, a date matching EITHER fires.
 */
export function nextCronFireUtc(cron: string, now: Date): Date | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = expandField(fields[0], 0, 59);
  const hours = expandField(fields[1], 0, 23);
  const doms = expandField(fields[2], 1, 31);
  const months = expandField(fields[3], 1, 12);
  const dows = expandField(fields[4], 0, 7)?.map((d) => d % 7); // 7 == Sunday
  if (!minutes || !hours || !doms || !months || !dows) return null;
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';

  const start = new Date(now.getTime());
  start.setUTCSeconds(0, 0);
  for (let dayOffset = 0; dayOffset <= 366; dayOffset++) {
    const day = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + dayOffset),
    );
    if (!months.includes(day.getUTCMonth() + 1)) continue;
    const domOk = doms.includes(day.getUTCDate());
    const dowOk = dows.includes(day.getUTCDay());
    const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domRestricted ? domOk : dowOk;
    if (!dayOk) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(
          Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m),
        );
        if (t.getTime() > now.getTime()) return t;
      }
    }
  }
  return null;
}

// ── workflow parsing (line-shape, template-grade YAML) ─────────────────────

/** Parse name / triggers / crons / dispatchability from a workflow file. The
 *  files are dxkit-rendered templates, so line-shape parsing is reliable —
 *  and a hand-rewritten file still yields honest trigger names. */
export function parseWorkflow(content: string): {
  name: string | null;
  triggers: string[];
  crons: string[];
  dispatchable: boolean;
} {
  const name = content.match(/^name:\s*(.+)\s*$/m)?.[1]?.trim() ?? null;
  const crons = [...content.matchAll(/-\s*cron:\s*'([^']+)'/g)].map((m) => m[1]);
  const triggers: string[] = [];
  for (const key of ['pull_request', 'push', 'issue_comment', 'workflow_dispatch', 'schedule']) {
    if (new RegExp(`^\\s{2}${key}\\s*:`, 'm').test(content)) {
      triggers.push(
        key === 'schedule' ? (crons.length ? `cron ${crons.join(' | ')}` : 'schedule') : key,
      );
    }
  }
  return { name, triggers, crons, dispatchable: triggers.includes('workflow_dispatch') };
}

function ghLastRun(cwd: string, workflowFile: string): JobRow['lastRun'] | undefined {
  try {
    const out = execFileSync(
      'gh',
      ['run', 'list', '--workflow', workflowFile, '--limit', '1', '--json', 'conclusion,updatedAt'],
      { cwd, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const rows = JSON.parse(out) as Array<{ conclusion: string; updatedAt: string }>;
    const r = rows[0];
    return r?.conclusion ? { conclusion: r.conclusion, updatedAt: r.updatedAt } : undefined;
  } catch {
    return undefined; // gh absent / unauthenticated / no runs — degrade silently
  }
}

const fmtUtc = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');

/** Collect the rows (pure aside from fs + the injectable probes). */
export function collectJobs(cwd: string, opts: JobsOptions = {}): JobRow[] {
  const dir = path.join(cwd, '.github', 'workflows');
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('dxkit-') && (f.endsWith('.yml') || f.endsWith('.yaml')))
      .sort();
  } catch {
    return [];
  }
  const now = opts.now ?? new Date();
  const probe = opts.lastRunProbe ?? ((f: string) => ghLastRun(cwd, f));
  return files.map((file) => {
    const parsed = parseWorkflow(fs.readFileSync(path.join(dir, file), 'utf8'));
    const nexts = parsed.crons
      .map((c) => nextCronFireUtc(c, now))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    const lastRun = probe(file);
    return {
      workflow: file,
      name: parsed.name ?? file,
      triggers: parsed.triggers,
      crons: parsed.crons,
      ...(nexts[0] ? { nextRunUtc: fmtUtc(nexts[0]) } : {}),
      ...(lastRun ? { lastRun } : {}),
      dispatchable: parsed.dispatchable,
    };
  });
}

export function runJobs(cwd: string, opts: JobsOptions = {}): void {
  const rows = collectJobs(cwd, opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ jobs: rows }, null, 2) + '\n');
    return;
  }
  if (rows.length === 0) {
    logger.info(
      `no dxkit workflows installed under .github/workflows/ — ` +
        `run \`${dxkitCli('init --with-ci')}\` (or enable a lane: \`${dxkitCli(
          'policy set depBump.enabled true',
        )}\`)`,
    );
    return;
  }
  logger.header('dxkit jobs — what runs, when (times UTC)');
  const w = Math.max(...rows.map((r) => r.workflow.length)) + 2;
  for (const r of rows) {
    const trigger = r.triggers.join(', ') || '—';
    const next = r.nextRunUtc ? `next ${r.nextRunUtc}` : '';
    const last = r.lastRun ? `last ${r.lastRun.conclusion}` : '';
    const bits = [trigger, next, last].filter(Boolean).join('  ·  ');
    logger.info(`  ${r.workflow.padEnd(w)}${bits}`);
  }
  const dispatchable = rows.filter((r) => r.dispatchable);
  if (dispatchable.length > 0) {
    logger.dim(
      `  run any of these now: ` +
        dispatchable.map((r) => `gh workflow run ${r.workflow}`).join('  |  '),
    );
  }
  logger.dim(
    `  schedules live in .dxkit/policy.json — change one with ` +
      `\`${dxkitCli('policy set <knob> <value>')}\` (workflows re-render automatically)`,
  );
}
