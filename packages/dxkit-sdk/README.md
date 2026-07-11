# @vyuhlabs/dxkit-sdk

The frozen extension surface of [`@vyuhlabs/dxkit`](https://github.com/vyuh-labs/dxkit).

dxkit's own language packs are built as declarations: a pack says *which* constructs
in a language are HTTP calls, routes, or data models, and one shared engine reads
them. This package publishes that same declarative surface, plus the wire schemas
external extensions speak, so anything you build against it keeps working as dxkit's
internals evolve.

## What's in here

- **Descriptor types**: `HttpFlowSupport`, `FileRouteSupport`, `ModelSchemaSupport`.
  The construct-family tables dxkit's packs declare, and the same language rung-4
  plugin dialects will use.
- **Grammar-shape types**: `GrammarShape`, `GrammarModelShape`, `ResolvedCall`. How
  a tree-sitter grammar's calls, decorators, strings, classes, and fields are read.
- **Wire schemas**: the versioned JSON documents an external extension (any
  language) emits: `contract.v1`, `inventory.v1`, `findings.v1`, `export.v1`, plus
  the `ExtensionManifest` shape for `.dxkit/extensions/<name>/extension.json`.
- **Normalization helpers**: `normalizePath`, `normalizeMethod`, `bindingKey`, the
  catch-all path helpers, and the `HttpMethod` / `ServedMethod` vocabulary. These
  are the exact functions dxkit runs; there is one normalizer, and this is it.
- **AST access types**: `ParsedFile`, `walk`, and the tree-sitter `Node` / `Tree`
  type re-exports that grammar shapes are written against.

## Versioning contract

- The surface is additive-only within a major. Removing or renaming anything here
  is a major bump. Extensions declare the major they target; dxkit warns or
  refuses on a mismatch.
- Wire schema versions never disappear. When `contract.v2` ships, `contract.v1`
  documents keep being read (dxkit up-converts). A committed extension snapshot is
  never stranded by a dxkit upgrade.
- Until 1.0, minor versions (0.x) may still adjust the surface as the extension
  runtime lands. 1.0 marks the full freeze.

## Status

Types-first. This package currently ships the frozen types, wire schemas, and pure
helpers. The extension orchestrator (external extractors declared by manifest) and
the in-process plugin runtime (`defineExtension`) arrive in later minors; see the
[dxkit roadmap](https://github.com/vyuh-labs/dxkit#readme) for the rung ladder.

## License

MIT
