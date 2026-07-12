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
 * Three ASSEMBLY steps live here (per-repo joins no single file can make):
 *   - `schemaFileTables` — a declared schema file's table calls mint
 *     entities (Rails `db/schema.rb`), and while such a file EXISTS the
 *     pack's class markers are demoted to discovery-only (the class body
 *     declares no fields there; minting both `users` and `User` would give
 *     one logical model two identities);
 *   - `modelTypeRefContainers` — type names referenced from container
 *     properties (EF Core `DbSet<Order>`) promote the so-named candidate
 *     classes repo-wide (`via: 'type-ref'`);
 *   - `mergePartialEntities` — same-name all-partial declarations merge into
 *     one entity, so a field moving between C# partials is never drift.
 *
 * `gatherRepoModelSet` is the canonical single-repo entry point (Rule 2): it
 * reads `.dxkit/policy.json:schema` itself, so a caller cannot forget the
 * configured specs — the half-landed-config bug class flow closed. The raw
 * `gatherModelSet` is reserved for explicit-config callers (the two-ref
 * gate's base side, where config comes from the HEAD checkout's policy).
 */

import { existsSync } from 'fs';
import { join, relative, resolve } from 'path';
import { LANGUAGES, allModelSchemaSourceExtensions } from '../../languages';
import type { ModelSchemaSupport } from '../../languages/types';
import { withParsedFile } from '../../ast/parse';
import { grammarShape } from '../../ast/grammar-shape';
import { walkSourceFiles } from '../tools/walk-source-files';
import { extractFileModels } from './extract';
import { extractSchemaFileTables } from './schema-file';
import { loadSpecModels } from './spec-source';
import { readSchemaConfig } from './config';
import { mergePartialEntities } from './model';
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

/** The schema-file models of one root, plus the per-language descriptor
 *  demotions their presence implies (class markers → discovery-only). */
async function gatherSchemaFiles(
  root: string,
  relativeTo?: string,
): Promise<{ models: ModelEntity[]; overrides: Map<string, ModelSchemaSupport> }> {
  const models: ModelEntity[] = [];
  const overrides = new Map<string, ModelSchemaSupport>();
  for (const lang of LANGUAGES) {
    const descriptor = lang.modelSchema;
    const spec = descriptor?.schemaFileTables;
    if (!descriptor || !spec) continue;
    let present = false;
    for (const file of spec.files) {
      const abs = join(root, file);
      if (!existsSync(abs)) continue;
      const extracted = await withParsedFile(abs, (parsed) => {
        const callShape = grammarShape(parsed.grammar);
        if (!callShape) return null;
        const label = relativeTo ? relative(relativeTo, abs) : abs;
        return extractSchemaFileTables(parsed.tree.rootNode, spec, descriptor, callShape, label);
      });
      if (!extracted) continue;
      present = true;
      models.push(...extracted);
    }
    if (present) {
      // The schema file is the field source — class markers would mint the
      // same logical model a second time under its class name.
      const demoted: ModelSchemaSupport = { ...descriptor };
      delete demoted.modelBaseClasses;
      delete demoted.weakModelBaseClasses;
      overrides.set(lang.id, demoted);
    }
  }
  return { models, overrides };
}

/** Walk + extract + assemble + union. Files that don't parse are skipped,
 *  never fatal. */
export async function gatherModelSet(opts: GatherModelOptions): Promise<ModelSet> {
  const extensions = allModelSchemaSourceExtensions(LANGUAGES);
  const models: ModelEntity[] = [];
  const dynamicModels: DynamicModelSite[] = [];
  const typeRefs = new Set<string>();
  const candidates: ModelEntity[] = [];

  for (const root of opts.roots) {
    const schemaFiles = await gatherSchemaFiles(root, opts.relativeTo);
    models.push(...schemaFiles.models);

    if (extensions.length > 0) {
      for (const rel of walkSourceFiles(root, { extensions })) {
        const abs = join(root, rel);
        const set = await extractFileModels(
          abs,
          opts.relativeTo ? relative(opts.relativeTo, abs) : abs,
          schemaFiles.overrides,
        );
        if (!set) continue;
        models.push(...set.models);
        dynamicModels.push(...set.dynamicModels);
        for (const ref of set.typeRefs ?? []) typeRefs.add(ref);
        candidates.push(...(set.candidates ?? []));
      }
    }
  }

  // Type-reference promotion (EF Core): a candidate class named by some
  // container's wrapped property is a model, wherever it lives.
  if (typeRefs.size > 0) {
    for (const c of candidates) {
      if (!typeRefs.has(c.name)) continue;
      models.push(c);
      if (c.fields.length === 0) {
        dynamicModels.push({ name: c.name, file: c.file, line: c.line });
      }
    }
  }

  for (const spec of opts.specs ?? []) {
    const specModels = loadSpecModels(spec);
    const label = opts.relativeTo ? relative(opts.relativeTo, spec) : spec;
    models.push(...specModels.map((m) => ({ ...m, file: label })));
  }

  return { models: mergePartialEntities(models), dynamicModels };
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
