# Decision record: ABAP pack tooling (4.4.0)

**Status:** decided · **Date:** 2026-08-09 · **Rule:** CLAUDE.md Rule 5
(adopt established tools, never invent parsers) — this record exists
because the ABAP pack was mandated research-first: survey the landscape
and write the decision down BEFORE any pack code.

## Decision

**Adopt abaplint (`@abaplint/cli`, exact-version pinned) as the ABAP
pack's single external tool**, filling BOTH gate roles:

1. **Syntax floor** (`correctness.syntaxCheck`): a minimal abaplint
   config enabling only `parser_error`, `check_syntax`, and
   `cds_parser_error` — catches truncated classes, garbage statements,
   and broken CDS, verified hands-on (a class cut mid-expression yields
   two `Error` findings and exit 1).
2. **Lint gate** (`LanguageSupport.lintGate`, the Rule 17 seam): a
   curated rule config, `-f json` output parsed as LOCATED findings
   (identity = check + file + lineWindow + rule key), so a repo's
   pre-existing backlog grandfathers and a net-new diagnostic gates.

dxkit writes **zero ABAP parsing code** in any outcome. Policy-level
**text rules** (the declarative `pattern` checks shipped in 4.4.0)
remain the escape hatch for consumer-specific patterns the adopted
toolset can't express — never a parallel rule engine.

## Licensing (verified 2026-08-09 — usable)

- `@abaplint/cli` **2.120.19** and `@abaplint/core` **2.120.19** are
  both **MIT** (npm registry metadata; the GitHub repo carries the MIT
  LICENSE). Free for commercial use; Heliconia Labs sells _support_,
  not a license — the software itself is unencumbered.
- `@abaplint/core`'s runtime dependencies are all MIT
  (`fast-xml-parser`, `json5`, `vscode-languageserver-types`).
- dxkit's usage model keeps the posture maximally clean: abaplint is a
  **registry TOOL** (Rule 1) — installed on the user's machine via npm
  at `tools install` time and invoked as a CLI. dxkit never vendors,
  links, or redistributes it — the same arm's-length posture as
  gitleaks (MIT), osv-scanner (Apache-2.0), and semgrep. MIT's only
  obligation (notice preservation) attaches to redistribution, which we
  don't do.
- Hygiene note: the `@abaplint/cli` npm tarball ships no embedded
  LICENSE text (metadata + GitHub only). Irrelevant to our posture; a
  consumer embedding abaplint in their own image should carry the
  notice themselves (their WS6-style review would ask).

## Why abaplint (the evidence)

- **Effectively the only offline ABAP parser that exists.** Everything
  else runs inside a live SAP system (code-pal-for-abap, abapOpenChecks,
  ATC) or is not gate-shaped (abap-cleaner is a formatter). The one
  tree-sitter grammar is experimental (3 stars, no completeness claims).
- **Battle-tested at depth**: maintained by the author of abapGit;
  abapGit's own CI lints every PR with it, and abapGit's unit tests run
  its ~500k-line ABAP codebase on Node through `@abaplint/transpiler` —
  the parser digests a production codebase continuously.
- **Verified hands-on** (fixtures retained in the probe): clean
  three-way exit contract (0 clean / 1 findings / 2 internal error);
  `-f json` emits a machine-readable array (banner on stderr);
  ~1 s / ~144 MB on a package-sized tree — fine for CI containers;
  single 5.1 MB self-contained npm package, Node ≥ 18, fully offline
  after install.

## Declined

- **SAP abap-file-formats** — JSON Schemas for AFF sidecars, no
  standalone CLI, self-described early-phase. abaplint's `aff_and_xml`
  rule covers the overlap. Revisit if a validation CLI ships.
- **tree-sitter-abap** — experimental, incomplete; adopting it would
  put dxkit in the ABAP-grammar business, the exact thing Rule 5 bans.
- **abap-cleaner** — formatter, not a gate.
- **ADT / RFC / ABAP Unit execution** — needs a live ABAP system;
  stays behind the consumer's own executor seam (their phase D), per
  the spec's own division of labor.

## Gotchas the pack MUST build around (all verified)

1. **No semver upstream** — the README says so outright, with multiple
   releases per week. Pin the EXACT version in the tool registry, and
   the lint gate's `recallInputs` must probe the abaplint version
   (Rule 19) so an upgrade reads as tooling drift, never as a
   developer's regression.
2. **abapGit file naming is load-bearing**: a mis-named `.abap` file is
   _silently ignored — zero findings, exit 0_. The floor must verify
   files were actually ingested (count parsed objects vs `.abap` files
   present) or a wrongly-serialized package gets a false PASS.
3. **A config is effectively required**: no config = all 188 rules
   (noise; `description_empty` fires on absent `.clas.xml` sidecars).
   The pack ships/generates a minimal floor config and a curated lint
   config.
4. **Use the object form of `syntax.version`**
   (`{"release": "Newest"}`) — the older string form hard-errors
   (exit 2) on current versions.
5. **`.bdef.asbdef` (RAP behavior definitions) are NOT syntax-checked**
   — no parse rule fires even under all 188 rules. The floor must
   DISCLOSE this (never claim coverage); text rules still apply to
   BDEF sources.
6. **JSON `file` paths are absolute** — route through the seam's
   `toRepoRelativePosix` validating boundary (the 3.8 parseLocated
   lesson; identity depends on it).
7. **No SARIF** — use `-f json` (stderr carries the banner; keep
   stdout clean).
