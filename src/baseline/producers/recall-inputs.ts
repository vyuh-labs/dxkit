/**
 * Recall-input resolution for baseline producers (CLAUDE.md Rule 19).
 *
 * A producer's `recallContexts` answers "what determines what this kind can
 * SEE?" by naming the tools whose versions feed each kind. These pure helpers
 * turn a capability's provenance `tool` field into a resolved, drift-stable
 * `RecallContext`. Split out of `producers/index.ts` — the producer registry —
 * so the registry stays a listing of producers, not a home for provenance
 * plumbing (and so it stays under the large-file bar).
 */

import { RECALL_EPOCHS, type RecallContext } from '../recall';
import { buildToolsMap } from '../tool-versions';
import type { BaselineEntry } from '../types';

/** Mirror of the registry's `IdentityKind` (declared here to avoid importing a
 *  value cycle back into `producers/index.ts`). */
type IdentityKind = BaselineEntry['kind'];

/** Split a provenance `tool` field back into individual tool names. A
 *  capability's provenance is a `uniqueJoin(', ')` of every provider that
 *  contributed (e.g. `'gitleaks, grep-secrets'` when both ran), so each name
 *  resolves its own version rather than the joined string being recorded as
 *  one unversioned tool. */
export function splitTools(joined: string | null | undefined): string[] {
  if (!joined) return [];
  return joined
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One `RecallContext` from a set of tool names, resolving each to its
 *  version. `buildToolsMap` handles in-process scanners (`grep-secrets`,
 *  `tls-bypass-registry`), tagging them with the dxkit version so a dxkit
 *  upgrade invalidates the kinds those scanners feed — preserving exactly the
 *  drift semantics the pre-Rule-19 `toolchainHash` had, now per kind. */
export function toolRecall(
  kind: IdentityKind,
  names: readonly string[],
  cwd: string,
): RecallContext {
  return { epoch: RECALL_EPOCHS[kind], inputs: resolveToolInputs(names, cwd) };
}

/**
 * Resolve tool names to versions, dropping the ones that resolve to `unknown`.
 *
 * `unknown` means the name is not a registry tool at all — a builtin like
 * `find` or `git`, which every gather legitimately uses and which `findTool`
 * has no version for. It is a CONSTANT, so it can never discriminate one run
 * from another: as a recall input it is pure noise, and it would pollute the
 * `tools` map that `baseline show` renders (the invariant D143 pinned: no tool
 * in that map reads `unknown`).
 *
 * `present` is kept, deliberately. It means the tool IS installed but its
 * version probe came back empty, and `present -> 8.24.0` on a later run is a
 * real change in what we know about the scanner.
 */
export function resolveToolInputs(names: readonly string[], cwd: string): Record<string, string> {
  const resolved = buildToolsMap([...new Set(names)].sort(), cwd);
  return Object.fromEntries(
    Object.entries(resolved).filter(([, version]) => version !== 'unknown'),
  );
}
