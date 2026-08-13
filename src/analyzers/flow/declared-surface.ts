/**
 * The per-member DECLARED served surface (#308, 4.4.1 WP8).
 *
 * A workspace member whose routes live in a framework DSL the mesh
 * extractor cannot parse reported `routes: 0`, and every `--flows` step
 * false-blocked against the empty mesh. Framework-specific extraction
 * would cover one DSL at a time; this is the generic escape hatch: an
 * optional `dxkit-surface.json` at the member root —
 *
 *     { "serves": ["GET /api/orders", "POST /api/orders", "ANY /health"] }
 *
 * — whose entries join the served mesh EXACTLY as extracted routes do
 * (same normalizer, same catch-all semantics, full participation in
 * no-route / dead-route / flow resolution), labeled as DECLARED rather
 * than extracted (`via: 'declared-surface'`, and the wave outcome
 * discloses per-member declared counts) so a verdict reader can tell an
 * observed surface from an asserted one. Malformed entries are
 * DISCLOSED, never silently dropped — a typo'd declaration must not
 * silently shrink the mesh. An OpenAPI document is the richer
 * alternative: a member's own `.dxkit/policy.json` `flow.specs` already
 * joins specs into its model, and the wave honors per-member config.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ANY_METHOD, normalizeMethod, normalizePath } from './normalize';
import type { RouteEndpoint } from './extract';

export const DECLARED_SURFACE_FILENAME = 'dxkit-surface.json';

export interface DeclaredSurface {
  readonly routes: readonly RouteEndpoint[];
  /** Entries that could not be parsed — disclosed by every consumer. */
  readonly malformed: readonly string[];
}

/** Read a member's declared surface. Null when the file is absent (the
 *  overwhelmingly common case — nothing is inferred). A present-but-
 *  unreadable file is a surface with one malformed entry, never a silent
 *  nothing. */
export function readDeclaredSurface(memberRoot: string): DeclaredSurface | null {
  const file = path.join(memberRoot, DECLARED_SURFACE_FILENAME);
  if (!fs.existsSync(file)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { routes: [], malformed: [`${DECLARED_SURFACE_FILENAME}: ${(err as Error).message}`] };
  }
  const serves = (doc as { serves?: unknown })?.serves;
  if (!Array.isArray(serves)) {
    return {
      routes: [],
      malformed: [`${DECLARED_SURFACE_FILENAME}: expected { "serves": ["METHOD /path", …] }`],
    };
  }
  const routes: RouteEndpoint[] = [];
  const malformed: string[] = [];
  serves.forEach((entry, i) => {
    if (typeof entry !== 'string') {
      malformed.push(`serves[${i}]: expected a "METHOD /path" string`);
      return;
    }
    const m = entry.trim().match(/^(\S+)\s+(\S.*)$/);
    if (!m) {
      malformed.push(`serves[${i}] ("${entry}"): expected "METHOD /path"`);
      return;
    }
    const method = m[1].toUpperCase() === 'ANY' ? ANY_METHOD : normalizeMethod(m[1]);
    if (method === null) {
      malformed.push(`serves[${i}] ("${entry}"): unknown method "${m[1]}"`);
      return;
    }
    // The ONE normalizer — declared paths get the same {var} folding and
    // catch-all token treatment extracted routes get, so the mesh join
    // cannot fork on representation.
    const normalizedPath = normalizePath(m[2]);
    if (normalizedPath === null) {
      malformed.push(`serves[${i}] ("${entry}"): unparseable path "${m[2]}"`);
      return;
    }
    routes.push({
      method,
      path: normalizedPath,
      via: 'declared-surface',
      handler: null,
      file: DECLARED_SURFACE_FILENAME,
      line: i + 1,
    });
  });
  return { routes, malformed };
}
