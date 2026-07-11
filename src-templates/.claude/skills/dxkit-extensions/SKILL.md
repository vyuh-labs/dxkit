---
name: dxkit-extensions
description: Plug the repo's own extractors, inventories, and delivery sinks into dxkit as extensions — any language, no porting. Use when the user says "run our Python extractor through dxkit", "track our screens/permissions inventory", "make our custom scanner's findings gate the PR", "send dxkit reports to our dashboard/spreadsheet", "declare our Postman collection / pact / HAR", or "how do I write a dxkit extension". For gate-time repo COMMANDS (a lint gate, an architecture script), defer to dxkit-checks; extensions run at refresh time and gates read their committed snapshots offline.
---

# dxkit-extensions

An **extension** is a script the repo already owns — any language — that dxkit
orchestrates: it runs at refresh time, emits one JSON document, and dxkit
validates it and routes it through the same machines native output gets.

Before writing one, climb the ladder from the bottom — most needs stop early:

1. **Config** — a `.dxkit/policy.json` key. No code.
2. **Declared artifact** — you already have a Postman collection, Pact file,
   `.http` requests, HAR capture, or OpenAPI document? Declare it:

   ```jsonc
   // .dxkit/policy.json
   {
     "flow": {
       "sources": [
         { "kind": "postman", "path": "collections/checkout.postman_collection.json" },
         { "kind": "pact", "path": "pacts/web-api.json" },
         { "kind": "har", "path": "fixtures/session.har" },
       ],
     },
   }
   ```

   Zero code; the artifacts join the flow map and gate like extracted calls.
3. **External extension** (this skill's core) — a committed manifest points at
   your existing script.
4. **TypeScript plugin** — only for AST-level integration; you probably don't
   need it (it lands with the plugin runtime).

## What an extension can contribute

| `contributes` | The document it emits | Where it lands |
| --- | --- | --- |
| `contract` | `contract.v1` — consumed calls / served routes | the flow map + integration gate |
| `inventory` | `inventory.v1` — named entities (screens, permissions, …) | committed store + entity-count trend on `report history` |
| `findings` | `findings.v1` — located findings | the guardrail: net-new blocks/warns per the manifest's `gating`, pre-existing debt grandfathered |
| `export` | `export.v1` receipt (it RECEIVES the report to deliver) | your dashboard / spreadsheet / notifier, unchanged |

## Author one

```bash
# scaffold (manifest + optional Python starter that already passes validation)
npx vyuh-dxkit extensions init ui-inventory --kind inventory --stub

# point at an EXISTING script instead
npx vyuh-dxkit extensions init perm-audit --kind findings \
  --command "python3 tools/audit_permissions.py"

# the authoring loop — run + validate + summarize, in seconds
npx vyuh-dxkit extensions dev ui-inventory
```

The script's contract (any language): read the JSON payload on **stdin**
(your committed `config` block + repo facts — exclude dirs, active
languages), write ONE JSON document to **stdout** or to the manifest's
`output` path. Validation errors from `dev` are field-precise
(`inventory.v1: entities[3].fields[0].name must be a non-empty string`) —
fix and re-run.

## Operate

```bash
npx vyuh-dxkit extensions            # list + snapshot health (ok/age, missing, invalid)
npx vyuh-dxkit extensions refresh    # run them all, rewrite committed snapshots
```

Trust model (explain when asked): extensions execute ONLY from the repo's own
committed manifests, at refresh time on trusted context (a developer machine
or the on-merge refresh workflow). Gates and untrusted PR runs never execute
anything — they read the committed snapshots offline, with staleness
disclosed. Review a PR that edits an `extension.json` or its script like a PR
that edits a CI workflow.

For a findings extension, gating posture is in the manifest: `"gating":
"block"` fails the guardrail on a net-new finding, `"warn"` (default)
surfaces it, `"off"` keeps it out of gating. Suppress an individual finding
via dxkit-allowlist, same as any native finding.
