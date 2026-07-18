/**
 * Baseline ENVELOPE metadata — the repo/analysis-environment facts stamped
 * on every `BaselineFile` (`repo.commitSha`/`branch`, the policy / ignore /
 * config / toolchain hashes). Split from `create.ts` (which orchestrates
 * the capture) so the envelope derivation is one small cohesive unit.
 *
 * These hashes are a distinct concern from finding-identity fingerprints
 * (Rule 9): they never enter the matcher's identity space — they exist so
 * the guardrail can tell "the environment moved" apart from "the developer
 * changed something".
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { VERSION as DXKIT_VERSION } from '../constants';
import { DEFAULT_BROWNFIELD_POLICY } from './policy';
import type { BaselineAnalysisMeta } from './baseline-file';

/** Hash used for baseline-envelope metadata fields (policy, ignore,
 *  toolchain, config). */
export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16); // fingerprint-helper-ok: envelope-metadata hash, not finding identity
}

/**
 * Read a small file's text content with the canonical "absent → ''"
 * convention. Treating absent files as the empty string keeps the
 * downstream metadata hash stable across runs where the file is
 * still missing.
 */
function readOptionalFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Resolve the absolute commit SHA + branch name of the working tree.
 *  Empty strings when the directory isn't a git repo — the rest of
 *  the orchestrator works fine, only the git-aware matcher loses its
 *  diff anchor on a future check. */
export function readRepoState(cwd: string): { commitSha: string; branch: string } {
  const run = (...args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  };
  return {
    commitSha: run('rev-parse', 'HEAD'),
    branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
  };
}

/** Build the analysis-environment hash bundle from the live repo.
 *  `toolchainHash` is filled in by `createBaseline` once the per-tool
 *  version map has been resolved (depends on the gather). */
export function buildAnalysisMeta(cwd: string): BaselineAnalysisMeta {
  const policyHash = hashContent(JSON.stringify(DEFAULT_BROWNFIELD_POLICY));
  const ignoreHash = hashContent(readOptionalFile(path.join(cwd, '.dxkit-ignore')));
  const configHash = hashContent(readOptionalFile(path.join(cwd, '.vyuh-dxkit.json')));
  return { dxkitVersion: DXKIT_VERSION, policyHash, ignoreHash, toolchainHash: '', configHash };
}
