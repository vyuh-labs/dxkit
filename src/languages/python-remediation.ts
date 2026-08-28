/**
 * The python ecosystem's remediation capabilities (the pack's
 * `remediation`, Rule 6, the node-remediation.ts sibling): every
 * poetry/uv/pipenv/pip fact the recipe executors consume through the
 * capability seam.
 *
 * Doctrine notes, kept beside the declarations they explain:
 *   - Which manager owns a root is the SAME question the install strategy
 *     answers, so the pin plan and the install command both dispatch
 *     through `pythonInstallStrategy.strategy(root)` (Rule 2: never a
 *     second lockfile-sniffing table).
 *   - The pin mechanism differs per manager. uv has a real override
 *     surface (`[tool.uv] override-dependencies`), so the pin lands there.
 *     poetry and pipenv have NO override mechanism; their community-
 *     standard fix is the EXPLICIT-ENTRY pin: declare the transitive
 *     directly at the exact patched version so the resolver must take it,
 *     and the revert prose says exactly which entry to remove. A plain
 *     requirements root has no lockfile to verify a pin against, so it is
 *     a declared refusal (the constraints-file mechanism stays on the
 *     agent tier rather than shipping unverifiable).
 *   - A DIRECT dependency refuses the pin everywhere: the honest fix is
 *     upgrading the declared dependency (the dep-bump lane's job). The
 *     direct-dependency read here is a TARGETED parse of the dependency
 *     tables, deliberately separate from `pyDeclaredDeps` in python.ts:
 *     that helper over-captures on purpose (its names only ever EXEMPT an
 *     unresolved import), which would refuse pins on any stray quoted
 *     token. Both biases point the same safe direction for their consumer.
 *   - Declaring an import installs a DISTRIBUTION, and python import names
 *     are not distribution names (`yaml` is pyyaml; `cv2` is one of three
 *     packages). The ONE import→distribution mapping
 *     (`python-dist-names.ts`, shared with the resolution check) is the
 *     rail: an import dxkit cannot map to exactly one distribution never
 *     reaches a package-manager argv (false-negative bias: installing the
 *     wrong same-named package is the typosquat class).
 *   - The version probe is `pip index versions`, which resolves against
 *     the repo's own pip configuration; pip ships with the python
 *     toolchain dxkit already requires, so the probe holds whichever
 *     manager owns the root.
 */
import { join } from 'path';
import type {
  DeclareDependencyProvider,
  ManifestTextEdit,
  PinPlanResult,
  PinTransitiveProvider,
  RemediationSupport,
} from './capabilities/remediation';
import { pyDistForImport } from './python-dist-names';
import { pythonInstallStrategy, PYTHON_INSTALL_EXECUTION } from './python-install';

// ── shared rails ───────────────────────────────────────────────────────────

/** A PyPI distribution name shape (PEP 508), the Rule 11 rail for a pin's
 *  package argument before it lands in manifest text. */
const PY_DIST_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** A PEP 440 version shape (epoch, pre/post/dev, local segments). */
const PY_VERSION = /^[0-9][0-9A-Za-z.+!-]*$/;

function directDepRefusal(pkg: string): string {
  return (
    `'${pkg}' is a direct dependency of this manifest; the honest fix is ` +
    'upgrading the declared dependency (the dep-bump lane), not pinning it'
  );
}

// ── TOML text surgery (line-level, style-preserving, refusal-biased) ──────

/** The `[name]` table in `lines`: header index and exclusive body end. */
function findTomlTable(
  lines: readonly string[],
  name: string,
): { header: number; end: number } | null {
  const headerRe = new RegExp(`^\\s*\\[${name.replace(/\./g, '\\.')}\\]\\s*(#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    if (!headerRe.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[/.test(lines[j])) {
        end = j;
        break;
      }
    }
    return { header: i, end };
  }
  return null;
}

/** Every table header name in the document. */
function tomlTableNames(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Key names declared in one table's body (`name = ...` lines, quoted or
 *  bare), PEP-503 normalized for comparison. */
function tableKeyNames(lines: readonly string[], table: { header: number; end: number }): string[] {
  const out: string[] = [];
  for (let i = table.header + 1; i < table.end; i++) {
    const m = lines[i].match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*=/);
    if (m) out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/** The quoted requirement strings of every `<key> = [ ... ]` array in one
 *  table's body (bracket-balanced across lines), as leading PEP 508 names. */
function tableArrayRequirementNames(
  lines: readonly string[],
  table: { header: number; end: number },
): string[] {
  const out: string[] = [];
  let openBrackets = 0;
  for (let i = table.header + 1; i < table.end; i++) {
    const line = lines[i];
    const opensArray =
      openBrackets === 0 && /^\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9._-]+)\s*=\s*\[/.test(line);
    if (opensArray || openBrackets > 0) {
      for (const m of line.matchAll(/["']([^"']+)["']/g)) {
        const name = m[1].match(/^\s*([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?)/);
        if (name) out.push(name[1]);
      }
      openBrackets += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
      if (openBrackets < 0) openBrackets = 0;
    }
  }
  return out;
}

const norm = (n: string): string => n.toLowerCase().replace(/[-_.]+/g, '-');

/** Is `pkg` a direct dependency under PEP 621 (`[project]` dependencies +
 *  `[project.optional-dependencies]` groups)? */
function directInPep621(lines: readonly string[], pkg: string): boolean {
  const target = norm(pkg);
  for (const name of ['project', 'project.optional-dependencies']) {
    const table = findTomlTable(lines, name);
    if (table && tableArrayRequirementNames(lines, table).some((n) => norm(n) === target)) {
      return true;
    }
  }
  return false;
}

/** Is `pkg` declared as a key in any table whose name matches `re`? */
function directInKeyedTables(lines: readonly string[], re: RegExp, pkg: string): boolean {
  const target = norm(pkg);
  return tomlTableNames(lines).some((name) => {
    if (!re.test(name)) return false;
    const table = findTomlTable(lines, name);
    return table !== null && tableKeyNames(lines, table).some((n) => norm(n) === target);
  });
}

/** Every transform starts here: a manifest with no table header at all is
 *  not TOML dxkit can edit (garbage, an empty file, JSON). */
function notToml(text: string, what: string): string | null {
  return /^\s*\[[^\]]*\]/m.test(text)
    ? null
    : `this ${what} does not parse as a TOML manifest, so it cannot be edited`;
}

// ── the three pin transforms ───────────────────────────────────────────────

/** uv: `[tool.uv] override-dependencies = ["pkg==version"]`, the
 *  ecosystem's real override surface. Refuses a direct dependency and an
 *  ALREADY-present override list (merging into one needs judgment). */
function uvOverrideTransform(pkg: string, version: string): ManifestTextEdit['transform'] {
  return (text) => {
    const guard = notToml(text, 'pyproject.toml');
    if (guard) return { refused: guard };
    if (directInPep621(text.split('\n'), pkg)) return { refused: directDepRefusal(pkg) };
    if (/override-dependencies/.test(text)) {
      return {
        refused:
          'this pyproject.toml already declares override-dependencies; merging into an ' +
          'existing override list needs judgment, so this pin stays on the agent tier',
      };
    }
    const entry = `override-dependencies = ["${pkg}==${version}"]`;
    const lines = text.split('\n');
    const table = findTomlTable(lines, 'tool.uv');
    if (table) {
      lines.splice(table.header + 1, 0, entry);
      return { text: lines.join('\n') };
    }
    const base = text.endsWith('\n') ? text : `${text}\n`;
    return { text: `${base}\n[tool.uv]\n${entry}\n` };
  };
}

/** poetry: the explicit-entry pin into `[tool.poetry.dependencies]` (a bare
 *  version string is an EXACT requirement in poetry). Refuses a direct
 *  dependency in any poetry dependency table or under PEP 621, and a
 *  pyproject with no `[tool.poetry.dependencies]` table (a PEP 621 poetry
 *  layout, where the entry should land needs judgment). */
function poetryPinTransform(pkg: string, version: string): ManifestTextEdit['transform'] {
  const poetryDepTables = /^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/;
  return (text) => {
    const guard = notToml(text, 'pyproject.toml');
    if (guard) return { refused: guard };
    const lines = text.split('\n');
    if (directInPep621(lines, pkg) || directInKeyedTables(lines, poetryDepTables, pkg)) {
      return { refused: directDepRefusal(pkg) };
    }
    const table = findTomlTable(lines, 'tool.poetry.dependencies');
    if (table === null) {
      return {
        refused:
          'this pyproject.toml declares no [tool.poetry.dependencies] table, so the ' +
          'explicit-entry pin has nowhere to land; this pin stays on the agent tier',
      };
    }
    lines.splice(table.header + 1, 0, `${pkg} = "${version}"`);
    return { text: lines.join('\n') };
  };
}

/** pipenv: the explicit-entry pin into `[packages]` (`pkg = "==version"`).
 *  Refuses a direct dependency in `[packages]` / `[dev-packages]` and a
 *  Pipfile with no `[packages]` table. */
function pipfilePinTransform(pkg: string, version: string): ManifestTextEdit['transform'] {
  return (text) => {
    const guard = notToml(text, 'Pipfile');
    if (guard) return { refused: guard };
    const lines = text.split('\n');
    if (directInKeyedTables(lines, /^(dev-)?packages$/, pkg)) {
      return { refused: directDepRefusal(pkg) };
    }
    const table = findTomlTable(lines, 'packages');
    if (table === null) {
      return {
        refused:
          'this Pipfile declares no [packages] table, so the explicit-entry pin has ' +
          'nowhere to land; this pin stays on the agent tier',
      };
    }
    lines.splice(table.header + 1, 0, `${pkg} = "==${version}"`);
    return { text: lines.join('\n') };
  };
}

// ── the providers ──────────────────────────────────────────────────────────

const pythonPinTransitive: PinTransitiveProvider = {
  manifestFiles: ['pyproject.toml', 'Pipfile'],
  osvEcosystem: 'PyPI',
  plan(ctx): PinPlanResult {
    // Rule 11: both tokens land in manifest text verbatim; anything outside
    // the ecosystem's own name/version shapes is refused before any edit.
    if (!PY_DIST_NAME.test(ctx.pkg) || !PY_VERSION.test(ctx.version)) {
      return {
        kind: 'refused',
        reason: `'${ctx.pkg}@${ctx.version}' is not a PyPI package name + PEP 440 version shape dxkit will write into a manifest`,
      };
    }
    const strategy = pythonInstallStrategy.strategy(join(ctx.cwd, ctx.rootDir));
    if (strategy === null) {
      return {
        kind: 'refused',
        reason:
          'no python dependency artifact at this root selects a package manager to pin through',
      };
    }
    const at = ctx.rootDir ? `${ctx.rootDir}/` : '';
    switch (strategy.manager) {
      case 'uv':
        return {
          kind: 'plan',
          edit: { file: 'pyproject.toml', transform: uvOverrideTransform(ctx.pkg, ctx.version) },
          revert:
            `remove the [tool.uv] override-dependencies entry for '${ctx.pkg}' from ` +
            `${at}pyproject.toml and re-run the lock resync`,
        };
      case 'poetry':
        return {
          kind: 'plan',
          edit: { file: 'pyproject.toml', transform: poetryPinTransform(ctx.pkg, ctx.version) },
          revert:
            `remove the '${ctx.pkg}' entry from [tool.poetry.dependencies] in ` +
            `${at}pyproject.toml and re-run the lock resync`,
        };
      case 'pipenv':
        return {
          kind: 'plan',
          edit: { file: 'Pipfile', transform: pipfilePinTransform(ctx.pkg, ctx.version) },
          revert: `remove the '${ctx.pkg}' entry from [packages] in ${at}Pipfile and re-run the lock resync`,
        };
      default:
        return {
          kind: 'refused',
          reason:
            'a plain requirements root has no lockfile to verify a pin against; the pip ' +
            'constraints-file mechanism stays on the agent tier',
        };
    }
  },
  execution: () => PYTHON_INSTALL_EXECUTION,
};

const pythonDeclareDependency: DeclareDependencyProvider = {
  manifestFiles: ['pyproject.toml', 'Pipfile', 'requirements.txt'],
  osvEcosystem: 'PyPI',
  packageNameLabel: 'python import dxkit can map to one PyPI distribution',
  // The rail folds the injection shape AND the mapping question into one
  // answer: an import that maps to no single distribution (malformed, or an
  // ambiguous alias like cv2/google) never reaches an argv.
  validSpecifier: (specifier) => pyDistForImport(specifier) !== null,
  versionProbe: (ctx) => ({
    bin: 'pip',
    args: ['index', 'versions', pyDistForImport(ctx.specifier) ?? ctx.specifier],
  }),
  parseProbeOutput(output) {
    // `pip index versions requests` → `requests (2.32.5)` then an
    // `Available versions:` list; either names the latest first.
    for (const line of output.split('\n')) {
      const m = line.match(/^\s*[A-Za-z0-9._-]+\s+\((\d[^)\s,]*)\s*\)\s*$/);
      if (m) return m[1];
    }
    const avail = output.match(/Available versions:\s*(\d[^\s,]*)/);
    return avail ? avail[1] : null;
  },
  installCommand(ctx) {
    const dist = pyDistForImport(ctx.specifier) ?? ctx.specifier;
    const spec = `${dist}==${ctx.version}`;
    // The manager owning this root, from the same strategy pick every other
    // consumer reads (a lockfile-less root was already refused upstream;
    // the pip form is the total fallback the contract requires).
    const manager = pythonInstallStrategy.strategy(join(ctx.cwd, ctx.rootDir))?.manager;
    switch (manager) {
      case 'poetry':
        return { bin: 'poetry', args: ctx.dev ? ['add', '--group', 'dev', spec] : ['add', spec] };
      case 'uv':
        return { bin: 'uv', args: ctx.dev ? ['add', '--dev', spec] : ['add', spec] };
      case 'pipenv':
        return { bin: 'pipenv', args: ctx.dev ? ['install', '--dev', spec] : ['install', spec] };
      default:
        return { bin: 'pip', args: ['install', spec] };
    }
  },
  execution: () => PYTHON_INSTALL_EXECUTION,
};

/** The python pack's remediation declarations: all four capabilities. The
 *  resync command rides `pythonInstallStrategy` (a requirements root has no
 *  lockfile and refuses at the executor with the reason) and the lint fix
 *  rides the ruff `fixCommand` (Rule 2: one code path each). */
export const pythonRemediation: RemediationSupport = {
  resyncLockfile: {
    kind: 'capability',
    provider: { manifestFiles: ['pyproject.toml', 'Pipfile', 'requirements.txt'] },
  },
  pinTransitive: { kind: 'capability', provider: pythonPinTransitive },
  declareDependency: { kind: 'capability', provider: pythonDeclareDependency },
  lintFix: { kind: 'capability' },
};
