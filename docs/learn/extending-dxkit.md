# Extending dxkit: the SDK and the effort ladder

dxkit's core owns the language-agnostic machinery: routes, models,
dependencies, findings, gates. Everything app-specific or org-specific is an
extension, and `@vyuhlabs/dxkit-sdk` is the frozen surface extensions build
against. This page is the short version; the full reference lives in
`docs/extension-sdk.md`.

## When should you extend at all?

Reach for an extension when dxkit's stock analysis cannot see something your
org's code makes true by convention:

- your HTTP client is a wrapper (`fetchJson`, `api.call`) the flow mapper
  does not recognize, so UI-to-API calls read as unresolved;
- a contract artifact already exists (an OpenAPI file, a route manifest from
  your framework's build) and dxkit should trust it instead of re-deriving;
- an in-house scanner or audit script produces findings you want gated like
  native ones, with grandfathering and allowlists;
- an org convention ("every handler declares its auth level") deserves a
  first-class check.

If none of these apply, you do not need the SDK. Custom checks in
`.dxkit/policy.json` (a command plus a regex over its output) already make
any repo command a gate citizen.

## The effort ladder: land on the lowest rung

Every capability lands on the lowest rung that can express it. Most teams
never leave rungs 1 and 2.

1. **A policy key.** Examples: `flow.stripUrlPrefixes`, custom `checks[]`,
   paired-change rules. You write JSON, nothing runs.
2. **A path to an artifact you already have.** Point `flow.sources` at an
   OpenAPI file or a route manifest your build already emits. dxkit reads
   it; nothing of yours runs.
3. **A manifest pointing at your existing script.** Your script emits one of
   the versioned wire documents (`contract.v1`, `inventory.v1`,
   `findings.v1`, `export.v1`); dxkit runs it at refresh time, validates the
   output, and commits the snapshot. Developers and the per-commit gate read
   the committed snapshot, so your script's toolchain is needed only where
   refresh runs.
4. **A TypeScript plugin.** Mostly a data table, loaded in-process. This is
   where wrapper dialects and custom contract readers live.

## A worked rung-4 example: teach the flow mapper your HTTP wrapper

Your frontend calls `fetchJson('/api/orders')` and dxkit's flow map shows
unresolved calls. The fix is a committed plugin that contributes a dialect
entry to the TypeScript pack:

```jsonc
// .dxkit/extensions/acme-dialect/extension.json
{ "schemaVersion": 1, "name": "acme-dialect", "plugin": { "module": "plugin.js" } }
```

```js
// .dxkit/extensions/acme-dialect/plugin.js
module.exports = {
  name: 'acme-dialect',
  sdkMajor: 0,
  httpFlowDialect: {
    pack: 'typescript',
    clientMethodCallees: { methods: ['fetchJson'] },
    methodAliases: { fetchjson: 'GET' },
  },
};
```

Scaffold with `vyuh-dxkit extensions init <name> --plugin`, iterate with
`vyuh-dxkit extensions dev <name>`, and commit the result. From then on the
flow map, the doctor diagnosis, and the integration gate all understand the
wrapper, on every machine, with no per-developer setup.

## The rules that keep extensions honest

- **One normalizer.** URL and method normalization is the SDK's
  (`normalizePath`, `normalizeMethod`); extensions never replicate it, and
  wire URLs are re-normalized at ingest, so an extension cannot drift from
  the gate's idea of a route.
- **dxkit computes identity.** Extensions emit findings; the aggregator
  fingerprints them. An extension that hashed its own identities would opt
  out of baseline migration, so the SDK simply does not expose it.
- **Committed code, reviewed like CI config.** A rung-4 plugin runs
  in-process on trusted surfaces only, never under `--untrusted`, and a
  plugin built against a different SDK major is refused at load with both
  versions named. Review a PR that edits a plugin the way you review a PR
  that edits a workflow.
- **Additive-only freeze.** Everything the SDK exports is contract, pinned
  by a surface-freeze test; shipped wire versions are read forever. A
  committed snapshot is never stranded by a dxkit upgrade.

## Choosing your rung, quickly

| You have...                                   | Use                              |
| --------------------------------------------- | -------------------------------- |
| a convention expressible as configuration     | rung 1: a policy key             |
| an artifact your build already produces       | rung 2: `flow.sources`           |
| a script that can print JSON                  | rung 3: manifest + wire document |
| a wrapper/dialect the parsers should learn    | rung 4: plugin (data table)      |
| findings from an external SAST engine (SARIF) | `vyuh-dxkit ingest`, not the SDK |

## Author your own gate: worked examples

The most common ask — "gate net-new regressions on something specific to
us" — usually needs no SDK at all. Work down this list and stop at the
first fit.

### 1. A located custom check (only NEW violations block)

The workhorse. Give dxkit a command plus a regex with named groups, and
every match becomes a first-class finding with its own identity: the
existing backlog is grandfathered into the baseline, and only net-new
matches block a PR — the same brownfield discipline as every native kind.

Example: forbid direct database imports outside the data layer, enforced
today by review comments.

```jsonc
// .dxkit/policy.json
"checks": [
  {
    "name": "no-direct-db-imports",
    "command": ["bash", "scripts/arch-db-imports.sh"],
    "parse": { "regex": "^(?<file>[^:]+):(?<line>\\d+): (?<message>.*)$" },
    "blocking": true
  }
]
```

The script prints one `path:line: message` row per violation (a plain
grep does fine) and can exit non-zero or zero — located parses read the
OUTPUT, not the exit code, because many linters exit 0 while reporting.
After adding the check: `vyuh-dxkit checks run` to dry-run it, then
`vyuh-dxkit baseline create` (or the refresh lane) to grandfather the
current backlog. From then on, a PR introducing a new violation is
BLOCKED with the exact file:line, while the old debt burns down on its
own schedule.

### 2. A binary check (whole command must pass)

For a command that is genuinely pass/fail — a license audit, a schema
validator. `"parse": "exit"` gates on the exit code (`expectedExit`
defaults to 0). Honest warning: a binary check grandfathers the WHOLE
check, so if it is failing at baseline time, new failures cannot be told
apart from old ones. Prefer a located parse whenever the output names
locations.

### 3. A paired-change rule (no command at all)

"Changing X requires also changing Y" — declarative over the diff, runs
on every surface including fork PRs because nothing is spawned:

```jsonc
"pairedChecks": [
  { "name": "model-needs-migration",
    "if": ["src/models/**"], "then": ["migrations/**"],
    "message": "a data-model change ships with its migration" }
]
```

### 4. The SDK, when you need a real analyzer

If your gate needs analysis a command-plus-regex cannot express — an
in-house scanner with structured output, a contract read from your
framework's build — emit the `findings.v1` wire document from your own
script (rung 3 above) and dxkit gates those findings with the same
fingerprints, grandfathering, and allowlists as native ones.

Two operational notes, both load-bearing: custom checks gate in
COMMITTED baseline modes (a throwaway worktree at a git ref lacks your
toolchain, so ref-based mode discloses instead of guessing), and
`checks[].command` runs from the committed policy only — review edits to
it with the scrutiny of a CI workflow change.
