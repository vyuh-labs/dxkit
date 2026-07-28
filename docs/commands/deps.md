# `vyuh-dxkit deps`

Deterministic dependency security bumps: turn the fixable subset of your
dependency vulnerabilities into concrete, verified upgrades — planned from
the scanners' own fix versions, applied with your repo's own package manager,
verified by the correctness floor and the guardrail before anything lands.
No LLM anywhere in the lane.

## Usage

```bash
vyuh-dxkit deps bump [path]              # plan only (dry run, writes nothing)
vyuh-dxkit deps bump --apply             # execute the bumps + verify
vyuh-dxkit deps bump --apply --land pr   # …and land ONE standing PR (dxkit/dep-bump)
```

## Options

| Flag            | Meaning                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `--apply`       | Execute the planned bumps (default: dry-run plan only)                                       |
| `--allow-major` | Include producer-classified major (breaking) bumps — skipped-and-named otherwise             |
| `--land pr`     | Commit manifest + lockfile to the standing `dxkit/dep-bump` branch and open/update the PR    |
| `--json`        | Machine-readable result (`deps-bump.v1`), including the full skip list and the ledger        |

## How the plan is built

The lane consumes the same enriched dep-vuln findings the vulnerability
report renders. A bump is proposed only when a tool resolved a concrete
target version:

- a **structured upgrade plan** (from the Tier-2 fix tools / the transitive
  resolver) wins — "upgrade this direct dependency to X to close N transitive
  advisories";
- a **direct dependency** with a scanner-reported `fixedVersion` is the
  fallback;
- everything else is **skipped and named**: no fix available, transitive
  without a resolved parent, breaking without `--allow-major`, already
  allowlisted, or a non-Node ecosystem (the apply lane is Node-first; other
  ecosystems' fix advice still renders in the reports).

One bump per direct dependency: advisories resolving through the same parent
collapse to the latest proposed version.

## How it verifies

Applying runs your own package manager (`npm install pkg@ver --save-dev` /
`pnpm add` / `yarn add` / `bun add`), preserving the dependency's manifest
section. Then, before anything lands:

1. the **correctness floor at full scope** — compile + full test run, because
   a dependency change alters module resolution for every file;
2. the **guardrail check** — the verdict is recorded in the ledger.

A red floor means **no PR**: the lane exits non-zero with the ledger
explaining which checks failed. A bump that breaks the build is a human
decision, not a robot PR.

## The standing PR

`--land pr` commits exactly `package.json` + the lockfile to the standing
`dxkit/dep-bump` branch (via the same lander every dxkit refresh surface
uses) and opens or updates one reviewable PR. The body is the verification
ledger: each bump with the advisories it closes, the floor result per check,
the guardrail verdict, and the full disclosed skip list.

## The scheduled lane

```jsonc
// .dxkit/policy.json
{ "depBump": { "enabled": true, "allowMajor": false } }
```

then `vyuh-dxkit update` installs the `dxkit-dep-bump` workflow: weekly (plus
manual dispatch), it runs `deps bump --apply --land pr` on the default branch.
The PR's own CI — including the dxkit guardrail — still gates the merge; the
lane's verification is the pre-flight, not a bypass.

## See also

- [`vulnerabilities`](vulnerabilities.md) — the full advisory report the plan is built from
- `vyuh-dxkit debt` — the prioritized inventory of everything grandfathered
- [`allowlist`](allowlist.md) — time-boxed deferral for what can't be bumped yet
