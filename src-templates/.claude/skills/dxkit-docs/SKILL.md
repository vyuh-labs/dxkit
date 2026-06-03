---
name: dxkit-docs
description: Generate the documentation a repo is missing — read the Documentation dimension's gaps, orient on the real code via the graph, then write a grounded README / docstrings / API + architecture docs that move the score without tripping the slop check. Use when the user says "write docs", "document this module", "improve the documentation score", "generate a README", "add docstrings", or after a health report flags Documentation.
---

# dxkit-docs

This skill closes the gap `dxkit-action` doesn't: it **generates** missing
documentation rather than fixing flagged findings. It's built around one
hard constraint — dxkit's own quality scan flags AI-slop prose, so
documentation that reads like generated filler *lowers* the Quality score
while raising Documentation. The whole point of this skill is docs that
are **grounded in the real code** and **survive the slop check**.

## The docs loop

```
[1] Read the gap   → health Documentation deductions + top actions
[2] Orient         → graph: what are the real entry points, modules, public API
[3] Generate       → write the missing artifact, grounded in actual symbols/paths
[4] De-slop        → write like a human; re-run quality so it doesn't trip slop
[5] Verify         → re-run health; Documentation up, slop not down
```

Don't skip [2] or [4]. [2] is what keeps the docs true; [4] is what keeps
them from costing you on another dimension.

## [1] Read the gap — what's actually missing

The Documentation dimension scores a fixed checklist. Read its deductions
and ranked actions instead of guessing:

```bash
npx vyuh-dxkit health --detailed --json | jq '.dimensions.documentation'
```

The `deductions` array names each missing/substandard artifact; `topActions`
ranks them by score uplift. The scored artifacts are:

| Artifact | What moves the score |
|---|---|
| **README** | Present, and substantial (not a 5-line stub) |
| **Doc-comment density** | Share of source files carrying docstrings / JSDoc / Rustdoc |
| **API docs** | `docs/api/`, OpenAPI/Swagger spec |
| **Architecture docs** | `ARCHITECTURE.md` or `docs/architecture/` |
| **CONTRIBUTING** | `CONTRIBUTING.md` |
| **CHANGELOG** | `CHANGELOG.md` |

Work the `topActions` order — the README and doc-comment density weigh
heaviest, CHANGELOG lightest.

## [2] Orient — document the code that's actually there

Docs that describe code which doesn't exist are worse than no docs. Before
writing a word, learn the real shape from the graph (cheap, structural):

```bash
npx vyuh-dxkit explore entry-points      # what this repo does — the surfaces to lead a README with
npx vyuh-dxkit explore communities       # the natural modules — the spine of an ARCHITECTURE.md
npx vyuh-dxkit explore api-surface       # exported symbols — what API docs must cover
npx vyuh-dxkit explore hot-files         # the foundational files — docstring these first
npx vyuh-dxkit context <symbol>          # one area's structure before you docstring it
```

Then **read the actual code** you're about to document — the graph points
you at it; it doesn't replace reading it. Also read any existing docs
first and match their voice, structure, and terminology.

## [3] Generate — grounded, specific, real

Per artifact:

- **README** — lead with what the repo *does* (from `entry-points`), then
  real install + usage steps you've verified against the actual scripts /
  entry points, not a generic template. Reference real commands, real file
  paths, real module names.
- **Doc-comments** — docstring the highest-value undocumented files first
  (public API from `api-surface`, foundational files from `hot-files`).
  Describe *why* and the contract (params, returns, invariants, gotchas) —
  not a restatement of the signature.
- **Architecture docs** — structure an `ARCHITECTURE.md` around the real
  `communities` / `hot-files`: what each module owns, how they depend on
  each other (the graph already knows the edges).
- **API docs** — generate from the actual exported surface; prefer the
  ecosystem's doc generator (`typedoc`, `sphinx`, `godoc`, `yard`, …) over
  hand-rolled prose when one fits.
- **CONTRIBUTING / CHANGELOG** — real build/test commands from the repo;
  real recent changes from `git log` for a CHANGELOG seed.

## [4] De-slop — the rule that makes this skill different

dxkit's slop check flags AI-generated boilerplate. **Generated docs are
the single biggest source of slop**, so this step is mandatory, not
optional. Write to pass it:

- **No filler openers.** Not "This module provides functionality for
  handling…" — say what it does and why it exists.
- **Be concrete.** Name real symbols, real paths, real commands. Specifics
  don't read as slop; generic scaffolding does.
- **No hedging padding** ("it's worth noting that", "in order to",
  "leverage", "robust", "seamless", "comprehensive solution").
- **Match the repo's register** — terse repos get terse docs.

Then prove it:

```bash
npx vyuh-dxkit quality            # slop score must not drop
```

If a genuine false positive trips the slop check on prose you stand
behind, annotate the line (`// slop-ok: <reason>`, or `# slop-ok` for
hash-comment languages) — but fix first, suppress second.

## [5] Verify — Documentation up, nothing else down

```bash
npx vyuh-dxkit health --detailed   # Documentation score moved in the right direction
npx vyuh-dxkit quality             # slop / quality did NOT regress
```

The work is done when the Documentation deduction you targeted is gone
**and** the Quality score held. A docs change that raises Documentation by
moving slop into Quality is a net loss — re-do it more concretely.

Then run the guardrail before pushing, same as any change:

```bash
npx vyuh-dxkit guardrail check
```

## Scope — what NOT to document

- Don't docstring self-evident one-liners; density credit comes from
  documenting the files that need it (public API, foundational modules),
  not papering every getter.
- Don't document auto-generated or vendored code.
- Don't invent behavior to fill a section — if you're unsure what
  something does, read it or ask, don't guess in prose.

## Hand-offs

- Running / interpreting the health report → `dxkit-reports`.
- Documentation surfaced as one finding inside a broader fix pass →
  `dxkit-action`.
- Documenting a feature you're building → `dxkit-feature` (its build step
  should leave the new surface documented).
- Slop findings outside docs (AI-generated code prose, CHANGELOG slop) →
  `dxkit-action`'s slop recipe.
