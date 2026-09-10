/**
 * The advisory decision PR's body renderer, split out of `refresh.ts` purely
 * for module size (the lane's orchestration stays there; `refresh.ts`
 * re-exports this so consumers keep one import surface).
 */
import type { AllowlistEntry } from '../allowlist/file';
import type { HeldOutAdvisory } from './refresh';

/** The decision PR's body: the advisory table + the two lanes, stated once. */
export function decisionPrBody(
  heldOut: ReadonlyArray<HeldOutAdvisory>,
  entries: ReadonlyArray<AllowlistEntry>,
): string {
  const expiryByFp = new Map(entries.map((e) => [e.fingerprint, e.expiresAt ?? '—']));
  const rows = heldOut
    .map(
      (a) =>
        `| ${a.package}${a.installedVersion ? `@${a.installedVersion}` : ''} | ${a.advisoryId} | ` +
        `\`${a.fingerprint}\` | ${expiryByFp.get(a.fingerprint) ?? '—'} |`,
    )
    .join('\n');
  return [
    `## ${heldOut.length} newly published advisor${heldOut.length === 1 ? 'y' : 'ies'} need a decision`,
    '',
    'The scheduled baseline refresh found dependency advisories published to the feed AFTER',
    'the previous capture, on a tree whose diff touched no dependency manifest — nobody in',
    'this repo introduced them. They were **held out of the refreshed baseline** (never',
    'silently grandfathered), so they gate every PR by the advisory tier until this repo',
    'decides:',
    '',
    '| Package | Advisory | Fingerprint | Defer expires |',
    '|---|---|---|---|',
    rows,
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
