/**
 * The go ecosystem's remediation capabilities (the pack's `remediation`,
 * Rule 6, the node-remediation.ts sibling): every Go-modules fact the
 * recipe executors consume through the capability seam.
 *
 * Doctrine notes, kept beside the declarations they explain:
 *   - go.mod and go.sum are TOOL-OWNED files: dxkit never hand-edits them
 *     (a text transform cannot maintain go.sum's checksums, and go.mod
 *     carries directives a naive edit can corrupt). The pin is therefore
 *     the seam's COMMAND shape: `go get pkg@vX.Y.Z` records an explicit
 *     require entry at the pinned version, and Go's minimal version
 *     selection makes the module graph take at least that version. One
 *     command, both files rewritten consistently, no separate resync.
 *   - A DIRECT dependency refuses the pin: the honest fix is upgrading
 *     the declared dependency (the dep-bump lane's job). Direct here
 *     means a require entry NOT marked `// indirect` in the root go.mod.
 *   - A module under a `replace` directive refuses: the replacement wins
 *     over any version pin, so the pin would be inert at best.
 *   - The version grammar accepts what Go advisories and module proxies
 *     actually carry: bare x.y.z (the OSV `Go` ecosystem shape) and
 *     v-prefixed semver, including pseudo-versions
 *     (v0.0.0-20240101000000-abcdefabcdef, which order by their
 *     timestamped prerelease segment under the one semver comparator).
 *   - `declareDependency` is a REASONED EXEMPTION: the go compiler IS the
 *     import-resolution floor (the pack declares no `resolutionCheck`),
 *     so no unresolved-import orders are ever minted, and the declare
 *     recipe's resolution verify would have nothing to re-run; `go get`
 *     serves it if that floor ever lands for compiled packs.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  PinPlanResult,
  PinTransitiveProvider,
  PinVersionScheme,
  RemediationSupport,
} from './capabilities/remediation';
import { compareConcreteSemver, isConcreteSemver } from './capabilities/remediation';
import { GO_MOD_EXECUTION } from './go-install';

/**
 * A Go module path shape (letters, digits, and `- . _ ~` in slash-separated
 * segments, each starting alphanumeric). Load-bearing for the Rule 11
 * argument-injection discipline: the path lands in a `go get` argv, so a
 * leading dash or whitespace must be rejected before any argv exists. Also
 * refuses the query forms go itself would interpret (`...`, a leading
 * `./`), which never name one module.
 */
const GO_MODULE_PATH =
  /^[A-Za-z0-9]([A-Za-z0-9._~-]*[A-Za-z0-9])?(\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/;

export function isValidGoModulePath(name: string): boolean {
  return name.length > 0 && name.length <= 500 && GO_MODULE_PATH.test(name) && !name.includes('..');
}

/** The bare-semver core of a possibly v-prefixed Go version. */
const stripV = (v: string): string => (v.startsWith('v') ? v.slice(1) : v);

/**
 * The Go pin-version grammar (Rule 6): OSV's `Go` ecosystem reports bare
 * x.y.z fixed versions while the module system spells them vX.Y.Z, so both
 * are concrete here and order under the ONE semver comparator (which also
 * orders pseudo-versions: their timestamped prerelease segment is
 * fixed-width, so bytewise identifier order is chronological order).
 */
const goPinVersions: PinVersionScheme = {
  concrete: (v) => isConcreteSemver(stripV(v)),
  compare: (a, b) => compareConcreteSemver(stripV(a), stripV(b)),
};

/** Is `pkg` required DIRECTLY by this go.mod (a require entry without the
 *  `// indirect` marker)? Line-level scan of both the block and one-line
 *  require forms; refusal-biased (its consumer only ever refuses a pin). */
function goModRequiresDirectly(goMod: string, pkg: string): boolean {
  const lines = goMod.split('\n');
  let inRequire = false;
  for (const line of lines) {
    if (/^\s*require\s*\(\s*$/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire && /^\s*\)\s*$/.test(line)) {
      inRequire = false;
      continue;
    }
    const entry = inRequire
      ? line.match(/^\s*(\S+)\s+\S+\s*(\/\/.*)?$/)
      : line.match(/^\s*require\s+(\S+)\s+\S+\s*(\/\/.*)?$/);
    if (entry && entry[1] === pkg && !/\/\/\s*indirect\b/.test(entry[2] ?? '')) return true;
  }
  return false;
}

/** Does this go.mod carry a `replace` directive naming `pkg`? */
function goModReplaces(goMod: string, pkg: string): boolean {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^\\s*replace\\s+${escaped}(\\s|=)`, 'm').test(goMod)) return true;
  // The block form: any line inside `replace ( ... )` starting with pkg.
  const block = goMod.match(/^\s*replace\s*\(([\s\S]*?)^\s*\)/m);
  return block !== null && new RegExp(`^\\s*${escaped}(\\s|=)`, 'm').test(block[1]);
}

const goPinTransitive: PinTransitiveProvider = {
  manifestFiles: ['go.mod'],
  osvEcosystem: 'Go',
  versions: goPinVersions,
  plan(ctx): PinPlanResult {
    // Rule 11: both tokens land in a `go get` argv verbatim.
    if (!isValidGoModulePath(ctx.pkg) || !goPinVersions.concrete(ctx.version)) {
      return {
        kind: 'refused',
        reason: `'${ctx.pkg}@${ctx.version}' is not a Go module path + semver version shape dxkit will hand to the go tool`,
      };
    }
    const goModPath = path.join(ctx.cwd, ctx.rootDir, 'go.mod');
    let goMod: string;
    try {
      goMod = fs.readFileSync(goModPath, 'utf8');
    } catch {
      return {
        kind: 'refused',
        reason: `no readable go.mod exists at ${ctx.rootDir || 'the repo root'}, so there is no module to pin in`,
      };
    }
    if (goModRequiresDirectly(goMod, ctx.pkg)) {
      return {
        kind: 'refused',
        reason:
          `'${ctx.pkg}' is a direct requirement of this module; the honest fix is upgrading ` +
          'the declared dependency (the dep-bump lane), not pinning it',
      };
    }
    if (goModReplaces(goMod, ctx.pkg)) {
      return {
        kind: 'refused',
        reason:
          `'${ctx.pkg}' is under a replace directive in this go.mod, which wins over any ` +
          'version pin; this pin stays on the agent tier',
      };
    }
    const version = ctx.version.startsWith('v') ? ctx.version : `v${ctx.version}`;
    const at = ctx.rootDir ? `${ctx.rootDir}/` : '';
    return {
      kind: 'command',
      command: { bin: 'go', args: ['get', `${ctx.pkg}@${version}`] },
      writes: ['go.mod', 'go.sum'],
      revert:
        `remove the '${ctx.pkg}' require entry from ${at}go.mod and run 'go mod tidy' ` +
        '(tidy drops it once nothing needs the pin)',
      notes: [
        `go get records the pin as an explicit require entry in go.mod (marked indirect); ` +
          'minimal version selection keeps the module graph at or above it',
      ],
    };
  },
  execution: () => GO_MOD_EXECUTION,
};

/** The go pack's remediation declarations: resync + pin + lintFix are
 *  capabilities (the resync rides `goInstallStrategy`, the lint fix rides
 *  the golangci-lint `fixCommand`; Rule 2: one code path each); declare is
 *  the reasoned exemption the doctrine block above explains. */
export const goRemediation: RemediationSupport = {
  resyncLockfile: { kind: 'capability', provider: { manifestFiles: ['go.mod'] } },
  pinTransitive: { kind: 'capability', provider: goPinTransitive },
  declareDependency: {
    kind: 'exemption',
    reason:
      'the go compiler is the import-resolution floor for this pack (no resolutionCheck is ' +
      'declared), so unresolved-import orders are never minted and a declare could not be ' +
      'resolution-verified; these orders stay on the agent tier',
  },
  lintFix: { kind: 'capability' },
};
