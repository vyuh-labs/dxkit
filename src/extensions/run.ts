/**
 * The ONE extension runner — every extension execution flows through
 * `runExtension` (arch-gated; mirror of Rule 17's custom-check runner
 * discipline). Nothing else in the codebase may spawn an extension.
 *
 * Execution model — ONE protocol, two transports (rungs above never fork
 * rungs below):
 *   - rung 3 (`run`): the extension gets its committed config block +
 *     canonical repo facts as JSON on stdin, runs with the repo root as cwd
 *     under the shared bounded-exec primitive, and emits its wire document
 *     via the manifest's `output` file (or stdout as the fallback);
 *   - rung 4 (`plugin` + `contributes`): the same context is passed as a
 *     call argument to the plugin's producer function, in-process; the
 *     returned object IS the emission.
 * Either way the document is validated against the contribution kind's
 * registry entry and a valid emit is rewritten to the output path as
 * pretty-printed canonical JSON with a `generatedAt` stamp (an additive
 * extra field — the snapshot format IS the wire format), ready to commit —
 * one validation + persist tail for both rungs.
 *
 * Fail-open policy, in one place: a missing interpreter or a timeout is a
 * disclosed SKIP (`status: 'skipped'`), never a broken gate — the backstop
 * is the refresh surface's own CI. A run that finished but emitted an
 * invalid document is `status: 'invalid'` with the field-precise errors —
 * loud in `extensions dev` and doctor, still never a crash.
 *
 * WHEN this runs (trust, load-bearing): only on trusted context at refresh
 * time — `extensions refresh` on a developer machine or the on-merge
 * workflow. Per-commit gates and `--untrusted` runs read committed
 * snapshots via `snapshot.ts` and never reach this module.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DxkitExtensionDefinition, VerifierFlowContext, WireDoc } from '@vyuhlabs/dxkit-sdk';
import { makeCommandExec, type CommandExec } from '../analyzers/tools/bounded-exec';
import { parseWireDoc, parseWireDocText } from './contributions';
import { loadPluginDefinition, PRODUCER_KEY_BY_KIND } from './plugin-host';
import {
  DEFAULT_TIMEOUT_SECONDS,
  isProducerExtension,
  type LoadedExtension,
  type ProducerExtension,
} from './manifest';

/** Canonical repo facts handed to every extension on stdin — extensions
 *  inherit the one source of truth for these instead of re-deriving it. */
export interface ExtensionStdinPayload {
  readonly payloadVersion: 1;
  readonly extension: { readonly name: string; readonly contributes: string };
  /** The manifest's committed `config` block, verbatim. */
  readonly config: Record<string, unknown>;
  readonly repo: {
    /** Directory basenames every dxkit analysis excludes (node_modules, …). */
    readonly excludeDirs: readonly string[];
    /** Active language-pack ids in this repo. */
    readonly activeLanguages: readonly string[];
  };
  /**
   * For EXPORT extensions only: the post-run document to deliver (a report
   * / verdict JSON the refresh surface hands over). The sink reads it from
   * here, delivers it wherever it likes, and returns an export.v1 receipt.
   * Absent for every other contribution kind.
   */
  readonly delivery?: unknown;
}

export type ExtensionRunOutcome =
  | {
      readonly status: 'ok';
      readonly doc: WireDoc;
      readonly schemaId: string;
      readonly outputPath: string;
    }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'invalid'; readonly errors: readonly string[] };

export interface RunExtensionOptions {
  /** Injected exec (tests); defaults to the bounded primitive. */
  readonly exec?: CommandExec;
  /** Repo facts for the stdin payload; callers pass the canonical values. */
  readonly excludeDirs?: readonly string[];
  readonly activeLanguages?: readonly string[];
  /** The document an EXPORT extension delivers (see stdin payload). */
  readonly delivery?: unknown;
  /** Clock injection for the generatedAt stamp (tests). */
  readonly now?: () => Date;
  /**
   * A pre-loaded plugin definition (the CLI loads once for verifier/flow
   * detection; passing it here avoids a second require). When absent, a
   * plugin producer loads its own module via the plugin host.
   */
  readonly pluginDefinition?: DxkitExtensionDefinition;
  /**
   * The gathered flow evidence for an `integrationVerifier` — supplied by
   * the refresh/dev surface (the runner never gathers; it runs).
   */
  readonly flow?: VerifierFlowContext;
}

/**
 * Run one extension and validate + persist its emission. See the module
 * header for policy; this function owns the mechanics only.
 */
export async function runExtension(
  cwd: string,
  ext: LoadedExtension,
  opts: RunExtensionOptions = {},
): Promise<ExtensionRunOutcome> {
  if (!isProducerExtension(ext)) {
    return {
      status: 'skipped',
      reason: 'gather-only plugin — its contributions load live at gather time, nothing to refresh',
    };
  }
  if (ext.manifest.plugin !== undefined) return runPluginProducer(cwd, ext, opts);
  return runCommandProducer(cwd, ext, opts);
}

/**
 * The rung-4 in-process branch: same protocol as the subprocess path —
 * config + repo facts in, ONE wire document out, validated against the
 * manifest's kind, stamped, snapshotted — with the producer function
 * called directly instead of over stdin/stdout. A throwing producer is an
 * invalid outcome; a producer that outlives its manifest timeout is a
 * disclosed skip (the promise is raced against an unref'd timer — the
 * honest bound for async producers; a synchronous producer that blocks
 * the event loop cannot be preempted in-process, which is why the refresh
 * surface's own CI timeout is the backstop).
 */
async function runPluginProducer(
  cwd: string,
  ext: ProducerExtension,
  opts: RunExtensionOptions,
): Promise<ExtensionRunOutcome> {
  const { manifest } = ext;
  const loaded =
    opts.pluginDefinition !== undefined
      ? ({ ok: true, definition: opts.pluginDefinition, disclosures: [] } as const)
      : loadPluginDefinition(cwd, ext);
  if (!loaded.ok) return { status: 'invalid', errors: loaded.errors };
  const def = loaded.definition;

  const verifier = manifest.contributes === 'findings' ? def.integrationVerifier : undefined;
  const producer = verifier ?? def[PRODUCER_KEY_BY_KIND[manifest.contributes]];
  if (typeof producer !== 'function') {
    return {
      status: 'invalid',
      errors: [`${ext.dir}: plugin exports no producer for contributes: '${manifest.contributes}'`],
    };
  }
  if (verifier && opts.flow === undefined) {
    return {
      status: 'skipped',
      reason:
        'integration verifier needs the gathered flow model — run via `extensions refresh`/`dev`',
    };
  }

  const ctx = {
    name: manifest.name,
    config: ext.config,
    repo: {
      root: path.resolve(cwd),
      excludeDirs: opts.excludeDirs ?? [],
      activeLanguages: opts.activeLanguages ?? [],
    },
    ...(manifest.contributes === 'export' ? { delivery: opts.delivery } : {}),
    ...(verifier ? { flow: opts.flow } : {}),
  };

  const timeoutSeconds = manifest.plugin?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  let emitted: unknown;
  try {
    emitted = await withTimeout(
      Promise.resolve((producer as (c: unknown) => unknown | Promise<unknown>)(ctx)),
      timeoutSeconds * 1000,
    );
  } catch (e) {
    if (e instanceof ProducerTimeout) {
      return { status: 'skipped', reason: `timed out after ${timeoutSeconds}s` };
    }
    return {
      status: 'invalid',
      errors: [`plugin producer threw — ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const parsed = parseWireDoc(manifest.contributes, emitted);
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };
  return persistSnapshot(cwd, manifest.output, parsed.doc, parsed.schemaId, opts.now);
}

class ProducerTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProducerTimeout()), ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function runCommandProducer(
  cwd: string,
  ext: ProducerExtension,
  opts: RunExtensionOptions,
): ExtensionRunOutcome {
  const { manifest } = ext;
  if (manifest.run === undefined) {
    return {
      status: 'invalid',
      errors: [`${ext.dir}: producer manifest has neither run nor plugin`],
    };
  }
  const timeoutMs = (manifest.run.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const exec = opts.exec ?? makeCommandExec(timeoutMs);
  const payload: ExtensionStdinPayload = {
    payloadVersion: 1,
    extension: { name: manifest.name, contributes: manifest.contributes },
    config: ext.config,
    repo: {
      excludeDirs: opts.excludeDirs ?? [],
      activeLanguages: opts.activeLanguages ?? [],
    },
    ...(opts.delivery !== undefined ? { delivery: opts.delivery } : {}),
  };

  const outputAbs = path.join(cwd, manifest.output);
  // Remove a stale output first so "file exists after the run" means the
  // RUN produced it, not a previous invocation.
  try {
    fs.rmSync(outputAbs, { force: true });
  } catch {
    /* a locked stale file surfaces below as an invalid/missing emit */
  }

  const outcome = exec(
    {
      bin: manifest.run.command,
      args: manifest.run.args ?? [],
      stdin: JSON.stringify(payload),
      captureFullOutput: true,
    },
    cwd,
  );

  if (!outcome.available) {
    return { status: 'skipped', reason: `interpreter '${manifest.run.command}' not found` };
  }
  if (outcome.timedOut) {
    return {
      status: 'skipped',
      reason: `timed out after ${manifest.run.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS}s`,
    };
  }
  if (outcome.code !== 0) {
    return {
      status: 'invalid',
      errors: [
        `extension exited ${outcome.code}${outcome.output ? ` — output tail: ${outcome.output.slice(-800)}` : ''}`,
      ],
    };
  }

  // Prefer the output file the extension wrote; fall back to stdout.
  let text: string | null = null;
  try {
    text = fs.readFileSync(outputAbs, 'utf-8');
  } catch {
    text = outcome.output.trim().length > 0 ? outcome.output : null;
  }
  if (text === null) {
    return {
      status: 'invalid',
      errors: [
        `extension exited 0 but wrote neither its output file (${manifest.output}) nor a document on stdout`,
      ],
    };
  }

  const parsed = parseWireDocText(manifest.contributes, text);
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };
  return persistSnapshot(cwd, manifest.output, parsed.doc, parsed.schemaId, opts.now);
}

/**
 * The shared persist tail (both rungs): the validated wire doc + a
 * generatedAt stamp (additive extra — validators tolerate it by design, so
 * the snapshot round-trips through the same parse path), pretty-printed at
 * the manifest's output path, ready to commit.
 */
function persistSnapshot(
  cwd: string,
  outputPath: string,
  doc: WireDoc,
  schemaId: string,
  now?: () => Date,
): ExtensionRunOutcome {
  const outputAbs = path.join(cwd, outputPath);
  const stamped = { ...(doc as unknown as Record<string, unknown>) };
  stamped['generatedAt'] = (now?.() ?? new Date()).toISOString();
  fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
  fs.writeFileSync(outputAbs, `${JSON.stringify(stamped, null, 2)}\n`);
  return { status: 'ok', doc, schemaId, outputPath };
}
