/**
 * Tool registry -- central source of truth for all analysis tools.
 *
 * Responsibilities:
 * 1. Describe each tool (what it does, who needs it, how to install)
 * 2. Detect if a tool is available (multi-path: PATH, brew, pipx, npm-g, system paths)
 * 3. Provide install commands per platform
 * 4. Build the `requiredTools` array for a given stack
 *
 * Used by:
 * - `src/detect.ts` -- populates `DetectedStack.requiredTools`
 * - `src/cli.ts tools` subcommand -- list status, interactive install
 * - `src/analyzers/tools/*.ts` -- tool-specific modules call `findTool()`
 * - `devstack` package -- reads `requiredTools` to package devcontainers
 */
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { activeLanguagesFromFlags } from '../../languages';
import { resolveInDirs, resolveOnPath } from './runner';
import { loadToolsConfig } from './tools-config';
import { DetectedStack, ToolRequirement } from '../../types';

/**
 * Shared Python venv location for graphify specifically. Graphify is a
 * Python *library* that our graphify.ts subprocess imports directly,
 * not a CLI tool — so it needs a stable venv-relative path we can spawn
 * from, unlike the CLI tools which are better served by pipx (see
 * below).
 *
 * Lives under `~/.cache/dxkit/` so it survives `/tmp` cleanup. Previously
 * `/tmp/graphify-venv` (D013's "~50% flake" was the cleanup + concurrent-
 * run race on first install). `.cache/` is XDG-compliant and persistent;
 * `test -d` in the shell install commands keeps creation idempotent.
 */
export const TOOLS_VENV = path.join(os.homedir(), '.cache', 'dxkit', 'tools-venv');
/** Legacy path still probed for backwards compat: repos that already set
 *  up the old venv won't force a reinstall on upgrade. */
const LEGACY_TOOLS_VENV = '/tmp/graphify-venv';

/**
 * pipx bootstrap + install fragment. Inlined into every Python CLI tool's
 * install command so each tool gets its OWN isolated venv under
 * `~/.local/pipx/venvs/<tool>/` with its own dep resolution. Fixes the
 * 2.3.0 failure mode where semgrep (tomli~=2.0.1) and pip-audit (newer
 * tomli) fought in the shared venv.
 *
 *   1. If `pipx` is on PATH, use it.
 *   2. Else try `python3 -m pip install --user pipx` (legacy + non-PEP-668).
 *   3. PEP 668 distros (Debian 12+, Ubuntu 23.04+) refuse `pip --user` on
 *      externally-managed Python; fall back to
 *      `--user --break-system-packages`.
 *   4. Prepend `~/.local/bin` to PATH so the freshly-installed pipx is
 *      found within the same shell.
 *
 * Result: `pipx install <tool>` symlinks the binary into `~/.local/bin/`,
 * which is already in `getSystemPaths()` probes so `findTool()` picks it
 * up on the next run.
 */
const PIPX_BOOTSTRAP =
  'command -v pipx >/dev/null 2>&1 || { python3 -m pip install --user pipx || python3 -m pip install --user --break-system-packages pipx; } && export PATH="$HOME/.local/bin:$PATH"';

export interface ToolDefinition extends ToolRequirement {
  /** Binary name(s) to look for in PATH. First match wins. */
  binaries: string[];
  /** Extra absolute paths to probe (e.g. venv, system locations). */
  probePaths?: string[];
  /**
   * For tools that are node packages without a CLI binary (e.g. vitest
   * plugins). When set, detection checks for `node_modules/<pkg>/package.json`
   * instead of scanning PATH / .bin. Takes precedence over binary search.
   */
  nodePackage?: string;
  /**
   * For tools that are Ruby gems without a CLI binary (e.g. SimpleCov,
   * which is required from spec_helper.rb rather than invoked as a
   * command). When set, detection runs `gem list -i <name>` instead of
   * scanning PATH. Takes precedence over binary search. Mirrors the
   * `nodePackage` pattern. Library-only Ruby tools that DO ship a CLI
   * (rubocop, bundler-audit) should keep using `binaries: [...]`
   * instead — the CLI shim is what `findTool` is meant to discover.
   */
  gemPackage?: string;
  /** Platform-specific install commands. */
  installCommands: {
    macos?: string;
    linux?: string;
    windows?: string;
  };
  /** Command that prints version info (used to verify tool works). */
  versionCheck?: string;
  /**
   * Optional applicability gate. Returns a short human-readable reason
   * string when the tool is NOT applicable to the project at `cwd`
   * (e.g. `@vitest/coverage-v8` on a mocha-based repo). Returns null
   * when the tool IS applicable — detection then proceeds normally.
   *
   * The gate runs BEFORE binary/probe lookup so non-applicable tools
   * never get reported as "missing." The CLI surfaces them as "n/a"
   * with the reason string and excludes them from missing-count math
   * so customers don't chase a non-fixable warning.
   */
  applicabilityGuard?: (cwd: string) => string | null;
}

export interface ToolStatus {
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
  source: 'path' | 'brew' | 'npm-g' | 'pipx' | 'cargo' | 'go' | 'probe' | 'missing' | 'n/a';
  requirement: ToolDefinition;
  /**
   * Populated when `source === 'n/a'`. Carries the reason from the
   * applicabilityGuard so renderers can show e.g. "no vitest in this
   * repo" alongside the n/a status.
   */
  notApplicableReason?: string;
}

/**
 * Platform-specific system paths to probe.
 */
function getSystemPaths(): string[] {
  const home = os.homedir();
  const paths = [
    '/usr/local/bin',
    '/opt/homebrew/bin', // Apple Silicon brew
    '/home/linuxbrew/.linuxbrew/bin', // Linux brew
    `${home}/.local/bin`, // pipx, user pip
    `${home}/.cargo/bin`, // rust
    `${home}/go/bin`, // go
    `${home}/.dotnet`, // dotnet-install.sh --install-dir $HOME/.dotnet (Microsoft's recommended non-sudo path)
    `${TOOLS_VENV}/bin`, // dxkit shared Python tools venv (persistent)
    `${LEGACY_TOOLS_VENV}/bin`, // legacy: pre-10f.2 installs
  ];
  // Include $GOPATH/bin if set
  if (process.env.GOPATH) {
    paths.push(path.join(process.env.GOPATH, 'bin'));
  }
  // Windows install locations that aren't always on PATH. The
  // PATHEXT-aware PATH walk in `resolveOnPath` covers anything on PATH;
  // these are the fallback dirs common installers drop binaries into
  // without amending the user's PATH (npm global, dotnet, cargo, go).
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    if (appData) paths.push(path.join(appData, 'npm')); // npm -g shims
    if (localAppData) paths.push(path.join(localAppData, 'Microsoft', 'WindowsApps'));
    if (programFiles) {
      paths.push(path.join(programFiles, 'dotnet'));
      paths.push(path.join(programFiles, 'Git', 'cmd'));
    }
    paths.push(path.join(home, '.dotnet')); // dotnet-install.ps1 default
    // Windows venvs put binaries under `Scripts`, not `bin` — mirror the
    // two POSIX venv `bin` entries above for the dxkit shared tools venv.
    paths.push(path.join(TOOLS_VENV, 'Scripts'));
    paths.push(path.join(LEGACY_TOOLS_VENV, 'Scripts'));
  }
  return paths;
}

/** Run a command with short timeout, return stdout or empty string. */
function quickRun(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

/** Resolve a binary name against PATH (cross-platform; honors PATHEXT
 *  on Windows). Delegates to the canonical pure-Node resolver. */
function findInPath(binary: string): string | null {
  return resolveOnPath(binary);
}

/** Check if brew has installed a tool (macOS/Linux). `stdio: 'pipe'`
 *  in `quickRun` already discards stderr, so no shell redirect is
 *  needed (a `2>/dev/null` here would write a stray `nul` file on
 *  Windows). */
function findInBrew(binary: string): string | null {
  const brewPrefix = quickRun('brew --prefix');
  if (!brewPrefix) return null;
  const candidate = path.join(brewPrefix, 'bin', binary);
  return fs.existsSync(candidate) ? candidate : null;
}

/** Check if npm -g has installed a package with this binary. */
function findInNpmGlobal(binary: string): string | null {
  const npmBin = quickRun('npm bin -g') || quickRun('npm prefix -g');
  if (!npmBin) return null;
  // npm's global prefix holds binaries directly on Windows
  // (`<prefix>\<bin>.cmd`) and under `bin/` on POSIX. Probe both, with
  // PATHEXT-aware extensions on Windows.
  const candidates = [path.join(npmBin, binary), path.join(npmBin, 'bin', binary)];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
    if (process.platform === 'win32') {
      for (const ext of ['.cmd', '.exe', '.bat']) {
        if (fs.existsSync(c + ext)) return c + ext;
      }
    }
  }
  return null;
}

/** Check if pipx has installed a tool. */
function findInPipx(binary: string): string | null {
  const home = os.homedir();
  const pipxBin = path.join(home, '.local', 'bin', binary);
  return fs.existsSync(pipxBin) ? pipxBin : null;
}

/**
 * Cached list of gem-installed binary directories. Ruby's gem bin path
 * varies by ruby version (3.2.0 → `~/.local/share/gem/ruby/3.2.0/bin`,
 * 3.3.0 → `.../3.3.0/bin`), by install mode (system vs `--user-install`),
 * and by package manager (apt vs homebrew vs rbenv). The only reliable
 * way to discover them is to ask Ruby itself via `gem env`. We cache
 * the result so each `findTool` call only pays the ~150ms ruby-startup
 * cost once per process.
 *
 * Returns an empty array when Ruby isn't installed — no harm; the
 * subsequent `findInGemBin` call returns null and the search falls
 * through to the next probe step.
 */
let _gemBinPathsCache: string[] | null = null;
function getGemBinPaths(): string[] {
  if (_gemBinPathsCache !== null) return _gemBinPathsCache;
  const candidates: string[] = [];
  // System gem bin (matches the active Ruby — apt, brew, rbenv all
  // resolve correctly via `gem env`).
  const sysBin = quickRun('gem env executable_directory');
  if (sysBin) candidates.push(sysBin);
  // User-install gem bin (`gem install --user-install <gem>` lands
  // here; matches `Gem.user_dir + "/bin"` — the dxkit-preferred install
  // mode since it doesn't need sudo).
  const userBin = quickRun(`ruby -e 'puts Gem.user_dir + "/bin"'`);
  if (userBin) candidates.push(userBin);
  _gemBinPathsCache = candidates;
  return candidates;
}

/** Check if a gem-installed binary exists in any discovered gem bin dir. */
function findInGemBin(binary: string): string | null {
  for (const dir of getGemBinPaths()) {
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Check system probe paths (PATHEXT-aware on Windows). `extraProbes`
 *  carries per-tool probe dirs plus any user-configured `probePaths`
 *  from `.dxkit/tools.json`. */
function findInProbePaths(binary: string, extraProbes: string[] = []): string | null {
  const allPaths = [...getSystemPaths(), ...extraProbes];
  return resolveInDirs(binary, allPaths);
}

/** Check project-local node_modules/.bin/ for language tools. */
function findInProjectNodeModules(binary: string, cwd: string): string | null {
  const candidate = path.join(cwd, 'node_modules', '.bin', binary);
  return fs.existsSync(candidate) ? candidate : null;
}

/** Check project-local node_modules for a package without a CLI binary. */
function findNodePackage(pkg: string, cwd: string): string | null {
  const candidate = path.join(cwd, 'node_modules', pkg, 'package.json');
  return fs.existsSync(candidate) ? path.join(cwd, 'node_modules', pkg) : null;
}

/**
 * Check if a Ruby gem is installed via `gem list -i <name>`. Returns
 * the gem name itself on success (gems live across multiple paths —
 * system, --user-install, rbenv shims — without a single canonical
 * location). Mirrors `findNodePackage` for the Ruby ecosystem. Used
 * for library-only gems (`require 'simplecov'`) where there's no CLI
 * binary to probe.
 */
function findGemPackage(pkg: string): string | null {
  const result = quickRun(`gem list -i ${pkg}`);
  return result === 'true' ? pkg : null;
}

/**
 * Resolve the python interpreter inside a venv root, honoring the
 * platform's venv layout: POSIX venvs put it at `<root>/bin/python`,
 * Windows venvs at `<root>\Scripts\python.exe`. `python3` doesn't exist
 * inside a Windows venv, so we only look for `python(.exe)` there.
 */
function venvPython(venvRoot: string): string {
  return process.platform === 'win32'
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python');
}

/** Special-case: check if graphify Python module is importable. */
function findGraphifyPython(cwd: string): string | null {
  // Bare interpreter names to resolve against PATH. Windows installs
  // typically expose `python` and the `py` launcher (not `python3`);
  // POSIX exposes `python3`. PATHEXT resolution in `findInPath` matches
  // `python.exe` from a bare `python`.
  const pathInterpreters =
    process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  const pythonCandidates = [
    venvPython(TOOLS_VENV), // current (10f.2+); platform-correct venv layout
    venvPython(LEGACY_TOOLS_VENV), // legacy
    ...(process.platform === 'win32' ? [] : [`${os.homedir()}/.local/bin/python3`]),
    ...pathInterpreters,
  ];
  for (const py of pythonCandidates) {
    // Bare interpreter names resolve against PATH (cross-platform,
    // PATHEXT-aware); explicit paths are used as-is.
    const resolved = pathInterpreters.includes(py) ? findInPath(py) : py;
    if (!resolved || !fs.existsSync(resolved)) continue;
    try {
      // No-shell invocation: pass the interpreter path + args array so a
      // path containing spaces or backslashes (`C:\Program Files\...`)
      // needs no quoting. `stdio: 'pipe'` discards stderr without a
      // POSIX `2>/dev/null` redirect (which writes a stray `nul` file on
      // Windows).
      const check = execFileSync(resolved, ['-c', "import graphify; print('ok')"], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        cwd,
      }).trim();
      if (check === 'ok') return resolved;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Find a tool across multiple installation methods.
 * Returns the first matching absolute path, or null.
 */
export function findTool(def: ToolDefinition, cwd?: string): ToolStatus {
  // Applicability gate runs first. Non-applicable tools (e.g.
  // vitest-coverage on a mocha repo) get an explicit "n/a" status so
  // they never inflate the missing-count.
  if (def.applicabilityGuard) {
    const reason = def.applicabilityGuard(cwd || process.cwd());
    if (reason) {
      return {
        name: def.name,
        available: false,
        path: null,
        version: null,
        source: 'n/a',
        requirement: def,
        notApplicableReason: reason,
      };
    }
  }

  // Special case: graphify is a Python module, not a binary
  if (def.name === 'graphify') {
    const pyPath = findGraphifyPython(cwd || process.cwd());
    if (pyPath) {
      return {
        name: def.name,
        available: true,
        path: pyPath,
        version: 'importable',
        source:
          pyPath.includes(TOOLS_VENV) || pyPath.includes(LEGACY_TOOLS_VENV) ? 'probe' : 'path',
        requirement: def,
      };
    }
    return {
      name: def.name,
      available: false,
      path: null,
      version: null,
      source: 'missing',
      requirement: def,
    };
  }

  // Node packages without a CLI binary (e.g. vitest plugins):
  if (def.nodePackage && cwd) {
    const pkgPath = findNodePackage(def.nodePackage, cwd);
    if (pkgPath) return makeStatus(def, pkgPath, 'probe');
    // Nothing more to check — the package has no binary.
    return {
      name: def.name,
      available: false,
      path: null,
      version: null,
      source: 'missing',
      requirement: def,
    };
  }

  // Ruby gems without a CLI binary (e.g. SimpleCov):
  if (def.gemPackage) {
    const gemPath = findGemPackage(def.gemPackage);
    if (gemPath) return makeStatus(def, gemPath, 'probe');
    return {
      name: def.name,
      available: false,
      path: null,
      version: null,
      source: 'missing',
      requirement: def,
    };
  }

  for (const binary of def.binaries) {
    // 0. Project-local node_modules (for language tools)
    if (cwd && def.layer === 'language' && def.for === 'node') {
      const localResult = findInProjectNodeModules(binary, cwd);
      if (localResult) return makeStatus(def, localResult, 'probe');
    }

    // 1. PATH
    const pathResult = findInPath(binary);
    if (pathResult) return makeStatus(def, pathResult, 'path');

    // 2. brew
    const brewResult = findInBrew(binary);
    if (brewResult) return makeStatus(def, brewResult, 'brew');

    // 3. npm global
    const npmResult = findInNpmGlobal(binary);
    if (npmResult) return makeStatus(def, npmResult, 'npm-g');

    // 4. pipx
    const pipxResult = findInPipx(binary);
    if (pipxResult) return makeStatus(def, pipxResult, 'pipx');

    // 4b. gem-installed binaries (ruby toolchain — system + --user-install
    // bin dirs discovered via `gem env`). Mirrors the pipx step for the
    // Ruby ecosystem.
    const gemResult = findInGemBin(binary);
    if (gemResult) return makeStatus(def, gemResult, 'probe');

    // 5. System probe paths (includes cargo/go/graphify venv) plus any
    //    user-configured `.dxkit/tools.json:probePaths` — lets dxkit find
    //    tools installed into a non-standard / corp-managed directory.
    const userProbePaths = loadToolsConfig(cwd || process.cwd()).probePaths;
    const probeResult = findInProbePaths(binary, [...(def.probePaths ?? []), ...userProbePaths]);
    if (probeResult) {
      let source: ToolStatus['source'] = 'probe';
      if (probeResult.includes('/.cargo/')) source = 'cargo';
      else if (probeResult.includes('/go/bin/')) source = 'go';
      return makeStatus(def, probeResult, source);
    }
  }

  return {
    name: def.name,
    available: false,
    path: null,
    version: null,
    source: 'missing',
    requirement: def,
  };
}

function makeStatus(
  def: ToolDefinition,
  binPath: string,
  source: ToolStatus['source'],
): ToolStatus {
  const version = def.versionCheck ? quickRun(def.versionCheck) : null;
  return {
    name: def.name,
    available: true,
    path: binPath,
    version: version ? version.split('\n')[0] : null,
    source,
    requirement: def,
  };
}

/** Get the install command for the current platform. */
export function getInstallCommand(def: ToolDefinition): string {
  const platform = process.platform;
  if (platform === 'darwin' && def.installCommands.macos) return def.installCommands.macos;
  if (platform === 'linux' && def.installCommands.linux) return def.installCommands.linux;
  if (platform === 'win32' && def.installCommands.windows) return def.installCommands.windows;
  // Fall back to install field from ToolRequirement
  return def.install;
}

/**
 * Environment overlay that redirects an install into the user's
 * configured `.dxkit/tools.json:installDir`. Empty when no install dir
 * is set. We set every ecosystem's bin-dir variable at once — each is a
 * no-op for the ecosystems an install doesn't touch — rather than
 * parsing the install command to guess which package manager runs:
 *
 *   - `PIPX_BIN_DIR`       → pipx-installed app binaries
 *   - `npm_config_prefix`  → npm -g (binaries under `<prefix>/bin`)
 *   - `CARGO_INSTALL_ROOT` → cargo install (binaries under `<root>/bin`)
 *   - `GOBIN`              → go install
 *
 * Passed as an `env` overlay to the install subprocess, so it works
 * identically on POSIX and Windows without shell-specific `VAR=val`
 * prefixing. `loadToolsConfig` already adds both `installDir` and
 * `installDir/bin` to the probe set, so the result is discoverable.
 */
export function getInstallEnv(cwd: string): Record<string, string> {
  const { installDir } = loadToolsConfig(cwd);
  if (!installDir) return {};
  return {
    PIPX_BIN_DIR: installDir,
    npm_config_prefix: installDir,
    CARGO_INSTALL_ROOT: installDir,
    GOBIN: installDir,
  };
}

// =============================================================================
// Tool definitions
// =============================================================================

export const TOOL_DEFS: Record<string, ToolDefinition> = {
  cloc: {
    name: 'cloc',
    description: 'Count lines of code per language',
    install: 'npm install -g cloc',
    check: 'cloc --version',
    for: 'all',
    layer: 'universal',
    binaries: ['cloc'],
    versionCheck: 'cloc --version',
    installCommands: {
      // Create isolated npm workspace at ~/.local/share/dxkit, symlink to ~/.local/bin
      macos:
        'brew install cloc || (mkdir -p ~/.local/share/dxkit && cd ~/.local/share/dxkit && echo \'{"name":"dxkit-tools","private":true}\' > package.json && npm install --silent cloc && mkdir -p ~/.local/bin && ln -sf ~/.local/share/dxkit/node_modules/cloc/lib/cloc ~/.local/bin/cloc)',
      linux:
        'mkdir -p ~/.local/share/dxkit && cd ~/.local/share/dxkit && echo \'{"name":"dxkit-tools","private":true}\' > package.json && npm install --silent cloc && mkdir -p ~/.local/bin && ln -sf ~/.local/share/dxkit/node_modules/cloc/lib/cloc ~/.local/bin/cloc',
      windows: 'npm install -g cloc',
    },
  },
  gitleaks: {
    name: 'gitleaks',
    description: 'Secret scanning with 800+ patterns',
    install: 'brew install gitleaks',
    check: 'gitleaks version',
    for: 'all',
    layer: 'universal',
    binaries: ['gitleaks'],
    probePaths: ['/tmp'],
    versionCheck: 'gitleaks version',
    installCommands: {
      macos: 'brew install gitleaks',
      // Install to ~/.local/bin (user path, no sudo)
      linux:
        'mkdir -p ~/.local/bin && curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.24.0/gitleaks_8.24.0_linux_x64.tar.gz | tar xz -C ~/.local/bin gitleaks && chmod +x ~/.local/bin/gitleaks',
      windows: 'scoop install gitleaks',
    },
  },
  graphify: {
    name: 'graphify',
    description: 'Deterministic AST extraction via tree-sitter (20+ languages)',
    install: 'pip install graphifyy',
    check: 'python3 -c "import graphify"',
    for: 'all',
    layer: 'optional',
    binaries: ['graphify'],
    probePaths: [`${TOOLS_VENV}/bin`, `${LEGACY_TOOLS_VENV}/bin`],
    versionCheck:
      'python3 -c "import graphify; print(\'installed\')" || $HOME/.cache/dxkit/tools-venv/bin/python -c "import graphify; print(\'installed\')"',
    installCommands: {
      macos:
        'mkdir -p "$HOME/.cache/dxkit" && (test -d "$HOME/.cache/dxkit/tools-venv" || python3 -m venv "$HOME/.cache/dxkit/tools-venv") && "$HOME/.cache/dxkit/tools-venv/bin/pip" install -q graphifyy',
      linux:
        'mkdir -p "$HOME/.cache/dxkit" && (test -d "$HOME/.cache/dxkit/tools-venv" || python3 -m venv "$HOME/.cache/dxkit/tools-venv") && "$HOME/.cache/dxkit/tools-venv/bin/pip" install -q graphifyy',
      windows: 'pip install --user graphifyy',
    },
  },
  jscpd: {
    name: 'jscpd',
    description: 'Copy-paste / duplicate code detector',
    install: 'npm install -g jscpd',
    check: 'jscpd --version',
    for: 'all',
    layer: 'universal',
    binaries: ['jscpd'],
    versionCheck: 'jscpd --version',
    installCommands: {
      macos:
        'mkdir -p ~/.local/share/dxkit && cd ~/.local/share/dxkit && npm install jscpd && mkdir -p ~/.local/bin && ln -sf ~/.local/share/dxkit/node_modules/.bin/jscpd ~/.local/bin/jscpd',
      linux:
        'mkdir -p ~/.local/share/dxkit && cd ~/.local/share/dxkit && npm install jscpd && mkdir -p ~/.local/bin && ln -sf ~/.local/share/dxkit/node_modules/.bin/jscpd ~/.local/bin/jscpd',
      windows: 'npm install -g jscpd',
    },
  },
  semgrep: {
    name: 'semgrep',
    description: 'Static analysis security scanner (SAST)',
    install: 'pipx install semgrep',
    check: 'semgrep --version',
    for: 'all',
    layer: 'universal',
    binaries: ['semgrep'],
    probePaths: [`${TOOLS_VENV}/bin`, `${LEGACY_TOOLS_VENV}/bin`],
    versionCheck: 'semgrep --version',
    installCommands: {
      macos: `${PIPX_BOOTSTRAP} && pipx install semgrep`,
      linux: `${PIPX_BOOTSTRAP} && pipx install semgrep`,
      windows: 'pipx install semgrep',
    },
  },
  eslint: {
    name: 'eslint',
    description: 'JavaScript/TypeScript linting',
    install: 'npm install --save-dev eslint',
    check: 'npx eslint --version',
    for: 'node',
    layer: 'language',
    // Project-local dev-dep: lives in the consumer's package.json,
    // not a global binary. F-UX-3 hint logic surfaces "run npm ci"
    // for missing tools in this scope, not "vyuh-dxkit tools install".
    installScope: 'project-local',
    binaries: ['eslint', 'lb-eslint'],
    versionCheck: 'npx eslint --version',
    installCommands: {
      macos: 'npm install --save-dev eslint',
      linux: 'npm install --save-dev eslint',
      windows: 'npm install --save-dev eslint',
    },
  },
  'npm-audit': {
    name: 'npm-audit',
    description: 'Dependency vulnerability scanning (built into npm)',
    install: 'builtin (npm)',
    check: 'npm audit --help',
    for: 'node',
    layer: 'language',
    binaries: ['npm'],
    versionCheck: 'npm --version',
    installCommands: {
      macos: 'builtin',
      linux: 'builtin',
      windows: 'builtin',
    },
  },
  'osv-scanner': {
    name: 'osv-scanner',
    description:
      'OSV.dev dependency scanner + fix planner — populates structured upgradePlan on dep-vuln findings (Tier-2, Node/npm pack)',
    install: 'brew install osv-scanner',
    check: 'osv-scanner --version',
    for: 'node',
    layer: 'language',
    binaries: ['osv-scanner'],
    // ~/go/bin retained for backward-compat: machines that already
    // installed osv-scanner via `go install` before this change get
    // picked up without re-installing. ~/.local/bin (where the new
    // install lands) is already in getSystemPaths(), so no explicit
    // probe needed there.
    probePaths: [path.join(os.homedir(), 'go', 'bin')],
    versionCheck: 'osv-scanner --version',
    // Install via GitHub releases binary (mirrors the gitleaks pattern):
    // the prior `go install` path silently failed on every customer
    // container without a Go toolchain (the majority of stacks — Node,
    // Python, Ruby, .NET, JVM, etc.), leaving dep-vuln reports without
    // osv-scanner's structured upgradePlan enrichment. GitHub release
    // binaries are statically linked + need only curl + chmod.
    //
    // Version pinned here, NOT in the URL on the macOS line — Homebrew
    // tracks its own version; we only need our own pin for the curl
    // fallback. Bumping requires editing this line, copy-package, and
    // dist/ rebuild.
    installCommands: {
      macos:
        'brew install osv-scanner || ' +
        '(mkdir -p ~/.local/bin && ' +
        'curl -sSfL https://github.com/google/osv-scanner/releases/download/v2.3.8/osv-scanner_darwin_amd64 -o ~/.local/bin/osv-scanner && ' +
        'chmod +x ~/.local/bin/osv-scanner)',
      linux:
        'mkdir -p ~/.local/bin && ' +
        'curl -sSfL https://github.com/google/osv-scanner/releases/download/v2.3.8/osv-scanner_linux_amd64 -o ~/.local/bin/osv-scanner && ' +
        'chmod +x ~/.local/bin/osv-scanner',
      windows: 'scoop install osv-scanner',
    },
  },
  'license-checker-rseidelsohn': {
    name: 'license-checker-rseidelsohn',
    description: 'License inventory for npm dependencies (maintained fork of license-checker)',
    install: 'npm install -g license-checker-rseidelsohn',
    check: 'license-checker-rseidelsohn --version',
    for: 'node',
    layer: 'language',
    binaries: ['license-checker-rseidelsohn'],
    versionCheck: 'license-checker-rseidelsohn --version',
    installCommands: {
      macos:
        'mkdir -p ~/.local/share/dxkit && cd ~/.local/share/dxkit && npm install license-checker-rseidelsohn && mkdir -p ~/.local/bin && ln -sf ~/.local/share/dxkit/node_modules/.bin/license-checker-rseidelsohn ~/.local/bin/license-checker-rseidelsohn',
      linux:
        'mkdir -p ~/.local/share/dxkit && cd ~/.local/share/dxkit && npm install license-checker-rseidelsohn && mkdir -p ~/.local/bin && ln -sf ~/.local/share/dxkit/node_modules/.bin/license-checker-rseidelsohn ~/.local/bin/license-checker-rseidelsohn',
      windows: 'npm install -g license-checker-rseidelsohn',
    },
  },
  ruff: {
    name: 'ruff',
    description: 'Python linting and formatting',
    install: 'pipx install ruff',
    check: 'ruff --version',
    for: 'python',
    layer: 'language',
    binaries: ['ruff'],
    probePaths: [`${TOOLS_VENV}/bin`, `${LEGACY_TOOLS_VENV}/bin`],
    versionCheck: 'ruff --version',
    installCommands: {
      macos: `${PIPX_BOOTSTRAP} && pipx install ruff`,
      linux: `${PIPX_BOOTSTRAP} && pipx install ruff`,
      windows: 'pipx install ruff',
    },
  },
  'pip-audit': {
    name: 'pip-audit',
    description: 'Python dependency vulnerability scanning',
    install: 'pipx install pip-audit',
    check: 'pip-audit --version',
    for: 'python',
    layer: 'language',
    binaries: ['pip-audit'],
    probePaths: [`${TOOLS_VENV}/bin`, `${LEGACY_TOOLS_VENV}/bin`],
    versionCheck: 'pip-audit --version',
    installCommands: {
      macos: `${PIPX_BOOTSTRAP} && pipx install pip-audit`,
      linux: `${PIPX_BOOTSTRAP} && pipx install pip-audit`,
      windows: 'pipx install pip-audit',
    },
  },
  'pip-licenses': {
    name: 'pip-licenses',
    description: 'License inventory for Python packages in a venv',
    install: 'pipx install pip-licenses',
    check: 'pip-licenses --version',
    for: 'python',
    layer: 'language',
    binaries: ['pip-licenses'],
    probePaths: [`${TOOLS_VENV}/bin`, `${LEGACY_TOOLS_VENV}/bin`],
    versionCheck: 'pip-licenses --version',
    installCommands: {
      macos: `${PIPX_BOOTSTRAP} && pipx install pip-licenses`,
      linux: `${PIPX_BOOTSTRAP} && pipx install pip-licenses`,
      windows: 'pipx install pip-licenses',
    },
  },
  'golangci-lint': {
    name: 'golangci-lint',
    description: 'Go linting',
    install: 'go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest',
    check: 'golangci-lint --version',
    for: 'go',
    layer: 'language',
    binaries: ['golangci-lint'],
    versionCheck: 'golangci-lint --version',
    installCommands: {
      macos: 'brew install golangci-lint',
      linux: 'go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest',
      windows: 'go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest',
    },
  },
  govulncheck: {
    name: 'govulncheck',
    description: 'Go vulnerability scanning',
    install: 'go install golang.org/x/vuln/cmd/govulncheck@latest',
    check: 'govulncheck -version',
    for: 'go',
    layer: 'language',
    binaries: ['govulncheck'],
    versionCheck: 'govulncheck -version',
    installCommands: {
      macos: 'go install golang.org/x/vuln/cmd/govulncheck@latest',
      linux: 'go install golang.org/x/vuln/cmd/govulncheck@latest',
      windows: 'go install golang.org/x/vuln/cmd/govulncheck@latest',
    },
  },
  'go-licenses': {
    name: 'go-licenses',
    description: 'License inventory for Go modules',
    install: 'go install github.com/google/go-licenses@latest',
    check: 'go-licenses --help',
    for: 'go',
    layer: 'language',
    binaries: ['go-licenses'],
    versionCheck: 'go-licenses --help | head -1',
    installCommands: {
      macos: 'go install github.com/google/go-licenses@latest',
      linux: 'go install github.com/google/go-licenses@latest',
      windows: 'go install github.com/google/go-licenses@latest',
    },
  },
  clippy: {
    name: 'clippy',
    description: 'Rust linting',
    install: 'rustup component add clippy',
    check: 'cargo clippy --version',
    for: 'rust',
    layer: 'language',
    binaries: ['cargo-clippy'],
    versionCheck: 'cargo clippy --version',
    installCommands: {
      macos: 'rustup component add clippy',
      linux: 'rustup component add clippy',
      windows: 'rustup component add clippy',
    },
  },
  'cargo-audit': {
    name: 'cargo-audit',
    description: 'Rust dependency vulnerability scanning',
    install: 'cargo install cargo-audit',
    check: 'cargo audit --version',
    for: 'rust',
    layer: 'language',
    binaries: ['cargo-audit'],
    versionCheck: 'cargo audit --version',
    installCommands: {
      macos: 'cargo install cargo-audit',
      linux: 'cargo install cargo-audit',
      windows: 'cargo install cargo-audit',
    },
  },
  'cargo-license': {
    name: 'cargo-license',
    description: 'License inventory for Rust crate dependencies',
    install: 'cargo install cargo-license',
    check: 'cargo license --version',
    for: 'rust',
    layer: 'language',
    binaries: ['cargo-license'],
    versionCheck: 'cargo license --version',
    installCommands: {
      macos: 'cargo install cargo-license',
      linux: 'cargo install cargo-license',
      windows: 'cargo install cargo-license',
    },
  },
  'dotnet-format': {
    name: 'dotnet-format',
    description: 'C# formatting and linting',
    install: 'builtin (dotnet SDK)',
    check: 'dotnet format --version',
    for: 'csharp',
    layer: 'language',
    binaries: ['dotnet'],
    versionCheck: 'dotnet --version',
    installCommands: {
      macos: 'brew install dotnet-sdk',
      linux: 'apt install dotnet-sdk-8.0',
      windows: 'winget install Microsoft.DotNet.SDK.8',
    },
  },
  'nuget-license': {
    name: 'nuget-license',
    description: 'License inventory for NuGet package references in .NET projects',
    install: 'dotnet tool install --global nuget-license',
    check: 'nuget-license --version',
    for: 'csharp',
    layer: 'language',
    binaries: ['nuget-license'],
    // D-fix (2.4.7): use resolved home path. The literal `~/.dotnet/
    // tools` string was passed verbatim to `path.join(...)` in
    // `findInProbePaths`, which never expands the tilde — so the
    // probe silently missed `nuget-license` even when installed at
    // its canonical `dotnet tool install --global` location.
    probePaths: [path.join(os.homedir(), '.dotnet', 'tools')],
    versionCheck: 'nuget-license --version',
    installCommands: {
      macos: 'dotnet tool install --global nuget-license',
      linux: 'dotnet tool install --global nuget-license',
      windows: 'dotnet tool install --global nuget-license',
    },
  },
  pmd: {
    name: 'pmd',
    description: 'Java source-level static analyzer (PMD 7.x)',
    install: 'brew install pmd',
    check: 'pmd --version',
    for: 'java',
    layer: 'language',
    binaries: ['pmd'],
    versionCheck: 'pmd --version',
    // PMD 7.x ships a single zip on GitHub Releases. Linux install
    // mirrors the detekt + gitleaks pattern: download to ~/.local/share,
    // symlink the entrypoint script (zip ships it as `bin/pmd`) into
    // ~/.local/bin. v7.24.0 confirmed via `gh release list pmd/pmd`
    // 2026-04-28 (latest stable). PMD 7 switched to subcommand syntax
    // (`pmd check -d <dir> -R <ruleset> -f json`) — the gather code in
    // src/languages/java.ts uses that form.
    installCommands: {
      macos: 'brew install pmd',
      linux:
        'mkdir -p ~/.local/share/pmd ~/.local/bin && curl -sSfL -o /tmp/pmd.zip "https://github.com/pmd/pmd/releases/download/pmd_releases%2F7.24.0/pmd-dist-7.24.0-bin.zip" && unzip -q -o /tmp/pmd.zip -d ~/.local/share/pmd && chmod +x ~/.local/share/pmd/pmd-bin-7.24.0/bin/pmd && ln -sf ~/.local/share/pmd/pmd-bin-7.24.0/bin/pmd ~/.local/bin/pmd',
      windows: 'scoop install pmd',
    },
  },
  detekt: {
    name: 'detekt',
    description: 'Kotlin static analysis (lint, complexity, style)',
    install: 'brew install detekt',
    check: 'detekt --version',
    for: 'kotlin',
    layer: 'language',
    // detekt-cli's standalone zip ships the entrypoint as `detekt-cli`
    // (verified against v1.23.6 zip structure). Brew's detekt formula
    // installs both `detekt` and `detekt-cli` as the same wrapper, so
    // listing both keeps detection working across install methods.
    binaries: ['detekt', 'detekt-cli'],
    versionCheck: 'detekt --version || detekt-cli --version',
    // detekt-cli ships as a single zip on GitHub Releases. Linux install
    // mirrors the gitleaks pattern: download to ~/.local/share, symlink
    // the entrypoint script (zip ships it as `bin/detekt-cli`) into
    // ~/.local/bin under both names so callers using either binary name
    // resolve. v1.23.6 is the latest 1.x line; 2.x drops Kotlin <1.9
    // support — track for a future bump.
    installCommands: {
      macos: 'brew install detekt',
      linux:
        'mkdir -p ~/.local/share/detekt ~/.local/bin && curl -sSfL -o /tmp/detekt-cli.zip https://github.com/detekt/detekt/releases/download/v1.23.6/detekt-cli-1.23.6.zip && unzip -q -o /tmp/detekt-cli.zip -d ~/.local/share/detekt && chmod +x ~/.local/share/detekt/detekt-cli-1.23.6/bin/detekt-cli && ln -sf ~/.local/share/detekt/detekt-cli-1.23.6/bin/detekt-cli ~/.local/bin/detekt-cli && ln -sf ~/.local/share/detekt/detekt-cli-1.23.6/bin/detekt-cli ~/.local/bin/detekt',
      windows: 'scoop install detekt',
    },
  },

  // ── Coverage providers ──────────────────────────────────────────────────
  'vitest-coverage': {
    name: 'vitest-coverage',
    description: 'Vitest V8 coverage provider (produces Istanbul-compatible JSON)',
    install: 'npm install --save-dev @vitest/coverage-v8',
    check: 'node -e "require(\'@vitest/coverage-v8\')"',
    for: 'node',
    layer: 'language',
    installScope: 'project-local',
    binaries: [],
    nodePackage: '@vitest/coverage-v8',
    // Non-applicable on mocha/jest/ava-only repos: the V8 coverage
    // provider is a peer of vitest itself, so installing it without
    // vitest just adds dead weight and makes `tools list` report a
    // misleading "missing" entry. Guard against that by checking for
    // vitest in the consumer's tree first.
    applicabilityGuard: (cwd) =>
      fs.existsSync(path.join(cwd, 'node_modules', 'vitest', 'package.json'))
        ? null
        : 'no vitest in this repo',
    // Version auto-detect via `require('vitest/package.json')` assumed
    // vitest was present in the target repo. Repos using mocha/jest/ava
    // hit a MODULE_NOT_FOUND crash (pre-2.3.1 failure mode). Gate with
    // an existence check so the install no-ops cleanly when vitest
    // isn't declared — vitest-coverage is only useful alongside vitest.
    installCommands: {
      macos:
        "test -f node_modules/vitest/package.json || { echo 'vitest not present in this repo — skipping @vitest/coverage-v8'; exit 0; } && npm install --save-dev \"@vitest/coverage-v8@$(node -e \"process.stdout.write('^'+require('vitest/package.json').version.split('.')[0])\")\"",
      linux:
        "test -f node_modules/vitest/package.json || { echo 'vitest not present in this repo — skipping @vitest/coverage-v8'; exit 0; } && npm install --save-dev \"@vitest/coverage-v8@$(node -e \"process.stdout.write('^'+require('vitest/package.json').version.split('.')[0])\")\"",
      // The log call here is inside a `node -e` shell-string argument,
      // not real TS source. slop-ok on the line silences the gate.
      windows:
        "node -e \"try{require('vitest/package.json');process.exit(0)}catch{console.log('vitest not present — skipping');process.exit(0)}\" || npm install --save-dev @vitest/coverage-v8", // slop-ok
    },
  },
  'cargo-llvm-cov': {
    name: 'cargo-llvm-cov',
    description: 'Rust line-level coverage via LLVM instrumentation (produces lcov/cobertura)',
    install: 'cargo install cargo-llvm-cov',
    check: 'cargo llvm-cov --version',
    for: 'rust',
    layer: 'language',
    binaries: ['cargo-llvm-cov'],
    versionCheck: 'cargo llvm-cov --version',
    installCommands: {
      macos: 'cargo install cargo-llvm-cov',
      linux: 'cargo install cargo-llvm-cov',
      windows: 'cargo install cargo-llvm-cov',
    },
  },
  'coverage-py': {
    name: 'coverage-py',
    description: 'Python line-level coverage (produces coverage.json)',
    install: 'pipx install coverage',
    check: 'coverage --version',
    for: 'python',
    layer: 'language',
    binaries: ['coverage'],
    probePaths: [`${TOOLS_VENV}/bin`, `${LEGACY_TOOLS_VENV}/bin`],
    versionCheck: 'coverage --version',
    installCommands: {
      macos: `${PIPX_BOOTSTRAP} && pipx install coverage`,
      linux: `${PIPX_BOOTSTRAP} && pipx install coverage`,
      windows: 'pipx install coverage',
    },
  },
  rubocop: {
    name: 'rubocop',
    description: 'Ruby linter / static-analysis tool',
    install: 'gem install --user-install rubocop',
    check: 'rubocop --version',
    for: 'ruby',
    layer: 'language',
    binaries: ['rubocop'],
    versionCheck: 'rubocop --version',
    installCommands: {
      macos: 'gem install --user-install rubocop',
      linux: 'gem install --user-install rubocop',
      windows: 'gem install --user-install rubocop',
    },
  },
  // SimpleCov is a pure Ruby gem, library-loaded (`require 'simplecov'`
  // from spec_helper.rb), no CLI binary. Detected via the `gemPackage`
  // field — mirrors `nodePackage` for library-only Ruby gems. CLI-shim
  // gems (rubocop, bundler-audit when they land) keep using
  // `binaries: [...]`; only library-only gems use `gemPackage`.
  simplecov: {
    name: 'simplecov',
    description: 'Ruby line-level coverage (produces coverage/.resultset.json)',
    install: 'gem install --user-install simplecov',
    check: 'gem list -i simplecov',
    for: 'ruby',
    layer: 'language',
    binaries: [],
    gemPackage: 'simplecov',
    versionCheck: 'ruby -e "require \'simplecov\'; puts SimpleCov::VERSION"',
    installCommands: {
      macos: 'gem install --user-install simplecov',
      linux: 'gem install --user-install simplecov',
      windows: 'gem install --user-install simplecov',
    },
  },
  snyk: {
    name: 'snyk',
    description: 'Snyk CLI — Snyk Code (SAST) test, free-tier deep-SAST path (opt-in)',
    install: 'npm install -g snyk',
    check: 'snyk --version',
    for: 'all',
    layer: 'optional',
    binaries: ['snyk'],
    versionCheck: 'snyk --version',
    // Opt-in deep-SAST engine. Reports `n/a` until a caller opts in
    // (`ingest --from-snyk` falls back to the CLI / `tools install snyk`
    // set DXKIT_SNYK_CLI), so a normal `tools install` never pulls it.
    // Detection + install still flow through findTool/the registry per
    // Rule 1 once opted in.
    applicabilityGuard: (_cwd: string): string | null =>
      process.env.DXKIT_SNYK_CLI === '1'
        ? null
        : 'opt-in deep-SAST engine — run `vyuh-dxkit ingest --from-snyk` or `tools install snyk`',
    installCommands: {
      macos: 'npm install -g snyk',
      linux: 'npm install -g snyk',
      windows: 'npm install -g snyk',
    },
  },
  codeql: {
    name: 'codeql',
    description: 'Interprocedural SAST engine (deep-SAST, opt-in)',
    install: 'see installCommands (downloads the CodeQL bundle)',
    check: 'codeql version',
    for: 'all',
    layer: 'optional',
    binaries: ['codeql'],
    probePaths: [`${path.join(os.homedir(), '.cache', 'dxkit', 'codeql')}`],
    versionCheck: 'codeql version --format=terse',
    // Opt-in deep-SAST engine: ~1GB download, minutes-long runs, and
    // license-gated for private repos (GitHub Advanced Security). Kept
    // OUT of the default toolchain — reports `n/a` until a caller opts
    // in (`ingest --codeql` / `tools install codeql` set DXKIT_CODEQL),
    // so a normal `tools install` never pulls it. Detection still flows
    // through findTool/the registry per Rule 1 once opted in.
    applicabilityGuard: (_cwd: string): string | null =>
      process.env.DXKIT_CODEQL === '1'
        ? null
        : 'opt-in deep-SAST engine — run `vyuh-dxkit ingest --codeql` or `tools install codeql`',
    installCommands: {
      // Download the CodeQL bundle (CLI + precompiled query packs) into
      // the dxkit cache and symlink the launcher onto the user path.
      macos:
        'mkdir -p "$HOME/.cache/dxkit" && curl -sSfL https://github.com/github/codeql-action/releases/latest/download/codeql-bundle-osx64.tar.gz | tar xz -C "$HOME/.cache/dxkit" && mkdir -p "$HOME/.local/bin" && ln -sf "$HOME/.cache/dxkit/codeql/codeql" "$HOME/.local/bin/codeql"',
      linux:
        'mkdir -p "$HOME/.cache/dxkit" && curl -sSfL https://github.com/github/codeql-action/releases/latest/download/codeql-bundle-linux64.tar.gz | tar xz -C "$HOME/.cache/dxkit" && mkdir -p "$HOME/.local/bin" && ln -sf "$HOME/.cache/dxkit/codeql/codeql" "$HOME/.local/bin/codeql"',
      windows:
        'powershell -Command "New-Item -ItemType Directory -Force $HOME/.cache/dxkit; Invoke-WebRequest -Uri https://github.com/github/codeql-action/releases/latest/download/codeql-bundle-win64.tar.gz -OutFile $env:TEMP/codeql.tar.gz; tar xz -C $HOME/.cache/dxkit -f $env:TEMP/codeql.tar.gz"',
    },
  },
};

// =============================================================================
// Public API
// =============================================================================

/**
 * Build the list of tools required for a given detected stack.
 * This is the single source of truth for detect.ts's `requiredTools` field.
 */
export function buildRequiredTools(languages: DetectedStack['languages']): ToolRequirement[] {
  const names: string[] = [
    // Universal
    'cloc',
    'gitleaks',
    'jscpd',
    'semgrep',
    'graphify',
  ];

  // Language-specific tools dispatched through the language registry.
  // `activeLanguagesFromFlags` handles `node|nextjs → typescript`
  // and naturally dedupes (no Set needed) — replaces the prior
  // langMap + seen-set pair (Phase 10i.0-LP.2).
  for (const lang of activeLanguagesFromFlags(languages)) {
    names.push(...lang.tools);
  }

  return names.map((n) => {
    const def = TOOL_DEFS[n];
    // Strip ToolDefinition-only fields, keep ToolRequirement fields
    return {
      name: def.name,
      description: def.description,
      install: def.install,
      check: def.check,
      for: def.for,
      layer: def.layer,
    };
  });
}

/** Check status of all required tools for a stack. */
export function checkAllTools(languages: DetectedStack['languages'], cwd?: string): ToolStatus[] {
  const required = buildRequiredTools(languages);
  return required.map((req) => {
    const def = TOOL_DEFS[req.name];
    if (!def) {
      return {
        name: req.name,
        available: false,
        path: null,
        version: null,
        source: 'missing',
        requirement: { ...req, binaries: [req.name], installCommands: {} },
      };
    }
    return findTool(def, cwd);
  });
}
