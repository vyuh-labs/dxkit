/**
 * `vyuh-dxkit schema` — the model-schema surface a developer drives by hand.
 *
 * Two subcommands, both thin orchestration over the canonical modules:
 *   - `schema [inventory]` — the standing catalog: every model the repo
 *     declares (code extraction + `schema.specs`), per file, with
 *     unreadable-type disclosure. Reads through `gatherRepoModelSet`
 *     (Rule 2 — policy config applied, cannot be forgotten).
 *   - `schema diff [--ref <base>]` — the drift preview a developer runs
 *     before pushing: the SAME `diffModelSets` + verdict assignment the
 *     guardrail gate uses (`evaluateSchemaDriftGate`), against the same
 *     default base resolution, so the preview and the gate can never tell
 *     two stories (pinned by the parity test).
 *
 * Setup is folded into `configure` / policy (there is no `schema init`);
 * diagnosis is doctor's job; gating is `guardrail check` — the flow-surface
 * precedent.
 */

import * as path from 'path';
import * as logger from './logger';
import { gatherModelSet, gatherRepoModelSet } from './analyzers/model-schema/gather';
import { readSchemaConfig } from './analyzers/model-schema/config';
import {
  describeSchemaDrift,
  evaluateSchemaDriftGate,
  type SchemaDriftFinding,
} from './analyzers/model-schema/gate';
import type { ModelSet } from './analyzers/model-schema/model';
import { withRefWorktree } from './baseline/ref-baseline';
import { probeOriginHeadRef } from './baseline/modes';

/** `schema inventory` — list every declared model with its fields. */
export async function runSchemaInventory(cwd: string, opts: { json?: boolean }): Promise<void> {
  const set = await gatherRepoModelSet(cwd, { relativeTo: cwd });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ schema: 'schema-inventory.v1', ...set }, null, 2) + '\n');
    return;
  }
  if (set.models.length === 0) {
    logger.info('No declared data models found.');
    logger.info(
      'Recognition is marker-based (ORM base classes, entity decorators, Go struct tags) ' +
        'plus spec-declared models — point `.dxkit/policy.json:schema.specs` at an OpenAPI/' +
        'JSON Schema file to cover unmarked DTOs.',
    );
    return;
  }
  logger.info(logger.bold(`Declared data models (${set.models.length})`));
  for (const m of [...set.models].sort((a, b) => a.name.localeCompare(b.name))) {
    logger.info('');
    logger.info(`  ${logger.bold(m.name)}  (${m.via})  ${m.file}:${m.line}`);
    for (const f of m.fields) {
      const req = f.required === null ? '?' : f.required ? 'required' : 'optional';
      logger.info(`    ${f.name}: ${f.type ?? '<unreadable>'}  [${req}]`);
    }
    if (m.fields.length === 0) logger.info('    (no statically readable fields)');
  }
  if (set.dynamicModels.length > 0) {
    logger.info('');
    logger.info(
      logger.bold(`Dynamic models (${set.dynamicModels.length})`) +
        ' — recognized but not statically enumerable; their drift is not gateable:',
    );
    for (const d of set.dynamicModels) logger.info(`  ${d.name}  ${d.file}:${d.line}`);
  }
}

/** `schema diff --ref <base>` — preview drift vs a base ref, through the
 *  exact evaluation the guardrail gate runs. */
export async function runSchemaDiff(
  cwd: string,
  opts: { ref?: string; json?: boolean },
): Promise<void> {
  const config = readSchemaConfig(cwd);
  // Default base = the guardrail's own resolution (the remote default
  // branch), so the preview and the gate judge against the same ref.
  const ref = opts.ref ?? probeOriginHeadRef(cwd) ?? 'origin/main';

  const headModels = await gatherRepoModelSet(cwd, { relativeTo: cwd });
  let baseModels: ModelSet;
  try {
    baseModels = await withRefWorktree({ cwd, ref }, async (wt) =>
      gatherModelSet({
        roots: [wt],
        specs: config.specs.map((s) => path.resolve(wt, s)),
        relativeTo: wt,
      }),
    );
  } catch {
    logger.fail(`Could not gather models at base ref '${ref}' — pass --ref <base>.`);
    process.exit(1);
  }

  const findings = evaluateSchemaDriftGate({
    baseModels,
    headModels,
    blockThreshold: config.blockThreshold,
  });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ schema: 'schema-diff.v1', ref, findings }, null, 2) + '\n',
    );
    return;
  }
  if (findings.length === 0) {
    logger.info(`No schema drift vs ${ref}.`);
    return;
  }
  const groups: Array<[SchemaDriftFinding['verdict'], string]> = [
    ['block', 'Breaking (would block)'],
    ['warn', 'Warnings'],
    ['info', 'Informational'],
  ];
  for (const [verdict, title] of groups) {
    const of = findings.filter((f) => f.verdict === verdict);
    if (of.length === 0) continue;
    logger.info(logger.bold(`${title} (${of.length})`));
    for (const f of of) {
      logger.info(`  ${describeSchemaDrift(f)}`);
      if (verdict !== 'info') logger.info(`    · fingerprint: ${f.id}`);
    }
    logger.info('');
  }
  logger.info(
    `Gate posture: schema.mode=${config.mode}. A deliberate breaking change ships with ` +
      `an expiring accepted-risk allowlist entry (allowlist add --fingerprint=<id> ` +
      `--kind=model-schema-drift --category=accepted-risk).`,
  );
}
