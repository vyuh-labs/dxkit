/**
 * The ONE extension runner — every extension execution flows through
 * `runExtension` (arch-gated; mirror of Rule 17's custom-check runner
 * discipline). Nothing else in the codebase may spawn an extension.
 *
 * Execution model (the design's rung 3): the extension gets its committed
 * config block + canonical repo facts as JSON on stdin, runs with the repo
 * root as cwd under the shared bounded-exec primitive, and its emitted wire
 * document (the manifest's `output` file, or stdout as the fallback) is
 * validated against its contribution kind's registry entry. A valid emit is
 * rewritten to the output path as pretty-printed canonical JSON with a
 * `generatedAt` stamp (an additive extra field — the snapshot format IS the
 * wire format), ready to commit.
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
import type { WireDoc } from '@vyuhlabs/dxkit-sdk';
import { makeCommandExec, type CommandExec } from '../analyzers/tools/bounded-exec';
import { parseWireDocText } from './contributions';
import { DEFAULT_TIMEOUT_SECONDS, type LoadedExtension } from './manifest';

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
}

/**
 * Run one extension and validate + persist its emission. See the module
 * header for policy; this function owns the mechanics only.
 */
export function runExtension(
  cwd: string,
  ext: LoadedExtension,
  opts: RunExtensionOptions = {},
): ExtensionRunOutcome {
  const { manifest } = ext;
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

  // Persist the canonical snapshot: the validated wire doc + a generatedAt
  // stamp (additive extra — validators tolerate it by design, so the
  // snapshot round-trips through the same parse path).
  const stamped = { ...(parsed.doc as unknown as Record<string, unknown>) };
  stamped['generatedAt'] = (opts.now?.() ?? new Date()).toISOString();
  fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
  fs.writeFileSync(outputAbs, `${JSON.stringify(stamped, null, 2)}\n`);

  return { status: 'ok', doc: parsed.doc, schemaId: parsed.schemaId, outputPath: manifest.output };
}
