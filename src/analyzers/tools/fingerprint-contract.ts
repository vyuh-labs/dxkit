/**
 * Contract-domain finding identities (Rule 9) — the schemes for findings
 * whose address is a CONTRACT-domain name rather than a code location: a
 * flow binding, a model-schema drift, a structural-duplicate pair, a
 * paired-change rule, a prohibited license. Split from `fingerprint.ts` at
 * the large-file bar (the walk-globs precedent); every scheme still composes
 * the ONE hashing primitive (`computeContentFingerprint`) from there, so
 * this module needs no `createHash` of its own and the "every SHA-1 scheme
 * in one place" contract holds structurally.
 */

import { computeContentFingerprint, lineWindowFor } from './fingerprint';

// ─── Flow-binding identity (the integration gate, Rule 9) ─────────────────────

/**
 * Tool-independent canonical rule for a flow binding — a UI call site's
 * dependency on a served `(method, path)`. Every flow binding shares this
 * constant (like secrets share `SECRET_CANONICAL_RULE`) because the finding is
 * intrinsic ("this component depends on this endpoint"), never a per-tool
 * classification.
 */
export const FLOW_BINDING_CANONICAL_RULE = 'canonical:flow-binding';

/**
 * Durable identity for a flow binding (the `flow-binding` kind — the unit the
 * integration gate grandfathers). A binding IS "this consumer file depends on
 * this `(method, path)`", so identity is exactly that triple — and nothing
 * else. It is fully LINE-INDEPENDENT by construction (no line, no line-window
 * bucket), which is strictly more robust than the v1 line-window scheme: the
 * call can move anywhere in the file, be reformatted, or gain siblings above
 * it, and the binding keeps its identity. Motion within a file simply is not a
 * change to which endpoint the file depends on.
 *
 * Hashes only inputs dxkit derives itself (Rule 9) — the NORMALIZED join key
 * (`GET`, `/articles/{var}`, never a tool's raw URL capture) and the consuming
 * file dxkit read from its own AST pass — so a committed baseline keeps
 * matching when the scan moves to CI. Multiple calls to the same endpoint from
 * one file collapse to one identity, which is correct: the file depends on the
 * endpoint once, however many call sites express it. A pure file rename is
 * relocated by the matcher's whole-file rename pass (the file locator in
 * `entryToLocated`), not by the hash.
 *
 * Deliberately NOT the graph's enclosing symbol: that would couple identity to
 * graphify, and the flow layer is graphify-independent by design. Reusing
 * `computeContentFingerprint` keeps every SHA-1 scheme in this one module.
 */
export function computeFlowBindingFingerprint(method: string, path: string, file: string): string {
  return computeContentFingerprint(FLOW_BINDING_CANONICAL_RULE, file, `${method} ${path}`);
}

// ─── Model-schema-drift identity (the drift gate, Rule 9) ─────────────────────

/**
 * Tool-independent canonical rule for a schema-drift finding. Every drift
 * shares this constant (like secrets and flow bindings) because the finding
 * is intrinsic ("this field of this model changed in this way"), never a
 * per-tool classification.
 */
export const MODEL_SCHEMA_DRIFT_CANONICAL_RULE = 'canonical:model-schema-drift';

/**
 * Durable identity for a schema-drift finding. A model is a CONTRACT-domain
 * entity — its name is its address, the file is where it happens to live
 * today — so identity follows the dep-vuln precedent (`(package, advisory)`,
 * no file) rather than the code-finding one: it is LOCATION-FREE by
 * construction, hashing only `(model, fieldPath, changeClass)`. The finding
 * survives line AND file moves with no matching machinery, and a follow-up
 * commit adjusting the same field cannot dodge an allowlist decision (the
 * before/after values are display metadata, never hashed).
 *
 * Disclosed trade-off (design review): two same-named models in different
 * modules whose same-named field undergoes the same change class in one PR
 * share an identity, so one allowlist entry suppresses both — vanishingly
 * rare, visible in the PR comment's suppressed section, and the
 * accepted-risk decision plausibly covers both. All inputs are
 * dxkit-normalized (Rule 9): the model NAME from dxkit's own AST/spec read,
 * the field name, and the fixed taxonomy class — never a type-checker's
 * rendered text.
 */
export function computeModelSchemaDriftFingerprint(
  model: string,
  field: string | null,
  changeClass: string,
): string {
  return computeContentFingerprint(
    MODEL_SCHEMA_DRIFT_CANONICAL_RULE,
    '',
    `${model}\0${field ?? ''}\0${changeClass}`,
  );
}

// ─── Code-reimplementation identity (the seam gate, Rule 9) ───────────────────

/**
 * Tool-independent canonical rule for a structural-duplicate finding. Every
 * code-reimplementation pair shares this constant — the finding is intrinsic
 * ("these two functions are the same routine written twice"), never a per-tool
 * classification.
 */
export const CODE_REIMPLEMENTATION_CANONICAL_RULE = 'canonical:code-reimplementation';

/** One duplicate anchor's dxkit-derived coordinates. */
export interface DuplicateAnchorLike {
  readonly file: string;
  readonly symbol: string;
  readonly line: number;
}

/**
 * Symmetric-by-construction identity for a structural-duplicate PAIR. The two
 * anchors are sorted into a canonical order (by file, then line-window, then
 * symbol) before hashing, so a pair reported as `(A,B)` and one reported as
 * `(B,A)` produce the same identity. Each anchor's line is bucketed into the
 * shared 3-line window so a small reformat doesn't churn identity. All inputs
 * are dxkit-derived — the graph node's file/symbol/line, never a tool's
 * captured span (Rule 9), so a committed allowlist entry keeps matching when the
 * scan moves to CI.
 */
export function computeCodeReimplementationFingerprint(
  anchorA: DuplicateAnchorLike,
  anchorB: DuplicateAnchorLike,
): string {
  const key = (a: DuplicateAnchorLike) => `${a.file}\0${lineWindowFor(a.line)}\0${a.symbol}`;
  const [first, second] = [key(anchorA), key(anchorB)].sort();
  return computeContentFingerprint(
    CODE_REIMPLEMENTATION_CANONICAL_RULE,
    '',
    `${first}\0\0${second}`,
  );
}

// ─── Prohibited-license identity (the license block rule, Rule 9) ────────────

/**
 * Tool-independent canonical rule for a prohibited-license finding. Every
 * violation shares this constant (the secrets / flow-binding pattern): the
 * finding is intrinsic ("this dependency carries this license"), never a
 * per-tool classification — license-checker, pip-licenses, and a future
 * scanner reporting the same package+license share one identity.
 */
export const PROHIBITED_LICENSE_CANONICAL_RULE = 'canonical:prohibited-license';

/**
 * Durable identity for a prohibited-license finding (the `license` kind).
 * Identity is exactly `(package, licenseType)` — the dep-vuln doctrine: a
 * package is a contract-domain entity whose name is its address. Deliberately
 * NOT the version: a routine bump of a package under the same prohibited
 * license is the same standing violation, so one allowlist decision covers
 * it; the license CHANGING re-mints (that is a new legal fact). All inputs
 * are dxkit-normalized SPDX ids, never a tool's raw text (Rule 9).
 */
export function computeProhibitedLicenseFingerprint(pkg: string, licenseType: string): string {
  return computeContentFingerprint(PROHIBITED_LICENSE_CANONICAL_RULE, '', `${pkg}\0${licenseType}`);
}

// ─── Paired-change identity (the paired-change gate, Rule 9) ─────────────────

/**
 * Tool-independent canonical rule for a paired-change violation. Every
 * violation shares this constant (the secrets / flow-binding pattern) because
 * the finding is intrinsic ("this change touched the `if` side of a declared
 * pairing without touching the `then` side"), never a per-tool classification.
 */
export const PAIRED_CHANGE_CANONICAL_RULE = 'canonical:paired-change';

/**
 * Durable identity for a paired-change violation (the `paired-change` kind —
 * the unit the paired-change gate mints and the allowlist waives). The rule's
 * declared NAME is the whole identity — the custom-check binary doctrine: the
 * rule is the repo's own committed declaration, its name is its address, and
 * one allowlist decision covers the rule however the triggering file set
 * varies. Deliberately NOT the matched file set (churns every time the diff
 * grows a file — an expiring deferral would break mid-iteration) and NOT the
 * globs (editing a committed rule's patterns is policy evolution, not a new
 * violation). Location-free and environment-independent by construction.
 */
export function computePairedChangeFingerprint(check: string): string {
  return computeContentFingerprint(PAIRED_CHANGE_CANONICAL_RULE, '', check);
}

/** Canonical rule for a broken declared flow (4.4.0 WP7 — the wave gate). */
export const BROKEN_FLOW_CANONICAL_RULE = 'canonical:broken-flow';

/**
 * Durable identity for a broken declared flow (the `broken-flow` kind).
 * The declared flow's ID is the whole identity — the paired-change
 * doctrine verbatim: the flow is the estate's own committed declaration,
 * its id is its address, and one allowlist decision covers the flow
 * however the failing STEP set varies (steps churning per iteration must
 * never churn identity). Location-free, environment-independent.
 */
export function computeBrokenFlowFingerprint(flowId: string): string {
  return computeContentFingerprint(BROKEN_FLOW_CANONICAL_RULE, '', flowId);
}
