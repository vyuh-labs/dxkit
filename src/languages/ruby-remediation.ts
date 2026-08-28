/**
 * The ruby ecosystem's remediation capabilities (the pack's `remediation`,
 * Rule 6, the node-remediation.ts sibling): every bundler/rubygems fact
 * the recipe executors consume through the capability seam.
 *
 * Doctrine notes, kept beside the declarations they explain:
 *   - Bundler has NO transitive-override mechanism; its community-standard
 *     fix is the EXPLICIT-ENTRY pin: declare the gem directly in the
 *     Gemfile at the exact patched version so the resolver must take it.
 *     The edit is a pure append at the top level (groups and platforms
 *     above are untouched), refused when the gem is already declared
 *     directly (the honest fix is upgrading the declared dependency, the
 *     dep-bump lane's job) or when the text does not look like a Gemfile.
 *   - `bundle add <gem> --version <v>` both edits the Gemfile and
 *     installs, and a plain version string is an exact requirement, so the
 *     declare capability rides it rather than a second Gemfile writer.
 *   - Ruby require names and gem names diverge (`active_support` is the
 *     gem activesupport); the resolution check folds them when READING,
 *     but declaring must never guess which gem an unmatched require means.
 *     The identity mapping plus the registry probe is the honest rail: a
 *     require that is not itself a published gem name fails the
 *     `gem search --exact` probe and refuses, never installs a guess.
 *   - The version probe is `gem search --remote --exact`, which resolves
 *     against the sources the repo's rubygems configuration declares.
 */
import type { ExecutionRequirement } from '../execution';
import type {
  DeclareDependencyProvider,
  ManifestTextEdit,
  PinPlanResult,
  PinTransitiveProvider,
  RemediationSupport,
} from './capabilities/remediation';

/** Remediation commands run on the ambient ruby toolchain (bundler and gem
 *  ship with it), any host, no build. */
const RUBY_REMEDIATION_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: ['ruby'],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
};

/**
 * A RubyGems gem-name shape. Load-bearing for the Rule 11 argument-
 * injection discipline: a specifier is attacker-influencable source text,
 * and a leading dash handed to `gem`/`bundle` argv is a flag. No slash:
 * a nested require path (`active_support/core_ext`) names a FILE inside a
 * gem, not a gem, and stays on the agent tier.
 */
const GEM_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isValidGemName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && GEM_NAME.test(name);
}

/** A rubygems version shape (digits-led; letters cover prereleases). */
const GEM_VERSION = /^[0-9][0-9A-Za-z.-]*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The explicit-entry pin as a PURE text transform: append the exact-
 *  version gem line at the Gemfile's top level. */
function gemfilePinTransform(pkg: string, version: string): ManifestTextEdit['transform'] {
  return (text) => {
    if (!/^\s*(source|gem|gemspec)\b/m.test(text)) {
      return { refused: 'this file does not look like a Gemfile, so it cannot be edited' };
    }
    if (new RegExp(`^\\s*gem\\s+["']${escapeRegExp(pkg)}["']`, 'm').test(text)) {
      return {
        refused:
          `'${pkg}' is already declared in this Gemfile; the honest fix is upgrading the ` +
          'declared dependency (the dep-bump lane), not pinning it again',
      };
    }
    const base = text.endsWith('\n') ? text : `${text}\n`;
    return {
      text:
        `${base}\n# Pins a transitive dependency to a patched version; remove once the\n` +
        `# dependency tree moves past it.\ngem "${pkg}", "${version}"\n`,
    };
  };
}

const rubyPinTransitive: PinTransitiveProvider = {
  manifestFiles: ['Gemfile'],
  osvEcosystem: 'RubyGems',
  plan(ctx): PinPlanResult {
    // Rule 11: both tokens land in manifest text verbatim.
    if (!isValidGemName(ctx.pkg) || !GEM_VERSION.test(ctx.version)) {
      return {
        kind: 'refused',
        reason: `'${ctx.pkg}@${ctx.version}' is not a gem name + version shape dxkit will write into a Gemfile`,
      };
    }
    const at = ctx.rootDir ? `${ctx.rootDir}/` : '';
    return {
      kind: 'plan',
      edit: { file: 'Gemfile', transform: gemfilePinTransform(ctx.pkg, ctx.version) },
      revert: `remove the pinned 'gem "${ctx.pkg}"' entry from ${at}Gemfile and re-run the lock resync`,
    };
  },
  execution: () => RUBY_REMEDIATION_EXECUTION,
};

const rubyDeclareDependency: DeclareDependencyProvider = {
  manifestFiles: ['Gemfile'],
  osvEcosystem: 'RubyGems',
  packageNameLabel: 'gem name',
  validSpecifier: isValidGemName,
  versionProbe: (ctx) => ({
    bin: 'gem',
    args: ['search', '--remote', '--exact', ctx.specifier],
  }),
  parseProbeOutput(output) {
    // `gem search -r -e nokogiri` → `nokogiri (1.16.5)`, possibly with
    // platform variants after a comma; the first token is the version.
    for (const line of output.split('\n')) {
      const m = line.match(/^\s*[A-Za-z0-9_.-]+\s+\((\d[^)\s,]*)[^)]*\)/);
      if (m) return m[1];
    }
    return null;
  },
  installCommand(ctx) {
    // `bundle add` edits the Gemfile AND installs; a plain version string
    // is an exact requirement. Test-only importers land in :development.
    const args = ['add', ctx.specifier, '--version', ctx.version];
    if (ctx.dev) args.push('--group', 'development');
    return { bin: 'bundle', args };
  },
  execution: () => RUBY_REMEDIATION_EXECUTION,
};

/** The ruby pack's remediation declarations. The resync command rides the
 *  pack's install strategy (`bundle install` resolves, writes Gemfile.lock
 *  and installs in one command) and the lint fix rides the rubocop
 *  `fixCommand` (Rule 2: one code path each). */
export const rubyRemediation: RemediationSupport = {
  resyncLockfile: { kind: 'capability', provider: { manifestFiles: ['Gemfile'] } },
  pinTransitive: { kind: 'capability', provider: rubyPinTransitive },
  declareDependency: { kind: 'capability', provider: rubyDeclareDependency },
  lintFix: { kind: 'capability' },
};
