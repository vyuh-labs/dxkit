/**
 * The IN-PROCESS floor check executors, split from the runner for module
 * size: the import-resolution and structure checks are pure pack
 * computations (no spawn, no PATH, no timeout budget), plus the defensive
 * failure-parser wrapper for command output. Policy is unchanged and stays
 * one place per concern: a throw is infrastructure (disclosed skip, never a
 * verdict), findings carry durable per-item identities, and pass-time
 * disclosures ride the check so a partial answer never hides behind a green
 * check (Rule 19).
 */
import type { LanguageId } from '../../languages/types';
import {
  isProjectPathIdentity,
  type CorrectnessCommand,
  type CorrectnessContext,
  type CorrectnessProvider,
} from '../../languages/capabilities/correctness';
import type { CorrectnessCheckResult } from './run';

/** The one label the import-resolution check reports under — shared by the
 *  floor-state snapshot, the attribution comparator's finding-level path, and
 *  every renderer. */
export const IMPORT_RESOLUTION_LABEL = 'import-resolution';

/** The remedy line per unresolved-identity class: ONE rendering shared by
 *  the check's failure output and the pre-push attribution note. */
export const UNRESOLVED_REMEDY = {
  package:
    'An import of an uninstalled/undeclared package fails at build or run time. ' +
    'Declare it in the dependency manifest and install it (or remove the import).',
  projectPath:
    'A relative import of a file the pushed tree does not carry fails at build time. ' +
    'Commit the missing file (or remove the import).',
} as const;

/** Run a command's optional failure parser defensively: a parser throw or a
 *  non-array result is "not parseable" (null → check-level precision), never
 *  an error that breaks the floor. Results are deduped and order-normalized —
 *  identity must not depend on output order. */
export function parseFailuresSafely(cmd: CorrectnessCommand, output: string): string[] | null {
  try {
    const raw = cmd.parseFailures!(output);
    if (raw === null || !Array.isArray(raw)) return null;
    const cleaned = [...new Set(raw.filter((f) => typeof f === 'string' && f.length > 0))].sort();
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

/**
 * Execute a pack's optional import-resolution check (a pure computation, not a
 * command). Findings are keyed by SPECIFIER — the durable identity of "package
 * X does not resolve": a second file importing the same missing package is the
 * same root cause, while a NEW missing package on an already-red repo is a new
 * finding (the granularity the class fix requires). A throw is infrastructure:
 * disclosed skip, never a verdict.
 */
export function runResolutionCheck(
  id: LanguageId,
  provider: CorrectnessProvider,
  ctx: CorrectnessContext,
): CorrectnessCheckResult {
  const base = { pack: id, label: IMPORT_RESOLUTION_LABEL, bin: '' };
  try {
    const res = provider.resolutionCheck!(ctx);
    const disclosed = res.disclosures ?? [];
    const withDisclosures = disclosed.length > 0 ? { disclosures: disclosed } : {};
    if (res.kind === 'clean') return { ...base, status: 'pass', ...withDisclosures };
    if (res.kind === 'unresolved') {
      const lines = res.unresolved.map((u) =>
        isProjectPathIdentity(u.specifier)
          ? `'${u.specifier}' ${u.detail ?? 'does not exist in the repo tree'} (relative import in ${u.file})`
          : `'${u.specifier}' does not resolve against the installed tree (imported by ${u.file})`,
      );
      if (res.unresolved.some((u) => !isProjectPathIdentity(u.specifier))) {
        lines.push(UNRESOLVED_REMEDY.package);
      }
      if (res.unresolved.some((u) => isProjectPathIdentity(u.specifier))) {
        lines.push(UNRESOLVED_REMEDY.projectPath);
      }
      return {
        ...base,
        status: 'fail',
        output: lines.join('\n'),
        findings: [...new Set(res.unresolved.map((u) => u.specifier))],
        unresolved: res.unresolved.map((u) => ({ specifier: u.specifier, file: u.file })),
        ...withDisclosures,
      };
    }
    return { ...base, status: 'skipped-unavailable', output: res.reason, ...withDisclosures };
  } catch (err) {
    return {
      ...base,
      status: 'skipped-unavailable',
      output: `import-resolution check errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Execute a pack's optional STRUCTURE check (#309) — a pure computation
 * mirroring `runResolutionCheck`. Findings are keyed by FILE (the durable
 * identity of "this artifact is structurally broken"), so an already-red
 * tree still blocks on a NEW broken artifact through the one attribution
 * comparator. `none` returns null (nothing ran, nothing claimed); a throw
 * is infrastructure — disclosed skip, never a verdict.
 */
export function runStructureCheck(
  id: LanguageId,
  provider: CorrectnessProvider,
  ctx: CorrectnessContext,
): CorrectnessCheckResult | null {
  try {
    const res = provider.structureCheck!(ctx);
    if (res.kind === 'none') return null;
    const base = { pack: id, label: res.label, bin: '' };
    if (res.kind === 'clean') return { ...base, status: 'pass' };
    if (res.kind === 'broken') {
      const lines = res.findings.map((f) => `${f.file}: ${f.problem}`);
      lines.push(
        'A structurally implausible artifact fails downstream consumers at import time. ' +
          'This is a STRUCTURAL check (no parser covers this artifact class) — shallow by ' +
          'design, so a pass means "plausible", never "parsed".',
      );
      return {
        ...base,
        status: 'fail',
        output: lines.join('\n'),
        findings: [...new Set(res.findings.map((f) => f.file))],
      };
    }
    return { ...base, status: 'skipped-unavailable', output: res.reason };
  } catch (err) {
    return {
      pack: id,
      label: 'structure',
      bin: '',
      status: 'skipped-unavailable',
      output: `structure check errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
