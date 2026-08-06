/**
 * The expiry DECISION surface — one maintained GitHub issue naming the
 * allowlist suppressions whose windows are about to close, who accepted each,
 * and when.
 *
 * # The hole this closes (and the three it does not need to)
 *
 * By the time this runs, three surfaces already warn about an approaching lapse:
 * the guardrail check's console section, its PR comment, and its JSON — every
 * author and reviewer, on every run, for the whole window. What none of them can
 * do is speak when NOBODY OPENS A PR. On the repo that produced this class the
 * deferral was created on the 22nd, the repo went quiet, and the lapse landed on
 * the 29th inside an unrelated 16-file frontend PR whose author had never seen
 * the findings. The person who made the promise was never addressed again; the
 * person who paid was whoever pushed next.
 *
 * So this surface exists for exactly one reason: to reach a named owner with no
 * PR in play. It rides the scheduled refresh (which runs weekly AND on every
 * merge to the default branch), so it needs no new workflow, no new managed
 * artifact, and no new CLI verb.
 *
 * # What it claims, and what it refuses to claim
 *
 * Entry-shaped facts only: fingerprint, kind, category, the severity the
 * reviewer ACKNOWLEDGED at accept time, `addedBy`, the date, the countdown. It
 * does NOT say "2 of these will block" — that projection needs a classification
 * pass the refresh does not run, and the check (which does run one) already
 * makes the claim honestly. Each surface asserts only what it observed.
 *
 * # Load-bearing behaviours
 *
 *   - **One issue, found by marker.** `EXPIRY_NOTICE_MARKER` in the body is the
 *     identity; the title is stable prose. Found → edit. Absent → create.
 *   - **It closes itself.** Nothing lapsing inside the horizon ⇒ close the open
 *     issue. This is not tidiness: an open issue that no longer describes
 *     reality is precisely how a team learns to filter dxkit's issues, which
 *     would silently disable every future notice. The self-close is why the
 *     surface stays trustworthy.
 *   - **Fail-OPEN, always disclosed.** Issues disabled, a token without
 *     `issues: write`, no `gh` — every one of those yields a reported reason and
 *     an unchanged exit. The refresh's contract is capturing the baseline; a
 *     notification that could not be posted must never fail that job (the
 *     `GateFailure` discipline).
 *   - **It never gates.** No verdict, no exit code, no block. The expiry itself
 *     is the forcing function; this only makes it visible earlier.
 *   - **Owners are NAMED, never assigned.** `addedBy` is an email address, and
 *     mapping an email to a GitHub login is a guess — a wrong assignment puts a
 *     stranger's name on someone else's deferral. Naming cannot be wrong.
 *
 * # Horizon
 *
 * The trigger is the ONE shared horizon (`auditAllowlist`, 14 days), not a
 * "before the next scheduled run" computation. A cron next-run calculator is
 * real complexity, and the horizon dominates it for every cadence the product
 * offers (`weekly` = 7d, `daily` = 1d, plus every push to the default branch).
 * The one honest limitation — a custom cron slower than the horizon can deliver
 * the first notice late — is stated in the issue body rather than hidden.
 */

import { auditAllowlist, loadAllowlist, SOON_TO_EXPIRE_DAYS } from '../allowlist/file';
import type { SoonToExpire } from '../allowlist/file';
import { dxkitCli } from '../self-invocation';
import type { Exec } from '../land-refresh';

/** Body marker that identifies dxkit's notice issue. The issue is found by this,
 *  never by title matching, so retitling never orphans one. */
export const EXPIRY_NOTICE_MARKER = '<!-- dxkit-expiry-notice -->';

export type ExpiryNoticeOutcome =
  /** The knob is off — nothing was looked at. */
  | 'disabled'
  /** Nothing expires inside the horizon and no issue was open. */
  | 'nothing-to-report'
  | 'issue-opened'
  | 'issue-updated'
  /** Nothing lapsing any more, so the open issue was closed. */
  | 'issue-closed'
  /** Could not talk to GitHub (no gh, no permission, issues disabled). */
  | 'unavailable';

export interface ExpiryNoticeResult {
  readonly outcome: ExpiryNoticeOutcome;
  /** How many suppressions lapse inside the horizon. */
  readonly lapsing: number;
  readonly issueUrl?: string;
  /** Always populated: why this outcome, in one sentence a refresh log can
   *  print verbatim. Never silent, whichever way it went. */
  readonly note: string;
}

export interface ExpiryNoticeOptions {
  readonly cwd: string;
  readonly exec: Exec;
  readonly now?: Date;
  /** Horizon override; defaults to the shared constant. */
  readonly horizonDays?: number;
  /**
   * The freshly captured finding-id set, when the caller has one (the
   * refresh just re-scanned). A lapsing entry whose fingerprint is ABSENT
   * from it suppresses nothing any more — its finding was FIXED — so it is
   * reported as prunable, never as a returning finding (the notice
   * previously manufactured urgency about completed work: a "lapses in 2
   * days, the finding returns" alarm for an advisory the repo had already
   * fixed). `null`/absent = unknown (no fresh scan in hand) → every entry
   * is treated as live, the fail-open direction.
   */
  readonly currentFindingIds?: ReadonlySet<string> | null;
}

const TITLE_PREFIX = 'dxkit: allowlist suppressions expiring';

function titleFor(count: number): string {
  return `${TITLE_PREFIX} (${count})`;
}

/**
 * The issue body. Pure, so the wording is testable without touching GitHub, and
 * so the same builder can be appended to the standing advisory-decision PR.
 */
export function expiryNoticeBody(
  soon: ReadonlyArray<SoonToExpire>,
  opts: { readonly horizonDays: number; readonly resolved?: ReadonlyArray<SoonToExpire> },
): string {
  const owners = [...new Set(soon.map((s) => s.entry.addedBy).filter(Boolean))];
  const soonest = Math.min(...soon.map((s) => s.daysRemaining));
  const lines: string[] = [
    EXPIRY_NOTICE_MARKER,
    '',
    `**${soon.length} allowlist suppression${soon.length === 1 ? '' : 's'} lapse within ` +
      `${opts.horizonDays} days** (soonest ${soonest === 0 ? 'today' : `in ${soonest} day${soonest === 1 ? '' : 's'}`}).`,
    '',
    'When a window closes, the finding it was holding back returns on the next guardrail run. ' +
      'That is the deferral working as intended — but it should be a decision, not a surprise ' +
      'sprung on whoever opens the next PR.',
    '',
    '| Finding | Kind | Accepted as | Accepted by | Expires | In |',
    '|---|---|---|---|---|---|',
  ];
  for (const { entry, daysRemaining } of soon) {
    lines.push(
      `| \`${entry.fingerprint}\` | ${entry.kind} | ${entry.acknowledgedSeverity ?? entry.category} | ` +
        `${entry.addedBy || '—'} | ${entry.expiresAt} | ${daysRemaining}d |`,
    );
  }
  lines.push('');
  const byDate = new Set(soon.map((s) => s.entry.expiresAt));
  if (soon.length > 1 && byDate.size === 1) {
    lines.push(
      `All ${soon.length} share one expiry, so they return together on ` +
        `${soon[0]!.entry.expiresAt} — not spread out.`,
      '',
    );
  }
  if (opts.resolved && opts.resolved.length > 0) {
    lines.push(
      `**Already resolved (${opts.resolved.length}) — no finding returns when these lapse.** ` +
        'The latest scan no longer contains the finding each of these suppressed (the work ' +
        'was done), so the entry is stale bookkeeping, not a pending surprise. Remove at ' +
        `leisure: \`${dxkitCli('allowlist remove')} --fingerprint <id>\` (or let \`${dxkitCli('allowlist prune')}\` sweep them once expired).`,
      '',
    );
    for (const { entry } of opts.resolved) {
      lines.push(`- \`${entry.fingerprint}\` (${entry.kind}, expires ${entry.expiresAt})`);
    }
    lines.push('');
  }
  lines.push(
    '**Two lanes.**',
    '',
    '1. **Fix them** before the date — then this issue closes itself on the next refresh.',
    `2. **Renew deliberately** if the work genuinely needs longer: ` +
      `\`${dxkitCli('allowlist defer')} --expires +7d\` re-dates the window, and tells you ` +
      `whether anything in the repo can actually close it in that time.`,
    '',
    `Full list and rationales: \`${dxkitCli('allowlist audit')}\`.`,
    '',
    owners.length > 0
      ? `Accepted by: ${owners.join(', ')} — named from each entry's \`addedBy\`, not assigned ` +
          `(dxkit will not guess a GitHub login from an email address).`
      : 'No `addedBy` recorded on these entries.',
    '',
    '---',
    '',
    `_Maintained by \`${dxkitCli('baseline refresh')}\` — one issue, updated in place, closed when ` +
      `nothing is lapsing. It never blocks a build; the expiry is the forcing function. If your ` +
      `refresh cadence is slower than ${opts.horizonDays} days, the first notice can arrive late._`,
  );
  return lines.join('\n');
}

/** The open notice issue's number + url, or null. Found by MARKER, not title. */
function findOpenNotice(exec: Exec): { number: number; url: string } | null {
  const raw = exec(
    'gh',
    ['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,url,body'],
    { allowFail: true },
  ).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Array<{ number: number; url: string; body?: string }>;
    const hit = parsed.find((i) => (i.body ?? '').includes(EXPIRY_NOTICE_MARKER));
    return hit ? { number: hit.number, url: hit.url } : null;
  } catch {
    return null;
  }
}

/**
 * Create / update / close the one notice issue to match what the allowlist
 * currently says. Idempotent: safe to run on every refresh, which is exactly
 * what happens.
 */
export function syncExpiryNotice(opts: ExpiryNoticeOptions): ExpiryNoticeResult {
  const horizonDays = opts.horizonDays ?? SOON_TO_EXPIRE_DAYS;
  const now = opts.now ?? new Date();
  const file = loadAllowlist(opts.cwd);
  const lapsing = file
    ? auditAllowlist(file, { now, soonToExpireDays: horizonDays }).soonToExpire
    : [];
  // Cross-check lapsing entries against the freshest finding set when the
  // caller has one: an entry whose finding no longer EXISTS suppresses
  // nothing — nothing "returns" when it lapses. Alarm only about live
  // findings; stale entries are reported as prunable. Unknown current set
  // (no fresh scan) treats everything as live — fail-open.
  const ids = opts.currentFindingIds ?? null;
  const soon = ids ? lapsing.filter((s) => ids.has(s.entry.fingerprint)) : lapsing;
  const resolved = ids ? lapsing.filter((s) => !ids.has(s.entry.fingerprint)) : [];
  const resolvedNote =
    resolved.length > 0
      ? ` (${resolved.length} other lapsing entr${resolved.length === 1 ? 'y' : 'ies'} already ` +
        `resolved — stale bookkeeping, prunable, no finding returns)`
      : '';

  const existing = findOpenNotice(opts.exec);

  if (soon.length === 0) {
    if (!existing) {
      return {
        outcome: 'nothing-to-report',
        lapsing: 0,
        note: `No live allowlist suppression expires within ${horizonDays} days.${resolvedNote}`,
      };
    }
    // The self-close. A notice that outlives its facts teaches people to ignore
    // the next one.
    exec_close(opts.exec, existing.number);
    return {
      outcome: 'issue-closed',
      lapsing: 0,
      issueUrl: existing.url,
      note:
        `Nothing live lapses within ${horizonDays} days any more — closed the expiry notice ` +
        `(${existing.url}).${resolvedNote}`,
    };
  }

  const body = expiryNoticeBody(soon, { horizonDays, resolved });
  const title = titleFor(soon.length);

  if (existing) {
    const edited = opts.exec(
      'gh',
      ['issue', 'edit', String(existing.number), '--title', title, '--body', body],
      { allowFail: true },
    );
    // `gh issue edit` prints the url on success and nothing on failure.
    if (edited.trim() === '') {
      return {
        outcome: 'unavailable',
        lapsing: soon.length,
        issueUrl: existing.url,
        note:
          `${soon.length} suppression(s) lapse within ${horizonDays} days, but the notice issue ` +
          `could not be updated (no permission / no gh). It is still open: ${existing.url}.`,
      };
    }
    return {
      outcome: 'issue-updated',
      lapsing: soon.length,
      issueUrl: existing.url,
      note: `Updated the expiry notice: ${soon.length} suppression(s) lapse within ${horizonDays} days (${existing.url}).`,
    };
  }

  const created = opts
    .exec('gh', ['issue', 'create', '--title', title, '--body', body], { allowFail: true })
    .trim();
  const url = created.split('\n').filter(Boolean).pop() ?? '';
  if (!url.startsWith('http')) {
    return {
      outcome: 'unavailable',
      lapsing: soon.length,
      note:
        `${soon.length} suppression(s) lapse within ${horizonDays} days, but no issue could be ` +
        `opened — issues may be disabled, or the workflow token lacks \`issues: write\` (grant it ` +
        `by re-running \`${dxkitCli('update')}\` with \`expiryNotice.enabled\` set). The lapse ` +
        `still surfaces on every guardrail check.`,
    };
  }
  return {
    outcome: 'issue-opened',
    lapsing: soon.length,
    issueUrl: url,
    note: `Opened the expiry notice: ${soon.length} suppression(s) lapse within ${horizonDays} days (${url}).`,
  };
}

function exec_close(exec: Exec, issueNumber: number): void {
  exec(
    'gh',
    [
      'issue',
      'close',
      String(issueNumber),
      '--comment',
      'Nothing is lapsing within the horizon any more — closing. dxkit reopens a fresh notice if that changes.',
    ],
    { allowFail: true },
  );
}
