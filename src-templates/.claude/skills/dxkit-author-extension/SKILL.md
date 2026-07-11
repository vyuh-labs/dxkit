---
name: dxkit-author-extension
description: Write a dxkit extension FOR the user from a prose description of what they want extracted, verified, or delivered — pick the lowest rung (declared artifact → external script → TypeScript plugin), generate the manifest/adapter/plugin, and drive `extensions dev` until green. Use when the user describes a bespoke convention ("our screens are JSX files with a <Screen> root", "our API client is acmeApi.request", "our permissions are hasPermission() calls") or asks to port an existing extractor/report script into dxkit.
---

# dxkit-author-extension

You are writing the extension; the user describes the convention. Work the
ladder from the bottom — the lowest rung that expresses the need wins, and
every rung down is less code the user owns:

1. **Config / declared artifact** — if the evidence already exists as a
   Postman collection, Pact, `.http` file, HAR, or OpenAPI doc, declare it in
   `.dxkit/policy.json:flow.sources` and STOP. No code.
2. **External script (rung 3)** — the user has extraction logic (any
   language) or you can write ~50 lines of Python: a manifest +
   stdin-payload adapter emitting one wire document. This covers almost
   everything: inventories, custom findings, delivery sinks.
3. **TypeScript plugin (rung 4)** — only when the need is INSIDE dxkit's
   gather: a bespoke HTTP-client wrapper flow can't see, a custom artifact
   format for `flow.sources`, base-URL logic beyond `stripUrlPrefixes`, or
   an assertion over the gathered flow model.

## The authoring loop (all rungs)

1. Scaffold: `vyuh-dxkit extensions init <name> --kind <kind> --command "…"`
   (rung 3, `--stub` for a Python starter) or
   `vyuh-dxkit extensions init <name> --plugin [--kind <kind>]` (rung 4).
2. Read sample source/artifacts the user points at; fill in the logic.
3. `vyuh-dxkit extensions dev <name>` — field-precise errors ARE the spec;
   iterate until VALID and the summary shows the expected counts.
4. Sanity-check counts against ground truth (grep the repo, count rows).
5. Commit the manifest + script/plugin + refreshed snapshot. Gates read the
   committed snapshot offline; `refresh: on-merge` keeps it current via the
   extensions-refresh workflow.

## Rung-4 contribution points (what goes in `plugin.js`)

The module's export is a `DxkitExtensionDefinition` (plain CommonJS object,
or `defineExtension({...})` from `@vyuhlabs/dxkit-sdk` in TypeScript — it
stamps `sdkMajor`). Each key registers into an existing dxkit registry:

| Key | Use for | Example trigger phrase |
| --- | --- | --- |
| `httpFlowDialect` | teach flow a bespoke client wrapper / niche framework — a data TABLE, no AST code | "our API calls go through `acmeApi.request`" |
| `contractReader` | a custom artifact format for `flow.sources` (`kind`, `sniff`, `parse` → raw calls/routes) | "our contract fixtures are CSV files" |
| `urlNormalizer` | rewrite raw URLs ahead of canonical normalization (`(url) => string \| null`, null = no opinion) | "our clients call `internal://svc/...`" |
| `findingProducer` / `inventoryProducer` / `contractProducer` / `exporter` | the rung-3 wire protocol, in-process (manifest needs `contributes` + `refresh` + `output`) | "we'd rather write TS than Python" |
| `integrationVerifier` | assert over the gathered flow model (`ctx.flow.unserved` = calls nothing serves); findings gate via the committed snapshot | "fail the PR when a call has no backend route" |

Dialect example — the whole plugin for "our wrapper is `api.fetchJson(url)`,
always GET":

```js
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

Rules you must respect when authoring:

- **Never normalize URLs yourself** — emit them raw; dxkit's ONE normalizer
  canonicalizes. A `urlNormalizer` may only re-express a URL, never bypass.
- **Dialects are additive-only** — they widen what counts as HTTP; they
  cannot override pack facts. Keep token lists tight (precision bias).
- **Plugins are trusted-tier code**: committed to the repo (reviewed like CI
  config), loaded in-process on trusted context only, never under
  `--untrusted` (snapshot fallback). Don't reach for the network or write
  outside the manifest's `output`.
- **CommonJS on disk**: author in TypeScript if you like, but commit the
  compiled `.js`/`.cjs` module the manifest names.

## Porting an existing extractor (the common rung-3 job)

Keep the user's script UNMODIFIED; write a thin adapter that (1) reads the
dxkit stdin payload (config block + repo facts), (2) invokes their script
via its own config surface (env vars, CLI args), (3) converts its output
(CSV/JSON) into the wire document. Then verify the entity/finding count
matches the script's direct output exactly before calling it done.

When validation errors mention a rung below ("this looks like a Postman
collection — declare it in flow.sources"), take the hint and move down.
