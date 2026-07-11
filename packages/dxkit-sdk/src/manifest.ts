/**
 * The extension manifest — `.dxkit/extensions/<name>/extension.json`,
 * committed to the repo. The only thing an extension author writes besides
 * their own script (rung 3) or plugin module (rung 4).
 *
 * Trust boundary (load-bearing): a manifest is honored ONLY from the
 * repo's own committed tree — the same boundary as npm scripts and CI
 * config. dxkit never runs an extension named by a CLI flag or any other
 * untrusted source. Rung-3 scripts and rung-4 producer plugins execute at
 * REFRESH time on trusted context only (developer machine, the on-merge
 * workflow); per-commit gates and untrusted runs read the committed
 * snapshot offline with staleness disclosure. Rung-4 gather-time
 * contributions (a flow dialect, a contract reader, a URL normalizer)
 * load in-process on trusted context and are never loaded under
 * `--untrusted` — symmetrically on both gate sides, so degradation is a
 * narrower lens, never a false block.
 *
 * Two manifest shapes, discriminated by which execution field is present
 * (exactly one of `run` | `plugin`):
 *   - **rung 3** — `run` (external command) + `contributes` + `refresh` +
 *     `output`: the command emits one wire document, snapshotted at
 *     `output`.
 *   - **rung 4** — `plugin` (committed CommonJS module). With
 *     `contributes` (+ `refresh` + `output`) the module supplies the
 *     matching producer and behaves exactly like rung 3 in-process;
 *     without `contributes` it is gather-only (dialect / reader /
 *     normalizer) and `refresh` / `output` / `gating` must be absent.
 *
 * `schemaVersion` follows the same never-strand contract as the wire
 * schemas: shipped versions are read forever; a future version lands
 * alongside with one canonical up-converter.
 */

/** What an extension contributes — each kind maps to one wire schema. */
export type ContributionKind = 'contract' | 'inventory' | 'findings' | 'export';

/** How a rung-3 extension is executed (through dxkit's bounded-exec runner). */
export interface ExtensionRunSpec {
  /** The interpreter / binary (`python3`, `node`, `./tools/scan`). */
  command: string;
  args?: string[];
  /**
   * Wall-clock bound. On expiry the run is a disclosed skip (fail-open on
   * infrastructure), never a broken gate. Hosts apply a default when
   * omitted.
   */
  timeoutSeconds?: number;
}

/** How a rung-4 plugin is loaded (in-process, trusted context only). */
export interface ExtensionPluginSpec {
  /**
   * Path of the plugin module RELATIVE TO THE EXTENSION DIRECTORY
   * (`"plugin.js"`). CommonJS (`.js` / `.cjs`) — author in TypeScript and
   * commit the compiled module, or write plain JS. The module's default
   * export (or `module.exports`) is a `DxkitExtensionDefinition`.
   */
  module: string;
}

export interface ExtensionManifest {
  /** Manifest format version. Currently always 1. */
  schemaVersion: 1;
  /** Unique extension name within the repo (the directory name). */
  name: string;
  /**
   * The wire kind this extension emits. Required with `run`; required for
   * a `plugin` that supplies a producer; absent for a gather-only plugin.
   */
  contributes?: ContributionKind;
  /** Rung-3 execution. Exactly one of `run` | `plugin`. */
  run?: ExtensionRunSpec;
  /** Rung-4 plugin module. Exactly one of `run` | `plugin`. */
  plugin?: ExtensionPluginSpec;
  /**
   * When a producer executes: `on-merge` (the refresh workflow, the
   * `flow publish --land` pattern) or `manual` (`dxkit extensions refresh`).
   * Required exactly when `contributes` is present.
   */
  refresh?: 'on-merge' | 'manual';
  /**
   * Repo-relative path of the committed snapshot a producer run writes.
   * Required exactly when `contributes` is present.
   */
  output?: string;
  /**
   * For `findings` extensions: how a NET-NEW finding gates. 'block' fails
   * the guardrail, 'warn' (the default) surfaces without failing, 'off'
   * keeps the snapshot out of gating entirely. Pre-existing findings are
   * grandfathered by the baseline machine either way. Ignored for other
   * contribution kinds. Additive field (SDK minor).
   */
  gating?: 'block' | 'warn' | 'off';
}
