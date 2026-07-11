# The Extension SDK (`@vyuhlabs/dxkit-sdk`)

dxkit's core owns the language-agnostic contract level: routes, models,
dependencies, findings, gates. Everything app-specific or org-specific becomes
an extension, and the SDK is the frozen surface extensions build against.

This page documents the surface as of SDK 0.x. Rungs 1-3 are live: declared
contract artifacts (`flow.sources`) and the external-extension orchestrator
(`vyuh-dxkit extensions`) ship with dxkit 3.5; the in-process plugin runtime
(rung 4) arrives in a later minor, speaking the shapes already frozen here.

## The effort ladder

Every capability lands on the lowest rung that can express it. Most users
never leave rungs 1 and 2.

| Rung | You write                                   | Runs code?                   |
| ---- | ------------------------------------------- | ---------------------------- |
| 1    | a `.dxkit/policy.json` key                  | no                           |
| 2    | a path to an artifact you already have      | no                           |
| 3    | a manifest pointing at your existing script | your script, at refresh time |
| 4    | a TypeScript plugin (mostly a data table)   | sandboxed, in-process        |

## What is frozen

Everything exported from `@vyuhlabs/dxkit-sdk` is contract: additive-only
within a major, pinned by `test/sdk-surface-freeze.test.ts` in the main repo.

- **The descriptor language** (`HttpFlowSupport`, `FileRouteSupport`,
  `ModelSchemaSupport`): the construct-family tables dxkit's own language
  packs declare. Rung-4 dialects contribute entries in these exact shapes,
  merged into the pack descriptor at load time.
- **Grammar-shape access** (`GrammarShape`, `GrammarModelShape`,
  `ResolvedCall`): how a tree-sitter grammar's calls, decorators, strings,
  classes, and fields are read. The per-grammar rows stay internal; the read
  contract is frozen.
- **The wire schemas** (`contract.v1`, `inventory.v1`, `findings.v1`,
  `export.v1`, plus `ExtensionManifest`): the versioned JSON documents a
  rung-3 extension emits. Shipped versions are read forever; new versions
  land alongside with one canonical up-converter, so a committed snapshot is
  never stranded by a dxkit upgrade.
- **The normalizer** (`normalizePath`, `normalizeMethod`, `bindingKey`, the
  catch-all helpers, the `HttpMethod`/`ServedMethod` vocabulary): the exact
  functions dxkit runs. There is one normalizer; extensions never replicate
  it (wire URLs are re-normalized at ingest).
- **AST access shapes** (`ParsedFile`, `walk`, `Node`/`Tree`,
  `ParseFileFn`/`ParseSourceFn`): what the plugin host will bind parsing
  through when the in-process runtime lands.

## What is deliberately NOT in the SDK

Freezing has a cost: a frozen thing resists change. The surface stays the
smallest set that covers real extension demand, and several contracts are
frozen in place in the main package or stay internal on purpose:

- **`DepVulnsProvider`** (with `manifestPatterns` / `lockfilePatterns`) is a
  language-pack contract entangled with the internal pack-id union. It is
  frozen in place, pinned structurally by the surface-freeze test.
  Extensions contribute dependency findings through `findings.v1`, never by
  implementing the provider.
- **Finding identity and fingerprints.** Identity is computed by dxkit's
  aggregator, never by a producer (native or extension). Fingerprint schemes
  version and migrate internally; an extension that computed its own
  identity would silently opt out of that migration contract.
- **The pack-id union (`LanguageId`) and the pack registry.** The pack set
  grows release to release. Extensions see plain strings
  (`ParsedFile<string>`); dxkit narrows internally.
- **The tool registry, scoring specs, exclusions.** Internal machinery.
  Extensions receive canonical repo facts (exclusion dirs, active
  languages, their own policy block) in their stdin config at run time,
  so they inherit the one source of truth without freezing its shape.

## Existing features and the extension substrate

The question "should feature X move into the SDK?" usually resolves to
"feature X should CONVERGE on the extension substrate" instead, which is
where the UX win actually is:

- **SARIF ingestion** (`ingest`, Snyk/CodeQL) is already extension-shaped:
  an external producer, a committed snapshot, refresh-time execution,
  staleness disclosure. It stays core (engine resolution and licensing are
  dxkit's job), and its finding flow is the template `findings.v1` follows.
  A declared SARIF artifact source (rung 2: point config at a SARIF file
  any tool produced) is the planned generalization.
- **Custom checks** (`policy.json:checks`) run commands at gate time under
  the committed-policy trust boundary; rung-3 findings extensions run at
  refresh time and gates read their snapshots offline. Both mint findings
  into the same identity machine. Use a check for a fast repo-local
  command; use an extension for anything slow, tool-heavy, or producing a
  reviewable inventory.
- **OpenAPI specs** (`flow.specs`) are the first declared contract
  artifact; the multi-format reader registry (Postman, Pact, `.http`, HAR)
  generalizes the same rung-2 pattern.

## Versioning and release ordering

- The SDK is semver'd independently of dxkit. `SDK_MAJOR` is the
  compatibility handshake: extensions declare the major they target; dxkit
  warns or refuses on mismatch.
- Additive growth (a new wire kind, a new descriptor field) is a minor.
  Removal or rename is a major. The surface-freeze test makes accidental
  narrowing a CI failure.
- The main package depends on the SDK, so a release that raises the SDK
  dependency floor publishes the SDK first (`dxkit-sdk@vX.Y.Z` tag, its own
  publish workflow), then dxkit. CI smokes the tarball pair so a PR never
  depends on unpublished registry state.
