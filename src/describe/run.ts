/**
 * `vyuh-dxkit describe` CLI orchestration. Zero-write by default: it gathers
 * a repo card and prints it (a terminal summary, or `--json`, or the `--html`
 * contract map) to stdout. Writing the HTML to a file is an explicit opt-in
 * (`--out <file>`); otherwise nothing touches the repo, and the command says
 * so. The pure cores (gather / repo-card / contract-map) are elsewhere; this
 * module owns the I/O only (mirror of `runFlowConsole`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { readVisNetworkBundle } from '../dashboard/vendor';
import { gatherDescribeInput, gatherHolisticGraph } from './gather';
import { buildRepoCard } from './repo-card';
import { buildContractMap } from './contract-map';
import type { RepoCardDoc, LabeledCounts } from './repo-card-schema';

export interface DescribeOptions {
  readonly json?: boolean;
  readonly html?: boolean;
  readonly out?: string;
}

const ZERO_WRITE_LINE = 'Nothing was written to your repo.';

function labelSummary(c: LabeledCounts): string {
  const parts: string[] = [];
  if (c.observed) parts.push(`${c.observed} observed`);
  if (c.derived) parts.push(`${c.derived} derived`);
  if (c.inferred) parts.push(`${c.inferred} inferred`);
  if (c.unknown) parts.push(`${c.unknown} unknown`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** A compact, honest terminal summary of the card. */
export function renderCardSummary(card: RepoCardDoc): string {
  const L: string[] = [];
  const dirty = card.provenance.workingTreeDirty ? ' (dirty)' : '';
  L.push(`${card.stack.name} — ${card.stack.languages.join(', ') || 'unknown stack'}`);
  if (card.stack.framework) L.push(`framework: ${card.stack.framework}`);
  L.push(`at ${card.provenance.branch}@${card.provenance.commitSha}${dirty}`);
  L.push('');
  L.push(`routes:  ${card.flow.routes.total}${labelSummary(card.flow.routes)}`);
  L.push(`calls:   ${card.flow.calls.total}${labelSummary(card.flow.calls)}`);
  L.push(`bindings:${card.flow.bindings.total}${labelSummary(card.flow.bindings)}`);
  L.push(`models:  ${card.models.models.total}${labelSummary(card.models.models)}`);
  L.push('');
  L.push('seams:');
  L.push(`  ${card.flow.unresolvedCalls} call(s) reach no served route (integration gaps)`);
  L.push(`  ${card.flow.unconsumedRoutes} route(s) nothing calls (dead-surface candidates)`);
  if (card.flow.dynamicCalls) L.push(`  ${card.flow.dynamicCalls} dynamic call site(s) (unknown)`);
  if (card.notes.length) {
    L.push('');
    L.push('honesty:');
    for (const n of card.notes) L.push(`  - ${n}`);
  }
  return L.join('\n');
}

export interface DescribeResult {
  /** What to print to stdout (may be empty when an HTML file was written). */
  readonly stdout: string;
  /** Absolute path the HTML was written to, when `--out` was given. */
  readonly wrotePath: string | null;
  readonly zeroWrite: boolean;
}

/**
 * Produce the card + chosen rendering. Pure of process I/O so tests can drive
 * it; the CLI wrapper prints stdout / writes the file / emits the zero-write
 * note. `readBundle` is injected for tests.
 */
export async function runDescribe(
  cwd: string,
  opts: DescribeOptions,
  readBundle: () => string | undefined = readVisNetworkBundle,
): Promise<DescribeResult> {
  const input = await gatherDescribeInput(cwd);
  const card = buildRepoCard(input);

  if (opts.json && !opts.html) {
    return { stdout: JSON.stringify(card, null, 2), wrotePath: null, zeroWrite: true };
  }

  if (opts.html || opts.out) {
    const holistic = await gatherHolisticGraph(cwd);
    const html = buildContractMap({ card, holistic, visNetworkBundle: readBundle() ?? '' });
    if (opts.out) {
      const outPath = path.resolve(cwd, opts.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html);
      return { stdout: '', wrotePath: outPath, zeroWrite: false };
    }
    return { stdout: html, wrotePath: null, zeroWrite: true };
  }

  return { stdout: renderCardSummary(card), wrotePath: null, zeroWrite: true };
}

/** CLI entry: run, print, and emit the zero-write / wrote-file note to stderr. */
export async function describeCli(cwd: string, opts: DescribeOptions): Promise<void> {
  const result = await runDescribe(cwd, opts);
  if (result.stdout) process.stdout.write(result.stdout + '\n'); // slop-ok
  if (result.wrotePath) {
    process.stderr.write(`Wrote contract map to ${result.wrotePath}\n`);
  } else if (result.zeroWrite) {
    process.stderr.write(ZERO_WRITE_LINE + '\n');
  }
}
