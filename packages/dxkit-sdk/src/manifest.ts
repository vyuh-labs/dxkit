/**
 * The extension manifest — `.dxkit/extensions/<name>/extension.json`,
 * committed to the repo. The only thing a rung-3 extension author writes
 * besides their own script.
 *
 * Trust boundary (load-bearing): a manifest is honored ONLY from the
 * repo's own committed tree — the same boundary as npm scripts and CI
 * config. dxkit never runs an extension named by a CLI flag or any other
 * untrusted source, and extensions execute at REFRESH time on trusted
 * context only (developer machine, the on-merge workflow); per-commit
 * gates and untrusted runs read the committed snapshot offline with
 * staleness disclosure.
 *
 * `schemaVersion` follows the same never-strand contract as the wire
 * schemas: shipped versions are read forever; a future version lands
 * alongside with one canonical up-converter.
 */

/** What an extension contributes — each kind maps to one wire schema. */
export type ContributionKind = 'contract' | 'inventory' | 'findings' | 'export';

/** How the extension is executed (through dxkit's bounded-exec runner). */
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

export interface ExtensionManifest {
  /** Manifest format version. Currently always 1. */
  schemaVersion: 1;
  /** Unique extension name within the repo (the directory name). */
  name: string;
  contributes: ContributionKind;
  run: ExtensionRunSpec;
  /**
   * When the extension executes: `on-merge` (the refresh workflow, the
   * `flow publish --land` pattern) or `manual` (`dxkit extensions refresh`).
   */
  refresh: 'on-merge' | 'manual';
  /** Repo-relative path of the committed snapshot the run writes. */
  output: string;
  /**
   * For `findings` extensions: how a NET-NEW finding gates. 'block' fails
   * the guardrail, 'warn' (the default) surfaces without failing, 'off'
   * keeps the snapshot out of gating entirely. Pre-existing findings are
   * grandfathered by the baseline machine either way. Ignored for other
   * contribution kinds. Additive field (SDK minor).
   */
  gating?: 'block' | 'warn' | 'off';
}
