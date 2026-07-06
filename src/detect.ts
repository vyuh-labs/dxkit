import * as fs from 'fs';
import * as path from 'path';
import { DetectedStack, ToolRequirement } from './types';
import { buildRequiredTools } from './analyzers/tools/tool-registry';
import { DEFAULT_VERSIONS } from './constants';
import { LANGUAGES } from './languages';

function fileExists(cwd: string, ...segments: string[]): boolean {
  return fs.existsSync(path.join(cwd, ...segments));
}

function readFileOr(cwd: string, filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(path.join(cwd, filePath), 'utf-8');
  } catch {
    return fallback;
  }
}

function globExists(cwd: string, pattern: string): boolean {
  try {
    const entries = fs.readdirSync(cwd);
    return entries.some((e) => e.match(new RegExp(pattern)));
  } catch {
    return false;
  }
}

/**
 * Toolchain version per pack — DETECTED from the repo (via each pack's
 * `detectVersion`, Rule 6) or the pack's `defaultVersion` floor. Keyed on
 * `versionKey ?? id`. One code path: `allCiSetupSteps` / the devcontainer
 * render re-derive the DETECTED value to substitute into the setup step, and
 * the `<KEY>_VERSION` template vars read this map — never a second extractor.
 */
function detectVersions(cwd: string): DetectedStack['versions'] {
  const versions: Record<string, string> = {};
  for (const lang of LANGUAGES) {
    if (lang.defaultVersion === undefined) continue;
    const key = lang.versionKey ?? lang.id;
    const detected = lang.detectVersion?.(cwd);
    const fallback = (DEFAULT_VERSIONS as Record<string, string>)[key];
    if (detected ?? fallback) versions[key] = (detected ?? fallback) as string;
  }
  return versions as DetectedStack['versions'];
}

function findFileRecursive(cwd: string, pattern: RegExp, maxDepth = 3): string | null {
  function search(dir: string, depth: number): string | null {
    if (depth > maxDepth) return null;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.name.startsWith('.') ||
          ['node_modules', 'vendor', 'bin', 'obj', 'target'].includes(entry.name)
        )
          continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && pattern.test(entry.name)) return full;
        if (entry.isDirectory()) {
          const found = search(full, depth + 1);
          if (found) return found;
        }
      }
    } catch {
      /* permission error, skip */
    }
    return null;
  }
  return search(cwd, 0);
}

function detectNextjs(cwd: string): boolean {
  if (globExists(cwd, '^next\\.config\\.')) return true;
  if (
    fileExists(cwd, 'frontend', 'next.config.js') ||
    fileExists(cwd, 'frontend', 'next.config.mjs') ||
    fileExists(cwd, 'frontend', 'next.config.ts')
  )
    return true;

  const pkg = readFileOr(cwd, 'package.json', '{}');
  try {
    const parsed = JSON.parse(pkg);
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    return 'next' in deps;
  } catch {
    return false;
  }
}

function detectDockerComposeContent(cwd: string): string {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const content = readFileOr(cwd, name, '');
    if (content) return content;
  }
  return '';
}

function detectProjectName(cwd: string): string {
  const cwdBasename = path.basename(cwd);

  // Prefer cwd basename when it's strictly more descriptive than the
  // manifest-declared name. Triggers when the manifest name is a
  // substring of the cwd basename AND the cwd is longer — e.g.
  // package.json `name: "client"` in a directory called `web-app`.
  // The customer running `dxkit X /path/to/web-app` expects
  // "web-app" in the report header, not "client".
  function preferCwdWhenMoreDescriptive(manifestName: string): string {
    if (
      cwdBasename.length > manifestName.length &&
      cwdBasename.toLowerCase().includes(manifestName.toLowerCase())
    ) {
      return cwdBasename;
    }
    return manifestName;
  }

  // Try package.json name
  const pkg = readFileOr(cwd, 'package.json', '{}');
  try {
    const parsed = JSON.parse(pkg);
    if (parsed.name && !parsed.name.startsWith('@')) {
      return preferCwdWhenMoreDescriptive(parsed.name);
    }
    if (parsed.name) {
      const unscoped = parsed.name.split('/').pop() || cwdBasename;
      return preferCwdWhenMoreDescriptive(unscoped);
    }
  } catch {
    /* ignore */
  }

  // Try go.mod module name
  const goMod = readFileOr(cwd, 'go.mod', '');
  const goMatch = goMod.match(/^module\s+\S+\/(\S+)/m);
  if (goMatch) return preferCwdWhenMoreDescriptive(goMatch[1]);

  // Try pyproject.toml name
  const pyproject = readFileOr(cwd, 'pyproject.toml', '');
  const pyMatch = pyproject.match(/name\s*=\s*"([^"]+)"/);
  if (pyMatch) return preferCwdWhenMoreDescriptive(pyMatch[1]);

  // Fallback to directory name
  return cwdBasename;
}

function detectProjectDescription(cwd: string): string {
  const pkg = readFileOr(cwd, 'package.json', '{}');
  try {
    const parsed = JSON.parse(pkg);
    if (parsed.description) return parsed.description;
  } catch {
    /* ignore */
  }

  const pyproject = readFileOr(cwd, 'pyproject.toml', '');
  const match = pyproject.match(/description\s*=\s*"([^"]+)"/);
  if (match) return match[1];

  return '';
}

function detectTestRunner(cwd: string): DetectedStack['testRunner'] {
  const pkg = readFileOr(cwd, 'package.json', '{}');
  try {
    const parsed = JSON.parse(pkg);
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    const scripts = parsed.scripts || {};
    const testScript = scripts.test || '';

    // Check for specific test frameworks in deps and scripts
    if (deps.vitest || testScript.includes('vitest')) {
      return {
        command: 'npx vitest',
        framework: 'vitest',
        coverageCommand: 'npx vitest --coverage',
      };
    }
    if (deps.jest || deps['ts-jest'] || testScript.includes('jest')) {
      return { command: 'npx jest', framework: 'jest', coverageCommand: 'npx jest --coverage' };
    }
    if (
      deps.mocha ||
      deps['lb-mocha'] ||
      deps['@loopback/testlab'] ||
      testScript.includes('mocha') ||
      testScript.includes('lb-mocha')
    ) {
      const hasNyc = !!deps.nyc || !!deps.c8;
      const coverageCmd = hasNyc ? (deps.c8 ? 'npx c8 npm test' : 'npx nyc npm test') : undefined;
      return { command: 'npm test', framework: 'mocha', coverageCommand: coverageCmd };
    }
    if (deps.ava || testScript.includes('ava')) {
      return { command: 'npx ava', framework: 'ava', coverageCommand: 'npx c8 npx ava' };
    }
    if (deps.tap || testScript.includes('tap')) {
      return {
        command: 'npx tap',
        framework: 'tap',
        coverageCommand: 'npx tap --coverage-report=text',
      };
    }
    // Fallback: if there's a test script, use npm test
    if (testScript && testScript !== 'echo "Error: no test specified" && exit 1') {
      return { command: 'npm test', framework: 'unknown', coverageCommand: undefined };
    }
  } catch {
    /* ignore */
  }

  // Python
  if (fileExists(cwd, 'pyproject.toml') || fileExists(cwd, 'setup.py')) {
    const pyproject = readFileOr(cwd, 'pyproject.toml', '');
    if (pyproject.includes('pytest')) {
      return {
        command: 'pytest',
        framework: 'pytest',
        coverageCommand: 'pytest --cov --cov-report=term-missing',
      };
    }
  }

  // Go
  if (fileExists(cwd, 'go.mod')) {
    return {
      command: 'go test ./...',
      framework: 'go-test',
      coverageCommand: 'go test -coverprofile=coverage.out ./...',
    };
  }

  // Rust
  if (fileExists(cwd, 'Cargo.toml')) {
    return { command: 'cargo test', framework: 'cargo-test', coverageCommand: undefined };
  }

  // C#
  if (findFileRecursive(cwd, /\.csproj$/)) {
    return {
      command: 'dotnet test',
      framework: 'dotnet-test',
      coverageCommand: 'dotnet test --collect:"XPlat Code Coverage"',
    };
  }

  return undefined;
}

function detectFramework(cwd: string): string | undefined {
  const pkg = readFileOr(cwd, 'package.json', '{}');
  try {
    const parsed = JSON.parse(pkg);
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };

    if (deps['@loopback/core'] || deps['@loopback/rest']) return 'loopback';
    if (deps['next']) return 'nextjs';
    if (deps['@nestjs/core']) return 'nestjs';
    if (deps['express']) return 'express';
    if (deps['fastify']) return 'fastify';
    if (deps['koa']) return 'koa';
    if (deps['hapi'] || deps['@hapi/hapi']) return 'hapi';
  } catch {
    /* ignore */
  }

  // Python
  const pyproject = readFileOr(cwd, 'pyproject.toml', '');
  const requirements = readFileOr(cwd, 'requirements.txt', '');
  const pyDeps = pyproject + requirements;
  if (pyDeps.includes('fastapi')) return 'fastapi';
  if (pyDeps.includes('django')) return 'django';
  if (pyDeps.includes('flask')) return 'flask';

  // Go
  const goMod = readFileOr(cwd, 'go.mod', '');
  if (goMod.includes('github.com/gin-gonic/gin')) return 'gin';
  if (goMod.includes('github.com/labstack/echo')) return 'echo';
  if (goMod.includes('github.com/gofiber/fiber')) return 'fiber';

  return undefined;
}

// detectRequiredTools now delegates to the central tool registry
// (src/analyzers/tools/tool-registry.ts). This ensures both detect.ts
// and the `vyuh-dxkit tools` subcommand read from the same source of truth.
function detectRequiredTools(languages: DetectedStack['languages']): ToolRequirement[] {
  return buildRequiredTools(languages);
}

export function detect(cwd: string): DetectedStack {
  const composeContent = detectDockerComposeContent(cwd);
  const isNextjs = detectNextjs(cwd);

  // Pack-driven detection. Each LanguageSupport declares its own
  // `.detect(cwd)` — single source of truth for "is this a <lang>
  // project?". `Record<LanguageId, boolean>` shape (10f.4) means
  // adding a 6th pack only extends the LanguageId union; this
  // function never changes.
  //
  // typescript pack matches any package.json — covers both Node and
  // Next.js projects. nextjs is NOT a separate language flag; it's
  // surfaced via the top-level `framework` field below.
  const languages = Object.fromEntries(
    LANGUAGES.map((lang) => [lang.id, lang.detect(cwd)] as const),
  ) as DetectedStack['languages'];

  return {
    languages,
    infrastructure: {
      docker: fileExists(cwd, 'Dockerfile') || composeContent.length > 0,
      postgres: composeContent.includes('postgres'),
      redis: composeContent.includes('redis'),
    },
    projectName: detectProjectName(cwd),
    projectDescription: detectProjectDescription(cwd),
    versions: detectVersions(cwd),
    testRunner: detectTestRunner(cwd),
    // nextjs detection takes precedence — it's a more specific signal
    // than detectFramework's package.json scan (10f.4: nextjs moved out
    // of `languages` and is now exclusively the framework signal).
    framework: isNextjs ? 'nextjs' : detectFramework(cwd),
    requiredTools: detectRequiredTools(languages),
  };
}
