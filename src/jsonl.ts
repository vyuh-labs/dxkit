/**
 * The ONE fail-open JSONL file reader (Rule 2), shared by every append-only
 * ledger surface — the loop Stop-gate ledger and the lane delivery ledger.
 * Policy, in one place: an absent file reads as empty, and a corrupt line is
 * skipped rather than failing the whole read — a ledger is append-only, and
 * one partial write must never blind a summary to every other event. Callers
 * own their own event VALIDATION (schema versions, required fields); this
 * module owns only the line mechanics.
 */
import * as fs from 'fs';

/** Parse every non-empty line of a JSONL file. `[]` when absent/unreadable;
 *  corrupt lines are skipped, never fatal. */
export function readJsonlFile(absPath: string): unknown[] {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // corrupt line — skipped, never fatal
    }
  }
  return out;
}
