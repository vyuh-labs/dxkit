/**
 * CLI for `vyuh-dxkit loop ledger [show | summarize | clear]`.
 *
 * A thin renderer over the pure ledger functions. The ledger is an
 * audit trail ("what did the loop do?"), not a dashboard, so the output
 * is deliberately plain text (or `--json` for tooling).
 */
import * as logger from '../logger';
import { clearLedger, readLedger, summarizeLedger, type LedgerEvent } from './ledger';

export interface LoopLedgerOptions {
  readonly json?: boolean;
  /** For `show`: cap to the last N events. */
  readonly limit?: string;
}

function renderEventLine(e: LedgerEvent): string {
  const verdict = e.allowed ? 'PASS ' : 'BLOCK';
  const cont = e.stop_hook_active ? ' (continuation)' : '';
  const nn = e.allowed ? '' : `, ${e.net_new_findings} net-new`;
  return `${e.timestamp}  ${verdict}  guardrail=${e.guardrail_status}${nn}${cont}`;
}

export async function runLoopLedger(
  cwd: string,
  action: string | undefined,
  opts: LoopLedgerOptions,
): Promise<void> {
  const act = action ?? 'show';

  if (act === 'clear') {
    const removed = clearLedger(cwd);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ cleared: removed }) + '\n');
    } else {
      logger.info(removed ? 'Loop ledger cleared.' : 'No loop ledger to clear.');
    }
    return;
  }

  const events = readLedger(cwd);

  if (act === 'summarize') {
    const summary = summarizeLedger(events);
    if (opts.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      return;
    }
    logger.header('Loop ledger summary');
    logger.info(`Total postflights:        ${summary.total}`);
    logger.info(`Allowed (clean stop):     ${summary.allowed}`);
    logger.info(`Blocked completions:      ${summary.blocked}`);
    logger.info(`Net-new findings blocked: ${summary.netNewBlocked}`);
    logger.info(`Repaired after block:     ${summary.repairedAfterBlock}`);
    logger.info(`Unrepaired sessions:      ${summary.unrepairedSessions}`);
    return;
  }

  // Default: show.
  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
  const shown = limit && Number.isFinite(limit) ? events.slice(-limit) : events;
  if (opts.json) {
    process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
    return;
  }
  if (shown.length === 0) {
    logger.info('Loop ledger is empty.');
    return;
  }
  logger.header(`Loop ledger (${shown.length}${limit ? ` of ${events.length}` : ''} events)`);
  for (const e of shown) process.stdout.write(renderEventLine(e) + '\n');
}
