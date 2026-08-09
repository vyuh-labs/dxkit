---
name: dxkit-gate
description: Judge a bare directory (a generated package, an exported tree, a workspace of services) with dxkit's one-shot gate — no git, no init — and read the verdict.v1 result. Use when the user asks to "gate this package", "check the generated code", "judge this tree/export against a policy", "gate the workspace/wave", or wants a pass/block verdict on code that is not an onboarded repo.
---

# dxkit-gate

This skill runs the embeddable tree gate: one call in, one machine-readable
verdict out. It is the same engine as the repo guardrail pointed at a bare
directory, so the verdicts and fingerprints match what an onboarded repo
would see.

## Choosing the prior

- **Fresh tree** (default): `vyuh-dxkit gate <dir> --policy <policy.json>`.
  Everything found is net-new by construction. Right for a freshly
  generated or converted package.
- **Edited tree**: add `--baseline <original-dir>` to diff against the
  generated original. Only findings the edit introduced can block;
  pre-existing ones are grandfathered exactly like repo-mode debt.
- **Workspace / wave**: `vyuh-dxkit gate <dir> --workspace --flows <flowsDir>`
  judges every immediate subdirectory as a member tree AND the composition:
  unresolved cross-member calls block, routes nobody consumes warn, and a
  declared flow (`*.flow.json`, flow.v1) with an unserved step blocks.

Always pass `--json` when a program (including you) reads the result; parse
the `verdict.v1` document, not the human text.

## Trust: decide it deliberately

The gate treats the tree as untrusted by default: it scans bytes but never
executes the tree's code, and the correctness floor (compile + tests) plus
command checks are skipped with a disclosed cause. Pass `--trusted` ONLY
when the user is prepared to execute the tree's own code. Ask if unclear;
do not silently add `--trusted` to make skips go away.

## Reading the verdict

- Exit 0 `passed` / 1 `blocked` / 2 `cannot_gate`. Treat `cannot_gate` as a
  refusal with a named reason and remedy, never as a pass or a failure to
  fix in the code.
- Each blocking finding carries a stable fingerprint, a file locator
  (member-prefixed in wave mode), and the check that produced it.
- `checks[]` entries with a `skippedWithCause` are disclosures, not errors.
  Report them to the user (especially untrusted-skips) so "passed" is never
  read as broader coverage than actually ran.
- The verdict names the policy (`id`, `version`, content hash). When
  comparing two verdicts, confirm the policy identity matches first.

## Useful companions

- `vyuh-dxkit init --gate-only` scaffolds just the policy file for an embed
  (no hooks, CI, or .claude/).
- `vyuh-dxkit tools bom --json` renders the scanner bill of materials
  (pins + checksums) for image reviews.
- `--advisory-db <dir>` points the dependency audit at an offline OSV
  snapshot for air-gapped runs.
- The full walkthroughs live in the learn pages "Embedding the gate" and
  "Wave gating" (`vyuh-dxkit learn --serve`).
