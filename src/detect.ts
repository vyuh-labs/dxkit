import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { DetectedStack } from './types';
import { DEFAULT_VERSIONS } from './constants';

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
    return entries.some(e => e.match(new RegExp(pattern)));
  } catch {
    return false;
  }
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function extractPythonVersion(cwd: string): string | undefined {
  // Try pyproject.toml requires-python
  const pyproject = readFileOr(cwd, 'pyproject.toml', '');
  const match = pyproject.match(/requires-python\s*=\s*"[><=!~]*(\d+\.\d+)/);
  if (match) return match[1];

  // Try .python-version
  if (fileExists(cwd, '.python-version')) {
    const ver = readFileOr(cwd, '.python-version', '').trim();
    if (ver.match(/^\d+\.\d+/)) return ver.split('.').slice(0, 2).join('.');
  }
  return undefined;
}

function extractGoVersion(cwd: string): string | undefined {
  const goMod = readFileOr(cwd, 'go.mod', '');
  const match = goMod.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m);
  return match ? match[1] : undefined;
}

function extractNodeVersion(cwd: string): string | undefined {
  // Try .nvmrc
  if (fileExists(cwd, '.nvmrc')) {
    const ver = readFileOr(cwd, '.nvmrc', '').trim().replace(/^v/, '');
    if (ver.match(/^\d+/)) return ver.split('.')[0];
  }

  // Try package.json engines.node
  const pkg = readFileOr(cwd, 'package.json', '{}');
  try {
    const parsed = JSON.parse(pkg);
    const nodeEngine = parsed?.engines?.node;
    if (nodeEngine) {
      const match = nodeEngine.match(/(\d+)/);
      if (match) return match[1];
    }
  } catch { /* ignore parse errors */ }

  return undefined;
}

function extractRustVersion(cwd: string): string | undefined {
  // Try rust-toolchain.toml
  const toolchain = readFileOr(cwd, 'rust-toolchain.toml', '');
  const match = toolchain.match(/channel\s*=\s*"([^"]+)"/);
  if (match) return match[1];

  // Try Cargo.toml rust-version
  const cargo = readFileOr(cwd, 'Cargo.toml', '');
  const rvMatch = cargo.match(/rust-version\s*=\s*"([^"]+)"/);
  if (rvMatch) return rvMatch[1];

  return undefined;
}

function findFileRecursive(cwd: string, pattern: RegExp, maxDepth = 3): string | null {
  function search(dir: string, depth: number): string | null {
    if (depth > maxDepth) return null;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['node_modules', 'vendor', 'bin', 'obj', 'target'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && pattern.test(entry.name)) return full;
        if (entry.isDirectory()) {
          const found = search(full, depth + 1);
          if (found) return found;
        }
      }
    } catch { /* permission error, skip */ }
    return null;
  }
  return search(cwd, 0);
}

function extractCsharpVersion(cwd: string): string | undefined {
  // Try .csproj TargetFramework
  const csproj = findFileRecursive(cwd, /\.csproj$/);
  if (csproj) {
    const content = fs.readFileSync(csproj, 'utf-8');
    const match = content.match(/<TargetFramework>net(\d+\.\d+)<\/TargetFramework>/);
    if (match) return match[1];
  }

  // Try global.json SDK version
  const globalJson = readFileOr(cwd, 'global.json', '');
  if (globalJson) {
    try {
      const parsed = JSON.parse(globalJson);
      const ver = parsed?.sdk?.version;
      if (ver) return ver.split('.').slice(0, 2).join('.');
    } catch { /* ignore */ }
  }

  return undefined;
}

function detectNextjs(cwd: string): boolean {
  if (globExists(cwd, '^next\\.config\\.')) return true;
  if (fileExists(cwd, 'frontend', 'next.config.js') || fileExists(cwd, 'frontend', 'next.config.mjs') || fileExists(cwd, 'frontend', 'next.config.ts')) return true;

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
  // Try package.json name
  const pkg = readFileOr(cwd, 'package.json', '{}');
  try {
    const parsed = JSON.parse(pkg);
    if (parsed.name && !parsed.name.startsWith('@')) return parsed.name;
    if (parsed.name) return parsed.name.split('/').pop() || path.basename(cwd);
  } catch { /* ignore */ }

  // Try go.mod module name
  const goMod = readFileOr(cwd, 'go.mod', '');
  const goMatch = goMod.match(/^module\s+\S+\/(\S+)/m);
  if (goMatch) return goMatch[1];

  // Try pyproject.toml name
  const pyproject = readFileOr(cwd, 'pyproject.toml', '');
  const pyMatch = pyproject.match(/name\s*=\s*"([^"]+)"/);
  if (pyMatch) return pyMatch[1];

  // Fallback to directory name
  return path.basename(cwd);
}

function detectProjectDescription(cwd: string): string {
  const pkg = readFileOr(cwd, 'package.json', '{}');
  try {
    const parsed = JSON.parse(pkg);
    if (parsed.description) return parsed.description;
  } catch { /* ignore */ }

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
      return { command: 'npx vitest', framework: 'vitest', coverageCommand: 'npx vitest --coverage' };
    }
    if (deps.jest || deps['ts-jest'] || testScript.includes('jest')) {
      return { command: 'npx jest', framework: 'jest', coverageCommand: 'npx jest --coverage' };
    }
    if (deps.mocha || deps['lb-mocha'] || deps['@loopback/testlab'] || testScript.includes('mocha') || testScript.includes('lb-mocha')) {
      const hasNyc = !!deps.nyc || !!deps.c8;
      const coverageCmd = hasNyc ? (deps.c8 ? 'npx c8 npm test' : 'npx nyc npm test') : undefined;
      return { command: 'npm test', framework: 'mocha', coverageCommand: coverageCmd };
    }
    if (deps.ava || testScript.includes('ava')) {
      return { command: 'npx ava', framework: 'ava', coverageCommand: 'npx c8 npx ava' };
    }
    if (deps.tap || testScript.includes('tap')) {
      return { command: 'npx tap', framework: 'tap', coverageCommand: 'npx tap --coverage-report=text' };
    }
    // Fallback: if there's a test script, use npm test
    if (testScript && testScript !== 'echo "Error: no test specified" && exit 1') {
      return { command: 'npm test', framework: 'unknown', coverageCommand: undefined };
    }
  } catch { /* ignore */ }

  // Python
  if (fileExists(cwd, 'pyproject.toml') || fileExists(cwd, 'setup.py')) {
    const pyproject = readFileOr(cwd, 'pyproject.toml', '');
    if (pyproject.includes('pytest')) {
      return { command: 'pytest', framework: 'pytest', coverageCommand: 'pytest --cov --cov-report=term-missing' };
    }
  }

  // Go
  if (fileExists(cwd, 'go.mod')) {
    return { command: 'go test ./...', framework: 'go-test', coverageCommand: 'go test -coverprofile=coverage.out ./...' };
  }

  // Rust
  if (fileExists(cwd, 'Cargo.toml')) {
    return { command: 'cargo test', framework: 'cargo-test', coverageCommand: undefined };
  }

  // C#
  if (findFileRecursive(cwd, /\.csproj$/)) {
    return { command: 'dotnet test', framework: 'dotnet-test', coverageCommand: 'dotnet test --collect:"XPlat Code Coverage"' };
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
  } catch { /* ignore */ }

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

export function detect(cwd: string): DetectedStack {
  const composeContent = detectDockerComposeContent(cwd);
  const isNextjs = detectNextjs(cwd);

  return {
    languages: {
      python: fileExists(cwd, 'pyproject.toml') || fileExists(cwd, 'setup.py') ||
              fileExists(cwd, 'requirements.txt') || fileExists(cwd, 'Pipfile') ||
              !!findFileRecursive(cwd, /\.py$/, 2),
      go: fileExists(cwd, 'go.mod'),
      node: fileExists(cwd, 'package.json') && !isNextjs,
      nextjs: isNextjs,
      rust: fileExists(cwd, 'Cargo.toml'),
      csharp: fileExists(cwd, '*.sln') || globExists(cwd, '\\.csproj$') || globExists(cwd, '\\.sln$') || !!findFileRecursive(cwd, /\.csproj$/),
    },
    infrastructure: {
      docker: fileExists(cwd, 'Dockerfile') || composeContent.length > 0,
      postgres: composeContent.includes('postgres'),
      redis: composeContent.includes('redis'),
    },
    tools: {
      gcloud: fileExists(cwd, '.gcloud') || commandExists('gcloud'),
      pulumi: fileExists(cwd, 'Pulumi.yaml') || fileExists(cwd, 'Pulumi.yml'),
      infisical: fileExists(cwd, '.infisical.json') || commandExists('infisical'),
      ghCli: commandExists('gh'),
    },
    projectName: detectProjectName(cwd),
    projectDescription: detectProjectDescription(cwd),
    versions: {
      python: extractPythonVersion(cwd) ?? DEFAULT_VERSIONS.python,
      go: extractGoVersion(cwd) ?? DEFAULT_VERSIONS.go,
      node: extractNodeVersion(cwd) ?? DEFAULT_VERSIONS.node,
      rust: extractRustVersion(cwd) ?? DEFAULT_VERSIONS.rust,
      csharp: extractCsharpVersion(cwd) ?? DEFAULT_VERSIONS.csharp,
    },
    testRunner: detectTestRunner(cwd),
    framework: detectFramework(cwd),
  };
}
