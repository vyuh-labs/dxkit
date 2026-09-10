/**
 * The advisory decision PR's body renderer, split out of `refresh.ts` purely
 * for module size (the lane's orchestration stays there; `refresh.ts`
 * re-exports this so consumers keep one import surface).
 *
 * Since #389 the body tells the two hold-out populations apart: advisories
 * NEW this refresh and advisories STILL PENDING from an earlier one (the
 * decision branch carried them; their expiry is the original). A pending
 * advisory is never presented as newly published again.
 */
import type { AllowlistEntry } from '../allowlist/file';
import type { HeldOutAdvisory } from './refresh-holdout';

function plural(n: number): string {
  return `advisor${n === 1 ? 'y' : 'ies'}`;
}

/** The decision PR's body: the advisory table + the two lanes, stated once. */
export function decisionPrBody(
  heldOut: ReadonlyArray<HeldOutAdvisory>,
  entries: ReadonlyArray<AllowlistEntry>,
): string {
  const expiryByFp = new Map(entries.map((e) => [e.fingerprint, e.expiresAt ?? '—']));
  const fresh = heldOut.filter((a) => a.pendingSince === undefined);
  const pending = heldOut.filter((a) => a.pendingSince !== undefined);
  const row = (a: HeldOutAdvisory): string =>
    `| ${a.package}${a.installedVersion ? `@${a.installedVersion}` : ''} | ${a.advisoryId} | ` +
    `\`${a.fingerprint}\` | ${a.pendingSince === undefined ? 'new this refresh' : `pending since ${a.pendingSince}`} | ` +
    `${expiryByFp.get(a.fingerprint) ?? '—'} |`;
  const firstRaised = pending.map((a) => a.pendingSince!).sort()[0];
  const heading =
    fresh.length > 0
      ? `## ${fresh.length} newly published ${plural(fresh.length)} need${fresh.length === 1 ? 's' : ''} a decision` +
        (pending.length > 0 ? ` (${pending.length} still pending)` : '')
      : `## ${pending.length} ${plural(pending.length)} still pending a decision`;
  const summary = [
    fresh.length > 0
      ? `**New this refresh (${fresh.length}):** published to the feed after the previous capture.`
      : '**New this refresh: none.**',
    pending.length > 0
      ? `**Still pending (${pending.length}, first raised ${firstRaised}):** held out by an earlier ` +
        'refresh and not decided yet; their deferral windows are unchanged.'
      : '',
  ].filter(Boolean);
  return [
    heading,
    '',
    'The scheduled baseline refresh found dependency advisories published to the feed AFTER',
    'the previous capture, on a tree whose diff touched no dependency manifest — nobody in',
    'this repo introduced them. They were **held out of the refreshed baseline** (never',
    'silently grandfathered), so they gate every PR by the advisory tier until this repo',
    'decides:',
    '',
    ...summary,
    '',
    '| Package | Advisory | Fingerprint | Status | Defer expires |',
    '|---|---|---|---|---|',
    ...fresh.map(row),
    ...pending.map(row),
    '',
    '**Lane 1 — fix (preferred):** upgrade or patch the affected dependencies and merge that',
    'change; the next refresh absorbs the resolution and this PR becomes obsolete.',
    '',
    '**Lane 2 — defer, time-boxed:** MERGE THIS PR. It adds `category=deferred` allowlist',
    'entries that clear the gate now and EXPIRE on the dates above — the findings re-block',
    'when the window lapses, which is the forcing function back into the fix lane.',
    '',
    'Closing this PR without fixing re-raises it on the next scheduled refresh — a live',
    'advisory never goes silent.',
    '',
    '🤖 raised by `vyuh-dxkit baseline refresh` (the D4 advisory decision lane)',
  ].join('\n');
}
