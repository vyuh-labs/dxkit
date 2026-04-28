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
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { activeLanguagesFromFlags } from '../../languages';
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
  'command -v pipx >/dev/null 2>&1 || { python3 -m pip install --user pipx 2>/dev/null || python3 -m pip install --user --break-system-packages pipx; } && export PATH="$HOME/.local/bin:$PATH"';

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
  /** Platform-specific install commands. */
  installCommands: {
    macos?: string;
    linux?: string;
    windows?: string;
  };
  /** Command that prints version info (used to verify tool works). */
  versionCheck?: string;
}

export interface ToolStatus {
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
  source: 'path' | 'brew' | 'npm-g' | 'pipx' | 'cargo' | 'go' | 'probe' | 'missing';
  requirement: ToolDefinition;
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

/** Check if a binary name is available via `which`. */
function findInPath(binary: string): string | null {
  const result = quickRun(`which ${binary} 2>/dev/null`);
  return result || null;
}

/** Check if brew has installed a tool (macOS/Linux). */
function findInBrew(binary: string): string | null {
  const brewPrefix = quickRun('brew --prefix 2>/dev/null');
  if (!brewPrefix) return null;
  const candidate = path.join(brewPrefix, 'bin', binary);
  return fs.existsSync(candidate) ? candidate : null;
}

/** Check if npm -g has installed a package with this binary. */
function findInNpmGlobal(binary: string): string | null {
  const npmBin = quickRun('npm bin -g 2>/dev/null') || quickRun('npm prefix -g 2>/dev/null');
  if (!npmBin) return null;
  const candidates = [path.join(npmBin, binary), path.join(npmBin, 'bin', binary)];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Check if pipx has installed a tool. */
function findInPipx(binary: string): string | null {
  const home = os.homedir();
  const pipxBin = path.join(home, '.local', 'bin', binary);
  return fs.existsSync(pipxBin) ? pipxBin : null;
}

/** Check system probe paths. */
function findInProbePaths(binary: string, extraProbes: string[] = []): string | null {
  const allPaths = [...getSystemPaths(), ...extraProbes];
  for (const p of allPaths) {
    const candidate = path.join(p, binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
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

/** Special-case: check if graphify Python module is importable. */
function findGraphifyPython(cwd: string): string | null {
  const pythonCandidates = [
    `${TOOLS_VENV}/bin/python`, // current (10f.2+)
    `${LEGACY_TOOLS_VENV}/bin/python`, // legacy
    `${os.homedir()}/.local/bin/python3`,
    'python3',
  ];
  for (const py of pythonCandidates) {
    // Resolve 'python3' via which first
    const resolved = py === 'python3' ? findInPath('python3') : py;
    if (!resolved || !fs.existsSync(resolved.replace('${HOME}', os.homedir()))) continue;
    try {
      const check = execSync(`${resolved} -c "import graphify; print('ok')" 2>/dev/null`, {
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

    // 5. System probe paths (includes cargo/go/graphify venv)
    const probeResult = findInProbePaths(binary, def.probePaths);
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
    versionCheck: 'cloc --version 2>/dev/null',
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
    versionCheck: 'gitleaks version 2>/dev/null',
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
      'python3 -c "import graphify; print(\'installed\')" 2>/dev/null || $HOME/.cache/dxkit/tools-venv/bin/python -c "import graphify; print(\'installed\')" 2>/dev/null',
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
    versionCheck: 'jscpd --version 2>/dev/null',
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
    versionCheck: 'semgrep --version 2>/dev/null',
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
    binaries: ['eslint', 'lb-eslint'],
    versionCheck: 'npx eslint --version 2>/dev/null',
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
    versionCheck: 'npm --version 2>/dev/null',
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
    install: 'go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest',
    check: 'osv-scanner --version',
    for: 'node',
    layer: 'language',
    binaries: ['osv-scanner'],
    // Go installs to $GOBIN (→ $GOPATH/bin by default, or ~/go/bin) which
    // is typically in $PATH on dev machines. Probe the canonical default
    // explicitly so detection works on machines that only have `go` in
    // PATH but not `go/bin`.
    probePaths: [path.join(os.homedir(), 'go', 'bin')],
    versionCheck: 'osv-scanner --version 2>/dev/null',
    installCommands: {
      macos:
        'brew install osv-scanner || go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest',
      linux: 'go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest',
      windows: 'go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest',
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
    versionCheck: 'license-checker-rseidelsohn --version 2>/dev/null',
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
    versionCheck: 'ruff --version 2>/dev/null',
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
    versionCheck: 'pip-audit --version 2>/dev/null',
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
    versionCheck: 'pip-licenses --version 2>/dev/null',
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
    versionCheck: 'golangci-lint --version 2>/dev/null',
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
    versionCheck: 'govulncheck -version 2>/dev/null',
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
    versionCheck: 'go-licenses --help 2>/dev/null | head -1',
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
    versionCheck: 'cargo clippy --version 2>/dev/null',
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
    versionCheck: 'cargo audit --version 2>/dev/null',
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
    versionCheck: 'cargo license --version 2>/dev/null',
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
    versionCheck: 'dotnet --version 2>/dev/null',
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
    probePaths: ['~/.dotnet/tools'],
    versionCheck: 'nuget-license --version 2>/dev/null',
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
    versionCheck: 'pmd --version 2>/dev/null',
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
    versionCheck: 'detekt --version 2>/dev/null || detekt-cli --version 2>/dev/null',
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
    binaries: [],
    nodePackage: '@vitest/coverage-v8',
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
    versionCheck: 'cargo llvm-cov --version 2>/dev/null',
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
    versionCheck: 'coverage --version 2>/dev/null',
    installCommands: {
      macos: `${PIPX_BOOTSTRAP} && pipx install coverage`,
      linux: `${PIPX_BOOTSTRAP} && pipx install coverage`,
      windows: 'pipx install coverage',
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
