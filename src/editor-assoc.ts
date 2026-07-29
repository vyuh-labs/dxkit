/**
 * VS Code file-association for the JSONC policy file (decision A2).
 *
 * VS Code marks comments in a `.json` file red unless the file is associated
 * with the `jsonc` language — the same problem VS Code solves for its own
 * settings.json. When the repo ALREADY has a `.vscode/` directory (the team
 * uses editor settings), the scaffold step merges one association into
 * `.vscode/settings.json`; a repo without `.vscode/` is never given one (the
 * scaffold's header comment carries the information instead).
 *
 * Both directions are comment-preserving (`jsonc-parser` modify/applyEdits —
 * settings.json is itself JSONC) and both refuse a malformed file. The strip
 * is wired into uninstall's reversals, so the association follows the same
 * lifecycle as every other merge surface.
 */
import * as fs from 'fs';
import * as path from 'path';
import { applyEdits, modify } from 'jsonc-parser';
import { parseJsoncText, JSONC_EDIT_FORMAT } from './baseline/policy-text';

const ASSOCIATIONS_KEY = 'files.associations';
const POLICY_KEY = '.dxkit/policy.json';
const FORMAT = JSONC_EDIT_FORMAT;

function settingsPath(cwd: string): string {
  return path.join(cwd, '.vscode', 'settings.json');
}

/** Parse VS Code settings text through the ONE strict-JSONC primitive.
 *  Null on malformed/non-object (this surface is fail-open by contract). */
function parseSettings(text: string): Record<string, unknown> | null {
  try {
    const parsed = parseJsoncText(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Merge the policy-file JSONC association into `.vscode/settings.json`.
 * No-op (changed: false) when the repo has no `.vscode/` directory, the file
 * is malformed, or the association is already present.
 */
export function ensurePolicyJsoncAssociation(cwd: string): { changed: boolean } {
  if (!fs.existsSync(path.join(cwd, '.vscode'))) return { changed: false };
  const file = settingsPath(cwd);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}\n';
  const parsed = parseSettings(text);
  if (parsed === null) return { changed: false };

  const assoc = parsed[ASSOCIATIONS_KEY];
  if (
    typeof assoc === 'object' &&
    assoc !== null &&
    (assoc as Record<string, unknown>)[POLICY_KEY] === 'jsonc'
  ) {
    return { changed: false };
  }

  let next = applyEdits(
    text,
    modify(text, [ASSOCIATIONS_KEY, POLICY_KEY], 'jsonc', { formattingOptions: FORMAT }),
  );
  if (!next.endsWith('\n')) next += '\n';
  fs.writeFileSync(file, next, 'utf8');
  return { changed: true };
}

/** Read-only probe: would `stripPolicyJsoncAssociation` change the file? */
export function wouldStripPolicyJsoncAssociation(cwd: string): boolean {
  const file = settingsPath(cwd);
  if (!fs.existsSync(file)) return false;
  const parsed = parseSettings(fs.readFileSync(file, 'utf8'));
  const assoc = parsed?.[ASSOCIATIONS_KEY];
  return (
    typeof assoc === 'object' &&
    assoc !== null &&
    (assoc as Record<string, unknown>)[POLICY_KEY] === 'jsonc'
  );
}

/**
 * Remove the association (uninstall reversal). Prunes an emptied
 * `files.associations` object; leaves everything else untouched.
 */
export function stripPolicyJsoncAssociation(cwd: string): { changed: boolean } {
  const file = settingsPath(cwd);
  if (!fs.existsSync(file)) return { changed: false };
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseSettings(text);
  const assoc = parsed?.[ASSOCIATIONS_KEY];
  if (
    !assoc ||
    typeof assoc !== 'object' ||
    (assoc as Record<string, unknown>)[POLICY_KEY] !== 'jsonc'
  ) {
    return { changed: false };
  }

  const remaining = Object.keys(assoc as Record<string, unknown>).filter((k) => k !== POLICY_KEY);
  const target = remaining.length === 0 ? [ASSOCIATIONS_KEY] : [ASSOCIATIONS_KEY, POLICY_KEY];
  let next = applyEdits(text, modify(text, target, undefined, { formattingOptions: FORMAT }));
  if (next.trim() !== '' && !next.endsWith('\n')) next += '\n';
  fs.writeFileSync(file, next, 'utf8');
  return { changed: true };
}
