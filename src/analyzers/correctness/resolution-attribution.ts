/**
 * Pre-push attribution for import-resolution failures (4.3.3) — a sound
 * base-side answer WITHOUT a base worktree run, so the one hook surface that
 * cannot afford a two-sided floor still obeys the floor's law: only a
 * net-new failure blocks.
 *
 * The class this closes, observed live on a real repository: a chore branch
 * bumping one unrelated lockfile entry escalated the pre-push floor to full
 * scope, and the repo's PRE-EXISTING phantom imports (specifiers imported by
 * untouched files, declared in no manifest at the base either) hard-blocked
 * the push — debt the change cannot have caused, blamed on the change.
 */

import { execFileSync } from 'child_process';

import { dependencyManifestFilesIn } from '../../languages';
import { basePackageEvidence } from './lockfile-evidence';
import type { LanguageSupport } from '../../languages/types';
import {
  PROJECT_PATH_IDENTITY_PREFIX,
  isProjectPathIdentity,
} from '../../languages/capabilities/correctness';
import { IMPORT_RESOLUTION_LABEL, UNRESOLVED_REMEDY, type CorrectnessFloorResult } from './run';
import { attributeFloorFailures, type FloorBaseCheck } from './attribution';

/** Base-side evidence for a failing resolution check: the identities
 *  refuted as pre-existing, the identities the probe could NOT decide
 *  (rendered non-blocking by the caller: a common basename is the repo's
 *  shape, not the developer's fault), and every disclosure the probe owes:
 *  never a silent flip in either direction. */
export interface ResolutionRefutation {
  readonly refuted: readonly string[];
  /** Identities whose base evidence hit a ceiling: not refuted, not
   *  attributable. The pre-push caller folds them into the base side so
   *  they WARN instead of blocking; each carries a disclosure. */
  readonly undecided: readonly string[];
  readonly disclosures: readonly string[];
}

/** Candidate-file ceiling per project-path identity: past it the basename
 *  is too common to read cheaply, so the identity degrades to DISCLOSED
 *  undecided (warn, never block: on the first run after an upgrade there
 *  is no debt envelope to mitigate a false block). */
const MAX_BASE_CANDIDATE_FILES = 2000;

/** How many candidate blobs to batch-read per round: a hit in an early
 *  round terminates without reading the rest. */
const BLOB_READ_CHUNK = 100;

/**
 * Read many blobs at a ref in ONE git process (`cat-file --batch`), byte-
 * exact: a header `<oid> blob <size>` precedes each body. Returns the
 * content per requested path (absent when git reports it missing).
 */
function readBlobsAtRef(
  cwd: string,
  baseSha: string,
  files: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (files.length === 0) return out;
  const buf = execFileSync('git', ['cat-file', '--batch'], {
    cwd,
    input: files.map((f) => `${baseSha}:${f}`).join('\n') + '\n',
    maxBuffer: 512 * 1024 * 1024,
  });
  let pos = 0;
  for (const file of files) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    const m = /^\S+ blob (\d+)$/.exec(header);
    if (!m) continue; // `<name> missing` (or a non-blob): nothing to read
    const size = Number(m[1]);
    out.set(file, buf.toString('utf8', pos, pos + size));
    pos += size + 1; // body + trailing newline
  }
  return out;
}

/**
 * Sound base-side evidence for unresolved import specifiers, WITHOUT a base
 * worktree run. A specifier could only have resolved at the merge base if
 * some package by that name was installed there — and every install is
 * recorded in a manifest/lockfile. So:
 *
 *   - NO base manifest/lockfile evidences a package by that name — the
 *     format-aware installed/declared set where the format is modeled
 *     (`lockfile-evidence.ts`, #284: a lockfile MENTIONS names it does not
 *     install, e.g. peer metadata inside another entry, and short names
 *     are substrings of longer ones — both read as falsely "present" under
 *     the old whole-blob containment and turned a pre-existing phantom
 *     into a net-new block), textual containment where it is not (a false
 *     "present" merely keeps the block), AND
 *   - the base tree already carried the import (the QUOTED specifier appears
 *     in base source — quoting excludes prose mentions, and a false "absent"
 *     merely keeps the block)
 *
 *   ⇒ the specifier was ALREADY unresolvable at the base: pre-existing
 *     phantom-dependency debt this change cannot have caused. Refuted.
 *
 * A PROJECT-PATH identity (a relative import whose target is missing) is
 * never a manifest question: it is refuted only when the base tree ALSO
 * lacked the target AND a base source file already imported it, decided by
 * the pack's own extractor on the base blob (`projectPathMissingAtBase`).
 *
 * Everything else stays attributable (the un-hoist class the resolution
 * check exists for: a specifier the base lockfile DID provide transitively
 * is an installed-tree KEY, reads as present, and keeps blocking; a newly-
 * added import of an undeclared package is absent from base source and
 * keeps blocking). Every uncertainty lands on "keep blocking" — the
 * refutation only fires when the base evidence is decisive, and a probe
 * that could not decide says so in `disclosures`. Returns null when the
 * base side is unreadable (no refutation, behavior unchanged).
 * Exported for tests.
 */
export function refutedResolutionSpecifiers(
  cwd: string,
  baseSha: string,
  packs: readonly LanguageSupport[],
  specifiers: readonly string[],
): ResolutionRefutation | null {
  if (specifiers.length === 0) return { refuted: [], undecided: [], disclosures: [] };
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  try {
    const treeFiles = git(['ls-tree', '-r', '--name-only', '-z', baseSha])
      .split('\0')
      .filter(Boolean);
    const manifestPaths = dependencyManifestFilesIn(treeFiles, packs);
    const manifestBlobs = manifestPaths.map((p) => {
      const blob = ((): string => {
        try {
          return git(['show', `${baseSha}:${p}`]);
        } catch {
          // An unreadable manifest blob makes base evidence non-decisive for
          // every specifier — fail toward keeping the block.
          throw new Error(`unreadable base manifest ${p}`);
        }
      })();
      // Format-aware installed/declared set where the format is modeled;
      // null keeps the containment fallback for that file (#284).
      return { blob, evidence: basePackageEvidence(p, blob) };
    });
    const refuted: string[] = [];
    const undecided: string[] = [];
    const disclosures: string[] = [];
    for (const spec of specifiers) {
      if (isProjectPathIdentity(spec)) {
        const verdict = projectPathMissingAtBase(cwd, git, baseSha, treeFiles, packs, spec);
        if (verdict === true) refuted.push(spec);
        else if (verdict !== false) {
          if ('undecided' in verdict) {
            undecided.push(spec);
            disclosures.push(verdict.undecided);
          } else {
            disclosures.push(verdict.kept); // block kept, reason surfaced
          }
        }
        continue;
      }
      const maybeProvidedAtBase = manifestBlobs.some(({ blob, evidence }) =>
        evidence !== null ? evidence.has(spec) : blob.includes(spec),
      );
      if (maybeProvidedAtBase) continue;
      // Quoted-containment probe for the import existing at base. `git grep`
      // exits 1 on no match — treated as "not imported at base" (keep block).
      const importedAtBase = [`'${spec}'`, `"${spec}"`].some((needle) => {
        try {
          git(['grep', '-l', '--fixed-strings', needle, baseSha]);
          return true;
        } catch {
          return false;
        }
      });
      if (importedAtBase) refuted.push(spec);
    }
    return { refuted, undecided, disclosures };
  } catch {
    return null;
  }
}

/**
 * Was a project-path identity (`./src/x`, see `projectPathIdentity`) ALREADY
 * unreachable at the base? `true` only when BOTH hold: no base tree entry
 * serves the target (the exact path, any extension, or anything below it
 * as a directory), AND a base source file's relative imports, read through
 * the PACK'S OWN `relativeImportIdentities` on the blob (the same
 * extractor, comment/template handling and test/static-dir exclusions the
 * current side used, Rule 2.30), mint that identity. `false` keeps the
 * block. The two non-boolean verdicts are DISCLOSED, never silent: a
 * candidate ceiling yields `{ undecided }` (the caller renders the
 * identity non-blocking, a warn, since a common basename is not the
 * developer's doing), and a git failure yields `{ kept }` (block kept,
 * reason surfaced).
 */
function projectPathMissingAtBase(
  cwd: string,
  git: (args: string[]) => string,
  baseSha: string,
  treeFiles: readonly string[],
  packs: readonly LanguageSupport[],
  identity: string,
): boolean | { undecided: string } | { kept: string } {
  const target = identity.slice(PROJECT_PATH_IDENTITY_PREFIX.length);
  const served = treeFiles.some(
    (f) => f === target || f.startsWith(target + '.') || f.startsWith(target + '/'),
  );
  if (served) return false;
  const readers = packs
    .map((p) => p.correctness?.relativeImportIdentities)
    .filter((r): r is NonNullable<typeof r> => typeof r === 'function');
  if (readers.length === 0) return false;
  const basename = target.slice(target.lastIndexOf('/') + 1);
  const pathspecs = [...new Set(packs.flatMap((p) => p.sourceExtensions ?? []))].map(
    (e) => `*${e}`,
  );
  // Candidate FILES by import-shaped needles (`-l -z`: NUL-delimited, a
  // path containing `:` still parses). A relative specifier always carries
  // `/` before its basename (`./db` and `../x/db` both contain `/db`), and
  // ends at a quote, an extension dot, or a deeper segment, so the four
  // fixed needles cover every spelling while keeping a short basename
  // (`db`, `ui`) from matching arbitrary prose. Every candidate's WHOLE
  // blob is then batch-read in chunks (a hit terminates early), decided by
  // the pack's reader with complete comment and template context (a
  // multi-line `import {...} from './x'` needs the whole file, not the
  // matched line). Exit 1 = no hit.
  let candidates: string[];
  try {
    candidates = git([
      'grep',
      '-l',
      '-z',
      '--fixed-strings',
      '-e',
      `/${basename}'`,
      '-e',
      `/${basename}"`,
      '-e',
      `/${basename}.`,
      '-e',
      `/${basename}/`,
      baseSha,
      '--',
      ...pathspecs,
    ])
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf(':') + 1));
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return false; // no candidate: not imported at base
    return {
      kept: `${identity}: could not read the base for prior importers (git grep failed: ${
        err instanceof Error ? err.message.split('\n')[0] : String(err)
      }); kept as attributable`,
    };
  }
  if (candidates.length > MAX_BASE_CANDIDATE_FILES) {
    return {
      undecided: `${identity}: ${candidates.length} base files mention '/${basename}', too many to read; cannot attribute, so it warns instead of blocking here (CI's two-sided floor is authoritative)`,
    };
  }
  for (let start = 0; start < candidates.length; start += BLOB_READ_CHUNK) {
    const chunk = candidates.slice(start, start + BLOB_READ_CHUNK);
    let blobs: Map<string, string>;
    try {
      blobs = readBlobsAtRef(cwd, baseSha, chunk);
    } catch (err) {
      return {
        kept: `${identity}: could not read base blobs (${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }); kept as attributable`,
      };
    }
    for (const [file, blob] of blobs) {
      if (readers.some((read) => read(file, blob)?.includes(identity))) return true;
    }
  }
  return false;
}

/** Check-level base evidence for the pre-push surface: (pack, label) rows
 *  recorded FAILING in the committed baseline's floor-debt envelope, plus a
 *  short provenance string for the disclosure. */
export interface PrePushDebtEvidence {
  readonly rows: readonly FloorBaseCheck[];
  /** Where the evidence comes from (commit prefix or capture date). */
  readonly captured: string;
}

/**
 * Route a blocking pre-push floor result through the ONE attribution
 * comparator (`attributeFloorFailures`), with base evidence composed from
 * BOTH cheap sources the hook can afford (no base worktree run):
 *
 *   - FINDING-level: `refutedResolutionSpecifiers` for the resolution
 *     check — a specifier provably unresolvable at the merge base;
 *   - CHECK-level: the committed baseline's floor-debt envelope (when the
 *     caller supplies it) — a check recorded FAILING at baseline capture
 *     was already red before this branch existed, so blocking the push on
 *     it blames the developer for the repo's grandfathered debt. The
 *     shipped class: the CI floor correctly reported the same failures as
 *     pre-existing/unattributable while the local pre-push hook
 *     hard-blocked them (bypassed with --no-verify — a gate that trains
 *     bypassing). Check-level evidence cannot see ADDITIONAL failures
 *     inside an already-red check; the note says so, and CI's two-sided
 *     floor stays authoritative.
 *
 * Checks with NO base evidence keep the surface's point-in-time semantics
 * (`absentMeans: 'net-new'` — a failing check with no record still blocks
 * exactly as before). Returns null when there is nothing to adjust so the
 * caller keeps the original outcome byte-for-byte.
 */
export function attributePrePushResolution(
  cwd: string,
  baseSha: string,
  packs: readonly LanguageSupport[],
  result: CorrectnessFloorResult,
  debt?: PrePushDebtEvidence | null,
): { blocks: boolean; note: string } | null {
  const failingResolution = result.checks.filter(
    (c) => c.status === 'fail' && c.label === IMPORT_RESOLUTION_LABEL && c.findings?.length,
  );

  const baseRows: FloorBaseCheck[] = [];
  const resolutionCovered = new Set<string>();
  const evidenceByKey = new Map<string, ResolutionRefutation>();
  const probeDisclosures: string[] = [];
  for (const check of failingResolution) {
    const evidence = refutedResolutionSpecifiers(cwd, baseSha, packs, check.findings ?? []);
    if (evidence === null) continue;
    probeDisclosures.push(...evidence.disclosures);
    if (evidence.refuted.length === 0 && evidence.undecided.length === 0) continue;
    // Undecided identities join the base side so they WARN (each already
    // carries its disclosure), so the comparator reports net-new only
    // for identities the probe positively could not find at the base.
    baseRows.push({
      pack: check.pack,
      label: check.label,
      status: 'fail',
      findings: [...evidence.refuted, ...evidence.undecided],
    });
    resolutionCovered.add(`${check.pack}\0${check.label}`);
    evidenceByKey.set(`${check.pack}\0${check.label}`, evidence);
  }
  // Floor-debt rows for FAILING checks not already covered by the stronger
  // finding-level evidence (a debt row for the resolution check would erase
  // its per-specifier attribution).
  const debtDemoted: string[] = [];
  for (const row of debt?.rows ?? []) {
    const key = `${row.pack}\0${row.label}`;
    if (resolutionCovered.has(key)) continue;
    const failsNow = result.checks.some(
      (c) => c.status === 'fail' && c.pack === row.pack && c.label === row.label,
    );
    if (!failsNow) continue;
    baseRows.push({ pack: row.pack, label: row.label, status: 'fail' });
    debtDemoted.push(`${row.pack} ${row.label}`);
  }
  if (baseRows.length === 0 && probeDisclosures.length === 0) return null;

  const attributed = attributeFloorFailures(result, baseRows, { absentMeans: 'net-new' });
  const blocks = attributed.some((a) => a.attribution === 'net-new');
  const parts: string[] = [];
  for (const a of attributed) {
    if (a.check.label !== IMPORT_RESOLUTION_LABEL) continue;
    if (!resolutionCovered.has(`${a.check.pack}\0${a.check.label}`)) continue;
    const netNew = new Set(a.attribution === 'net-new' ? (a.netNewFindings ?? []) : []);
    const undecidedHere = new Set(
      evidenceByKey.get(`${a.check.pack}\0${a.check.label}`)?.undecided ?? [],
    );
    const refutedHere = (a.check.findings ?? []).filter(
      (f) => !netNew.has(f) && !undecidedHere.has(f),
    );
    // One note per identity class, the same split the check's own output
    // makes: a package is a manifest question, a project path is a tree one.
    const packages = refutedHere.filter((f) => !isProjectPathIdentity(f));
    const projectPaths = refutedHere.filter(isProjectPathIdentity);
    if (packages.length > 0) {
      parts.push(
        `${packages.length} unresolved package import(s) are PRE-EXISTING: already unresolvable at the ` +
          `merge base ${baseSha.slice(0, 12)} (absent from its manifests/lockfiles, already ` +
          `imported there), not blocked. ${UNRESOLVED_REMEDY.package}`,
      );
    }
    if (projectPaths.length > 0) {
      parts.push(
        `${projectPaths.length} missing relative import target(s) are PRE-EXISTING: the merge base ` +
          `${baseSha.slice(0, 12)} lacked them too and already imported them, not blocked. ` +
          UNRESOLVED_REMEDY.projectPath,
      );
    }
    if (a.attribution === 'net-new' && a.netNewFindings?.length) {
      parts.push(`net-new unresolved import(s) BLOCK: ${a.netNewFindings.join(', ')}`);
    }
  }
  if (debtDemoted.length > 0) {
    parts.push(
      `${debtDemoted.join(', ')}: recorded failing in the committed baseline's floor-debt ` +
        `envelope (${debt!.captured}) — pre-existing debt, not blocked at pre-push. ` +
        `Check-level evidence cannot see additional failures inside an already-red check; ` +
        `CI's two-sided floor is authoritative`,
    );
  }
  parts.push(...probeDisclosures);
  return { blocks, note: parts.length > 0 ? ` [${parts.join('; ')}]` : '' };
}
