/**
 * Model-schema gather — walk a set of roots, extract every marked model, and
 * assemble one `ModelSet`, unioned with any spec-declared models.
 *
 * File discovery goes through the canonical `walkSourceFiles` (Rule 4
 * exclusions + test-file skipping built in); the scanned extensions are
 * exactly those of packs declaring BOTH a `modelSchema` descriptor and a
 * tree-sitter grammar, so a non-model language's files are never parsed and
 * adding a pack auto-extends the scan (Rule 6).
 *
 * `gatherRepoModelSet` is the canonical single-repo entry point (Rule 2): it
 * reads `.dxkit/policy.json:schema` itself, so a caller cannot forget the
 * configured specs — the half-landed-config bug class flow closed. The raw
 * `gatherModelSet` is reserved for explicit-config callers (the two-ref
 * gate's base side, where config comes from the HEAD checkout's policy).
 */

import { join, relative, resolve } from 'path';
import { LANGUAGES, allModelSchemaSourceExtensions } from '../../languages';
import { walkSourceFiles } from '../tools/walk-source-files';
import { extractFileModels } from './extract';
import { loadSpecModels } from './spec-source';
import { readSchemaConfig } from './config';
import type { DynamicModelSite, ModelEntity, ModelSet } from './model';

export interface GatherModelOptions {
  /** Directories to scan for source. */
  readonly roots: readonly string[];
  /** OpenAPI / JSON Schema files whose models union with extraction. */
  readonly specs?: readonly string[];
  /**
   * Relabel every extracted model `file` relative to this directory. The
   * drift identity contract (Rule 9) requires environment-independent
   * locators, so the gate sets this to the repo root: a model gathered from
   * the working tree and from a detached worktree share one relative `file`.
   */
  readonly relativeTo?: string;
}

/** Walk + extract + union. Files that don't parse are skipped, never fatal. */
export async function gatherModelSet(opts: GatherModelOptions): Promise<ModelSet> {
  const extensions = allModelSchemaSourceExtensions(LANGUAGES);
  const models: ModelEntity[] = [];
  const dynamicModels: DynamicModelSite[] = [];

  if (extensions.length > 0) {
    for (const root of opts.roots) {
      for (const rel of walkSourceFiles(root, { extensions })) {
        const abs = join(root, rel);
        const set = await extractFileModels(
          abs,
          opts.relativeTo ? relative(opts.relativeTo, abs) : abs,
        );
        if (!set) continue;
        models.push(...set.models);
        dynamicModels.push(...set.dynamicModels);
      }
    }
  }

  for (const spec of opts.specs ?? []) {
    const specModels = loadSpecModels(spec);
    const label = opts.relativeTo ? relative(opts.relativeTo, spec) : spec;
    models.push(...specModels.map((m) => ({ ...m, file: label })));
  }

  return { models, dynamicModels };
}

/**
 * Gather a repo's model set with its POLICY CONFIG applied — the canonical
 * single-repo entry point. `roots` defaults to `[cwd]`.
 */
export async function gatherRepoModelSet(
  cwd: string,
  opts: { roots?: readonly string[]; relativeTo?: string } = {},
): Promise<ModelSet> {
  const config = readSchemaConfig(cwd);
  return gatherModelSet({
    roots: opts.roots ?? [cwd],
    specs: config.specs.map((s) => resolve(cwd, s)),
    ...(opts.relativeTo !== undefined ? { relativeTo: opts.relativeTo } : {}),
  });
}
