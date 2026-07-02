/**
 * `.dxkit/workspace.json` — the cross-repo participants primitive.
 *
 * A deliberately shared seam, NOT nested under `flow`: it names the repos /
 * services that make up a system, and flow contributes the FIRST relationship
 * over it (consumer→provider api-bindings). Future cross-repo concerns
 * (shared-datastore, emits/consumes-event, build-dependency) read the same
 * participant list, so the primitive lives at the top level rather than inside
 * any one feature's config.
 *
 * A `participant` is a repo/service with a source path and optional base URLs
 * (the addresses its served routes answer on). An `external` is a third-party
 * API addressed by base URL — optionally with an OpenAPI spec dxkit consumes to
 * verify calls — that this system talks to but does not serve.
 *
 * Single reader/writer of the file (Rule 2). Fail-open: a missing or malformed
 * file yields `null` (no participants), never a throw — the same posture every
 * other flow surface takes toward optional config.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A repo/service in the system — a source root plus the base URLs its served
 *  routes answer on (used to attribute a consumed call to the provider it
 *  targets). `path` is repo-relative or a `../sibling` path. */
export interface WorkspaceParticipant {
  readonly name: string;
  readonly path: string;
  readonly baseUrls?: readonly string[];
  /** Git ref to pin the participant's contract at when publishing (e.g. `main`).
   *  Omitted → gather from the participant's current working tree. */
  readonly ref?: string;
}

/** A third-party API the system consumes but does not serve. `spec` (an
 *  OpenAPI/spec file) lets dxkit verify the call shape without serving it. */
export interface WorkspaceExternal {
  readonly name: string;
  readonly baseUrls?: readonly string[];
  readonly spec?: string;
}

export interface Workspace {
  readonly participants: readonly WorkspaceParticipant[];
  readonly external: readonly WorkspaceExternal[];
}

const WORKSPACE_REL = path.join('.dxkit', 'workspace.json');

/** Absolute path to a repo's workspace file. */
export function workspacePath(cwd: string): string {
  return path.join(cwd, WORKSPACE_REL);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function normalizeParticipant(v: unknown): WorkspaceParticipant | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { name?: unknown; path?: unknown; baseUrls?: unknown; ref?: unknown };
  if (typeof r.name !== 'string' || typeof r.path !== 'string') return null;
  const baseUrls = stringList(r.baseUrls);
  return {
    name: r.name,
    path: r.path,
    ...(baseUrls.length ? { baseUrls } : {}),
    ...(typeof r.ref === 'string' ? { ref: r.ref } : {}),
  };
}

function normalizeExternal(v: unknown): WorkspaceExternal | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { name?: unknown; baseUrls?: unknown; spec?: unknown };
  if (typeof r.name !== 'string') return null;
  const baseUrls = stringList(r.baseUrls);
  return {
    name: r.name,
    ...(baseUrls.length ? { baseUrls } : {}),
    ...(typeof r.spec === 'string' ? { spec: r.spec } : {}),
  };
}

/** Structure-check a parsed workspace object. Returns `null` when it names no
 *  participants and no externals (an empty file is indistinguishable from an
 *  absent one — both mean "no configured topology"). */
export function normalizeWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { participants?: unknown; external?: unknown };
  const participants = Array.isArray(r.participants)
    ? r.participants.map(normalizeParticipant).filter((p): p is WorkspaceParticipant => p !== null)
    : [];
  const external = Array.isArray(r.external)
    ? r.external.map(normalizeExternal).filter((e): e is WorkspaceExternal => e !== null)
    : [];
  if (participants.length === 0 && external.length === 0) return null;
  return { participants, external };
}

/** Read `.dxkit/workspace.json`. Fail-open: absent or malformed → `null`. */
export function readWorkspace(cwd: string): Workspace | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(workspacePath(cwd), 'utf8'));
  } catch {
    return null;
  }
  return normalizeWorkspace(raw);
}

/** Write `.dxkit/workspace.json`, creating `.dxkit/` as needed. */
export function writeWorkspace(cwd: string, ws: Workspace): void {
  const abs = workspacePath(cwd);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(ws, null, 2) + '\n', 'utf8');
}
