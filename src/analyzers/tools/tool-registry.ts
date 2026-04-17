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
import { DetectedStack, ToolRequirement } from '../../types';

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
    '/tmp/graphify-venv/bin', // dxkit graphify venv
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
    '/tmp/graphify-venv/bin/python',
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
        source: pyPath.includes('/tmp/graphify-venv') ? 'probe' : 'path',
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
    probePaths: ['/tmp/graphify-venv/bin'],
    versionCheck:
      'python3 -c "import graphify; print(\'installed\')" 2>/dev/null || /tmp/graphify-venv/bin/python -c "import graphify; print(\'installed\')" 2>/dev/null',
    installCommands: {
      macos:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install -q graphifyy',
      linux:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install -q graphifyy',
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
    install: 'pip install semgrep',
    check: 'semgrep --version',
    for: 'all',
    layer: 'universal',
    binaries: ['semgrep'],
    probePaths: ['/tmp/graphify-venv/bin'],
    versionCheck: 'semgrep --version 2>/dev/null',
    installCommands: {
      macos:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install -q semgrep && mkdir -p ~/.local/bin && ln -sf /tmp/graphify-venv/bin/semgrep ~/.local/bin/semgrep',
      linux:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install -q semgrep && mkdir -p ~/.local/bin && ln -sf /tmp/graphify-venv/bin/semgrep ~/.local/bin/semgrep',
      windows: 'pip install --user semgrep',
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
  ruff: {
    name: 'ruff',
    description: 'Python linting and formatting',
    install: 'pip install ruff',
    check: 'ruff --version',
    for: 'python',
    layer: 'language',
    binaries: ['ruff'],
    versionCheck: 'ruff --version 2>/dev/null',
    installCommands: {
      // Use the dxkit venv (created during graphify install) for Python tools
      macos:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install ruff && mkdir -p ~/.local/bin && ln -sf /tmp/graphify-venv/bin/ruff ~/.local/bin/ruff',
      linux:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install ruff && mkdir -p ~/.local/bin && ln -sf /tmp/graphify-venv/bin/ruff ~/.local/bin/ruff',
      windows: 'pip install --user ruff',
    },
  },
  'pip-audit': {
    name: 'pip-audit',
    description: 'Python dependency vulnerability scanning',
    install: 'pip install pip-audit',
    check: 'pip-audit --version',
    for: 'python',
    layer: 'language',
    binaries: ['pip-audit'],
    versionCheck: 'pip-audit --version 2>/dev/null',
    installCommands: {
      macos:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install pip-audit && mkdir -p ~/.local/bin && ln -sf /tmp/graphify-venv/bin/pip-audit ~/.local/bin/pip-audit',
      linux:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install pip-audit && mkdir -p ~/.local/bin && ln -sf /tmp/graphify-venv/bin/pip-audit ~/.local/bin/pip-audit',
      windows: 'pip install --user pip-audit',
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
    installCommands: {
      // Version must match installed vitest major — auto-detect it.
      macos:
        "npm install --save-dev \"@vitest/coverage-v8@$(node -e \"process.stdout.write('^'+require('vitest/package.json').version.split('.')[0])\")\"",
      linux:
        "npm install --save-dev \"@vitest/coverage-v8@$(node -e \"process.stdout.write('^'+require('vitest/package.json').version.split('.')[0])\")\"",
      windows: 'npm install --save-dev @vitest/coverage-v8',
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
    install: 'pip install coverage',
    check: 'coverage --version',
    for: 'python',
    layer: 'language',
    binaries: ['coverage'],
    versionCheck: 'coverage --version 2>/dev/null',
    installCommands: {
      macos:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install coverage && mkdir -p ~/.local/bin && ln -sf /tmp/graphify-venv/bin/coverage ~/.local/bin/coverage',
      linux:
        'test -d /tmp/graphify-venv || python3 -m venv /tmp/graphify-venv; /tmp/graphify-venv/bin/pip install coverage && mkdir -p ~/.local/bin && ln -sf /tmp/graphify-venv/bin/coverage ~/.local/bin/coverage',
      windows: 'pip install --user coverage',
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

  if (languages.node || languages.nextjs) {
    names.push('eslint', 'npm-audit', 'vitest-coverage');
  }
  if (languages.python) {
    names.push('ruff', 'pip-audit', 'coverage-py');
  }
  if (languages.go) {
    names.push('golangci-lint', 'govulncheck');
  }
  if (languages.rust) {
    names.push('clippy', 'cargo-audit');
  }
  if (languages.csharp) {
    names.push('dotnet-format');
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

/** Get full ToolDefinition by name. */
export function getToolDef(name: string): ToolDefinition | undefined {
  return TOOL_DEFS[name];
}

/**
 * Map detected languages to the corresponding semgrep ruleset IDs.
 *
 * Semgrep ruleset naming follows `p/<language-or-pack>`. Not every language
 * has a ruleset (e.g., `p/go` does NOT exist; the gosec rules live under
 * `p/gosec`). This function encodes those mappings so callers never hardcode.
 *
 * Adding a new language:
 * 1. Add it to detect.ts `DetectedStack.languages`
 * 2. Add a case here if semgrep has a ruleset for it
 *
 * @see https://semgrep.dev/explore for the full ruleset registry
 */
export function getSemgrepRulesets(languages: DetectedStack['languages']): string[] {
  // Always include the baseline audit ruleset — covers OWASP Top 10 patterns
  // across all languages. Safe to combine with language-specific rulesets.
  const rulesets: string[] = ['p/security-audit'];

  if (languages.node || languages.nextjs) {
    rulesets.push('p/javascript', 'p/typescript');
  }
  if (languages.python) {
    rulesets.push('p/python');
  }
  if (languages.go) {
    // p/go does not exist; gosec rules live under p/gosec
    rulesets.push('p/gosec');
  }
  // Rust: no dedicated semgrep ruleset yet. Covered by p/security-audit.
  // C#: p/csharp exists but is sparse; skip for now.

  return rulesets;
}

/**
 * Run a registered tool and return its stdout.
 *
 * ENFORCEMENT: This is the ONLY sanctioned way to execute an external tool
 * in analyzer code. It verifies the tool exists in TOOL_DEFS before running.
 * If you need to run a tool that's not registered, add it to TOOL_DEFS first.
 *
 * Builtins (grep, find, wc, git, node) don't go through this — they're
 * always available and don't need detection/install. Only tools that:
 * - Need to be discovered (multi-path detection)
 * - Need to be installed by `vyuh-dxkit tools install`
 * - Appear in `vyuh-dxkit tools list`
 * must be registered and invoked via this function or findTool().
 *
 * @param toolName — must match a key in TOOL_DEFS
 * @param buildCmd — function that receives the resolved binary path and returns the shell command
 * @param cwd — working directory
 * @param timeoutMs — command timeout
 * @returns stdout string, or null if tool unavailable
 */
export function runRegisteredTool(
  toolName: string,
  buildCmd: (binPath: string) => string,
  cwd: string,
  timeoutMs = 60000,
): { output: string | null; available: boolean; path: string | null } {
  const def = TOOL_DEFS[toolName];
  if (!def) {
    throw new Error(
      `Tool "${toolName}" is not registered in TOOL_DEFS. ` +
        'Add it to src/analyzers/tools/tool-registry.ts before using.',
    );
  }
  const status = findTool(def, cwd);
  if (!status.available || !status.path) {
    return { output: null, available: false, path: null };
  }
  const cmd = buildCmd(status.path);
  const result =
    quickRun(cmd) ||
    execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    }).trim();
  return { output: result || null, available: true, path: status.path };
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
