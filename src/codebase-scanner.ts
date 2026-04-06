import * as fs from 'fs';
import * as path from 'path';

const IGNORE_DIRS = new Set([
  'node_modules', 'vendor', '.venv', 'venv', 'target', 'bin', 'obj',
  '.git', '.next', '__pycache__', 'dist', 'build', '.tox', '.eggs',
  'htmlcov', 'coverage', '.mypy_cache', '.pytest_cache', '.ruff_cache',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot',
  '.pdf', '.zip', '.tar', '.gz', '.br',
  '.exe', '.dll', '.so', '.dylib',
  '.lock', '.sum',
]);

const MAX_FILE_SIZE = 100 * 1024; // 100KB

export interface CodebaseAnalysis {
  entryPoints: { file: string; type: string }[];
  directories: { path: string; purpose: string }[];
  testPatterns: { framework: string; location: string; pattern: string }[];
  apiEndpoints: { method: string; path: string; file: string }[];
  configFiles: { file: string; purpose: string }[];
  conventions: { pattern: string; description: string }[];
  fileCount: number;
  testFileCount: number;
  sourceFileCount: number;
  languageBreakdown: Record<string, number>;
}

// --- File Walking ---

function walkFiles(cwd: string, callback: (relPath: string, content: string) => void, maxDepth = 5): void {
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(cwd, full);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = fs.readFileSync(full, 'utf-8');
          callback(rel, content);
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(cwd, 0);
}

// --- Entry Points ---

const ENTRY_POINT_FILES: Record<string, string> = {
  'main.go': 'Go entry point',
  'app.py': 'Python application',
  'main.py': 'Python entry point',
  'manage.py': 'Django management',
  'index.ts': 'Node.js entry (TypeScript)',
  'index.js': 'Node.js entry',
  'server.ts': 'Node.js server (TypeScript)',
  'server.js': 'Node.js server',
  'Program.cs': 'C# entry point',
  'Startup.cs': 'C# ASP.NET startup',
  'main.rs': 'Rust entry point',
};

function findEntryPoints(cwd: string): CodebaseAnalysis['entryPoints'] {
  const results: CodebaseAnalysis['entryPoints'] = [];
  const seen = new Set<string>();

  walkFiles(cwd, (rel, content) => {
    const basename = path.basename(rel);

    // Known entry point filenames
    if (ENTRY_POINT_FILES[basename] && !seen.has(rel)) {
      results.push({ file: rel, type: ENTRY_POINT_FILES[basename] });
      seen.add(rel);
    }

    // Python __main__ pattern
    if (basename.endsWith('.py') && content.includes("__name__") && content.includes("__main__") && !seen.has(rel)) {
      results.push({ file: rel, type: 'Python __main__ entry' });
      seen.add(rel);
    }

    // Go func main pattern (for non-main.go files)
    if (basename.endsWith('.go') && /^func\s+main\s*\(/m.test(content) && basename !== 'main.go' && !seen.has(rel)) {
      results.push({ file: rel, type: 'Go main function' });
      seen.add(rel);
    }
  }, 3); // shallow depth for entry points

  // Check package.json main field
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.main && !seen.has(pkg.main)) {
        results.push({ file: pkg.main, type: 'package.json main' });
      }
    } catch { /* ignore */ }
  }

  return results;
}

// --- API Routes ---

const ROUTE_PATTERNS: { ext: RegExp; regex: RegExp; methodGroup: number; pathGroup: number }[] = [
  // Python FastAPI/Flask decorators
  { ext: /\.py$/, regex: /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)/gi, methodGroup: 1, pathGroup: 2 },
  // Python Flask @app.route
  { ext: /\.py$/, regex: /@(?:app|blueprint)\.route\s*\(\s*['"]([^'"]+)['"]/gi, methodGroup: -1, pathGroup: 1 },
  // Express/Node — only match when path starts with /
  { ext: /\.[tj]sx?$/, regex: /(?:app|router|this\.app)\.(get|post|put|delete|patch|all)\s*\(\s*['"](\/.+?)['"]/gi, methodGroup: 1, pathGroup: 2 },
  // LoopBack decorators — @get('/path'), @post('/path'), etc.
  { ext: /\.[tj]sx?$/, regex: /@(get|post|put|del|patch)\s*\(\s*['"]([^'"]+)/gi, methodGroup: 1, pathGroup: 2 },
  // Go standard library and popular routers
  { ext: /\.go$/, regex: /(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"/g, methodGroup: -1, pathGroup: 1 },
  // Go Gin/Echo/Fiber
  { ext: /\.go$/, regex: /\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/gi, methodGroup: 1, pathGroup: 2 },
  // C# attributes
  { ext: /\.cs$/, regex: /\[Http(Get|Post|Put|Delete|Patch)(?:\s*\("([^"]*)"\))?\]/g, methodGroup: 1, pathGroup: 2 },
  // C# minimal API
  { ext: /\.cs$/, regex: /app\.Map(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/gi, methodGroup: 1, pathGroup: 2 },
];

function isSourceFile(rel: string): boolean {
  // Exclude test files, docs, and generated files from API route detection
  const lower = rel.toLowerCase();
  if (lower.endsWith('_test.go') || lower.includes('test_') || lower.includes('/tests/')) return false;
  if (lower.endsWith('.test.ts') || lower.endsWith('.test.js') || lower.endsWith('.spec.ts') || lower.endsWith('.spec.js')) return false;
  if (lower.includes('/docs/') || lower.includes('/documentation/')) return false;
  if (lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.txt') || lower.endsWith('.rst')) return false;
  if (lower.includes('example') || lower.includes('sample') || lower.includes('fixture')) return false;
  return true;
}

function findApiRoutes(cwd: string): CodebaseAnalysis['apiEndpoints'] {
  const results: CodebaseAnalysis['apiEndpoints'] = [];

  walkFiles(cwd, (rel, content) => {
    if (!isSourceFile(rel)) return;
    for (const pattern of ROUTE_PATTERNS) {
      if (!pattern.ext.test(rel)) continue;
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const method = pattern.methodGroup === -1 ? 'ANY' : (match[pattern.methodGroup] || 'GET').toUpperCase();
        const routePath = match[pattern.pathGroup] || '/';
        results.push({ method, path: routePath, file: rel });
      }
    }

    // Next.js API routes (file-based)
    if (rel.includes('app/api/') || rel.includes('pages/api/')) {
      const routePath = '/' + rel
        .replace(/^.*(?:app|pages)\//, '')
        .replace(/\/route\.[tj]sx?$/, '')
        .replace(/\/index\.[tj]sx?$/, '')
        .replace(/\.[tj]sx?$/, '');
      results.push({ method: 'ANY', path: routePath, file: rel });
    }
  });

  return results.slice(0, 50); // cap at 50 to avoid bloat
}

// --- Directory Classification ---

const DIR_PURPOSES: Record<string, string> = {
  'src': 'Source code',
  'lib': 'Library code',
  'pkg': 'Packages',
  'internal': 'Internal packages (Go)',
  'cmd': 'CLI commands (Go)',
  'tests': 'Test files',
  'test': 'Test files',
  '__tests__': 'Test files (Jest)',
  'spec': 'Test specifications',
  'docs': 'Documentation',
  'documentation': 'Documentation',
  'scripts': 'Utility scripts',
  'tools': 'Development tools',
  'config': 'Configuration',
  'configs': 'Configuration',
  'migrations': 'Database migrations',
  'db': 'Database',
  'api': 'API layer',
  'routes': 'Route handlers',
  'controllers': 'Controllers',
  'handlers': 'Request handlers',
  'models': 'Data models',
  'services': 'Service layer',
  'middleware': 'Middleware',
  'components': 'UI components',
  'pages': 'Page components',
  'app': 'Application (Next.js App Router)',
  'public': 'Static assets',
  'static': 'Static files',
  'assets': 'Assets',
  'frontend': 'Frontend application',
  'backend': 'Backend application',
  'infra': 'Infrastructure code',
  'deploy': 'Deployment configuration',
  '.github': 'GitHub workflows and config',
};

function classifyDirectories(cwd: string): CodebaseAnalysis['directories'] {
  const results: CodebaseAnalysis['directories'] = [];
  try {
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const purpose = DIR_PURPOSES[entry.name];
      if (purpose) {
        results.push({ path: entry.name + '/', purpose });
      }
    }
    // Check one level deep for common patterns (services/python/, src/api/, etc.)
    for (const dir of ['src', 'services', 'packages', 'apps']) {
      const subdir = path.join(cwd, dir);
      if (!fs.existsSync(subdir)) continue;
      try {
        for (const sub of fs.readdirSync(subdir, { withFileTypes: true })) {
          if (!sub.isDirectory() || IGNORE_DIRS.has(sub.name)) continue;
          const purpose = DIR_PURPOSES[sub.name];
          if (purpose) {
            results.push({ path: `${dir}/${sub.name}/`, purpose });
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return results;
}

// --- Test Patterns ---

function detectTestPatterns(cwd: string): CodebaseAnalysis['testPatterns'] {
  const results: CodebaseAnalysis['testPatterns'] = [];

  // pytest
  if (fs.existsSync(path.join(cwd, 'pytest.ini')) ||
      fs.existsSync(path.join(cwd, 'conftest.py'))) {
    results.push({ framework: 'pytest', location: 'tests/', pattern: 'test_*.py' });
  } else {
    try {
      const pyproject = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf-8');
      if (pyproject.includes('[tool.pytest')) {
        results.push({ framework: 'pytest', location: 'tests/', pattern: 'test_*.py' });
      }
    } catch { /* no pyproject */ }
  }

  // go test
  let hasGoTests = false;
  walkFiles(cwd, (rel) => {
    if (rel.endsWith('_test.go')) hasGoTests = true;
  }, 2);
  if (hasGoTests) {
    results.push({ framework: 'go test', location: 'alongside source', pattern: '*_test.go' });
  }

  // Jest
  if (fs.existsSync(path.join(cwd, 'jest.config.js')) ||
      fs.existsSync(path.join(cwd, 'jest.config.ts'))) {
    results.push({ framework: 'jest', location: '__tests__/ or *.test.ts', pattern: '*.test.{ts,tsx,js,jsx}' });
  } else {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg.jest || pkg.devDependencies?.jest) {
        results.push({ framework: 'jest', location: '__tests__/ or *.test.ts', pattern: '*.test.{ts,tsx,js,jsx}' });
      }
    } catch { /* no package.json */ }
  }

  // xUnit / NUnit (C#)
  let hasCsharpTests = false;
  walkFiles(cwd, (rel, content) => {
    if (rel.endsWith('.csproj') && (content.includes('xunit') || content.includes('nunit') || content.includes('MSTest'))) {
      hasCsharpTests = true;
      const framework = content.includes('xunit') ? 'xUnit' : content.includes('nunit') ? 'NUnit' : 'MSTest';
      results.push({ framework, location: '*.Tests projects', pattern: '*.cs with [Fact]/[Test]' });
    }
  }, 2);

  // cargo test
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    results.push({ framework: 'cargo test', location: 'src/ (#[cfg(test)]) + tests/', pattern: '#[test] functions' });
  }

  return results;
}

// --- Config Files ---

const CONFIG_FILES: Record<string, string> = {
  'package.json': 'Node.js package manifest',
  'pyproject.toml': 'Python project config',
  'go.mod': 'Go module definition',
  'Cargo.toml': 'Rust package manifest',
  'Makefile': 'Build automation',
  'docker-compose.yml': 'Docker services',
  'docker-compose.yaml': 'Docker services',
  'Dockerfile': 'Container build',
  '.env.example': 'Environment template',
  'tsconfig.json': 'TypeScript config',
  '.eslintrc.js': 'ESLint config',
  '.eslintrc.json': 'ESLint config',
  'ruff.toml': 'Python linter config',
  '.golangci.yml': 'Go linter config',
  'pytest.ini': 'Python test config',
  '.pre-commit-config.yaml': 'Pre-commit hooks',
  '.editorconfig': 'Editor config',
  '.project.yaml': 'Project config (template)',
  'Pulumi.yaml': 'Pulumi IaC config',
  'appsettings.json': 'C# application config',
  'global.json': '.NET SDK config',
};

function findConfigFiles(cwd: string): CodebaseAnalysis['configFiles'] {
  const results: CodebaseAnalysis['configFiles'] = [];
  for (const [file, purpose] of Object.entries(CONFIG_FILES)) {
    if (fs.existsSync(path.join(cwd, file))) {
      results.push({ file, purpose });
    }
  }
  return results;
}

// --- Convention Detection ---

function detectConventions(cwd: string): CodebaseAnalysis['conventions'] {
  const conventions: CodebaseAnalysis['conventions'] = [];
  const fileNames: string[] = [];

  walkFiles(cwd, (rel) => {
    fileNames.push(path.basename(rel, path.extname(rel)));
  }, 2);

  // Naming convention
  const snakeCount = fileNames.filter(n => n.includes('_') && !n.includes('-')).length;
  const kebabCount = fileNames.filter(n => n.includes('-') && !n.includes('_')).length;
  const camelCount = fileNames.filter(n => /^[a-z][a-zA-Z]+$/.test(n) && !n.includes('_') && !n.includes('-')).length;
  const pascalCount = fileNames.filter(n => /^[A-Z][a-zA-Z]+$/.test(n)).length;

  const max = Math.max(snakeCount, kebabCount, camelCount, pascalCount);
  if (max > 5) {
    if (snakeCount === max) conventions.push({ pattern: 'snake_case', description: 'File names use snake_case convention' });
    else if (kebabCount === max) conventions.push({ pattern: 'kebab-case', description: 'File names use kebab-case convention' });
    else if (pascalCount === max) conventions.push({ pattern: 'PascalCase', description: 'File names use PascalCase convention' });
    else if (camelCount === max) conventions.push({ pattern: 'camelCase', description: 'File names use camelCase convention' });
  }

  // Test location
  if (fs.existsSync(path.join(cwd, 'tests')) || fs.existsSync(path.join(cwd, 'test'))) {
    conventions.push({ pattern: 'Separate test directory', description: 'Tests in dedicated tests/ directory' });
  }

  return conventions;
}

// --- Main Scanner ---

const TEST_FILE_PATTERNS = /(_test\.go$|\.test\.[tj]sx?$|\.spec\.[tj]sx?$|test_.*\.py$|Tests?\.cs$|_test\.rs$)/;
const SOURCE_FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|cs|java)$/;

export function scanCodebase(cwd: string): CodebaseAnalysis {
  let fileCount = 0;
  let testFileCount = 0;
  let sourceFileCount = 0;
  const languageBreakdown: Record<string, number> = {};
  const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
    '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.cs': 'C#', '.java': 'Java',
  };
  walkFiles(cwd, (rel) => {
    fileCount++;
    if (TEST_FILE_PATTERNS.test(rel) || rel.includes('__tests__/') || rel.includes('/tests/') || rel.includes('/test/')) {
      testFileCount++;
    } else if (SOURCE_FILE_EXTENSIONS.test(rel)) {
      sourceFileCount++;
    }
    const ext = path.extname(rel).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (lang) {
      languageBreakdown[lang] = (languageBreakdown[lang] || 0) + 1;
    }
  }, 4);

  return {
    entryPoints: findEntryPoints(cwd),
    directories: classifyDirectories(cwd),
    testPatterns: detectTestPatterns(cwd),
    apiEndpoints: findApiRoutes(cwd),
    configFiles: findConfigFiles(cwd),
    conventions: detectConventions(cwd),
    fileCount,
    testFileCount,
    sourceFileCount,
    languageBreakdown,
  };
}

// --- Render Functions ---

export function renderCodebaseSkill(analysis: CodebaseAnalysis): string {
  const lines: string[] = [
    '---',
    'name: codebase',
    'description: Architecture overview and navigation guide for this project. Check before starting any task to understand structure, entry points, and conventions.',
    '---',
    '',
    '# Codebase Overview',
    '',
    `Scanned ${analysis.fileCount} files.`,
    '',
  ];

  // Language breakdown
  const langs = Object.entries(analysis.languageBreakdown).sort((a, b) => b[1] - a[1]);
  if (langs.length > 0) {
    lines.push('## Languages', '');
    for (const [lang, count] of langs) {
      lines.push(`- **${lang}**: ${count} files`);
    }
    lines.push('');
  }

  if (analysis.entryPoints.length) {
    lines.push('## Entry Points', '');
    for (const ep of analysis.entryPoints) {
      lines.push(`- \`${ep.file}\` — ${ep.type}`);
    }
    lines.push('');
  }

  if (analysis.directories.length) {
    lines.push('## Key Directories', '');
    for (const dir of analysis.directories) {
      lines.push(`- \`${dir.path}\` — ${dir.purpose}`);
    }
    lines.push('');
  }

  if (analysis.apiEndpoints.length) {
    lines.push('## API Surface', '');
    for (const ep of analysis.apiEndpoints.slice(0, 30)) {
      lines.push(`- ${ep.method} ${ep.path} (\`${ep.file}\`)`);
    }
    if (analysis.apiEndpoints.length > 30) {
      lines.push(`- ... and ${analysis.apiEndpoints.length - 30} more (see references/architecture.md)`);
    }
    lines.push('');
  }

  // Test overview
  lines.push('## Testing', '');
  lines.push(`- **${analysis.testFileCount}** test files found across **${analysis.sourceFileCount}** source files`);
  if (analysis.testFileCount === 0) {
    lines.push('- **No tests found.** This project needs test infrastructure.');
  } else if (analysis.sourceFileCount > 50 && analysis.testFileCount < analysis.sourceFileCount * 0.1) {
    lines.push('- **Minimal test presence.** Most code paths are likely untested.');
  }
  if (analysis.testPatterns.length) {
    for (const tp of analysis.testPatterns) {
      lines.push(`- **${tp.framework}** — ${tp.location} (${tp.pattern})`);
    }
  }
  lines.push('');

  if (analysis.configFiles.length) {
    lines.push('## Configuration', '');
    for (const cf of analysis.configFiles) {
      lines.push(`- \`${cf.file}\` — ${cf.purpose}`);
    }
    lines.push('');
  }

  if (analysis.conventions.length) {
    lines.push('## Detected Conventions', '');
    for (const c of analysis.conventions) {
      lines.push(`- **${c.pattern}** — ${c.description}`);
    }
    lines.push('');
  }

  lines.push('---', '', '*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit) codebase scanner*', '');

  return lines.join('\n');
}

export function renderArchitectureRef(analysis: CodebaseAnalysis): string {
  const lines: string[] = [
    '# Architecture Reference',
    '',
    '<!-- Auto-generated by VyuhLabs DXKit codebase scanner. -->',
    '<!-- This file is evolving — your edits will be preserved across updates. -->',
    '<!-- Use `npx @vyuhlabs/dxkit update --rescan` to regenerate. -->',
    '',
  ];

  if (analysis.entryPoints.length) {
    lines.push('## Entry Points', '');
    for (const ep of analysis.entryPoints) {
      lines.push(`### \`${ep.file}\``, `- Type: ${ep.type}`, '');
    }
  }

  if (analysis.directories.length) {
    lines.push('## Directory Map', '');
    lines.push('```');
    for (const dir of analysis.directories) {
      lines.push(`${dir.path.padEnd(30)} # ${dir.purpose}`);
    }
    lines.push('```', '');
  }

  if (analysis.apiEndpoints.length) {
    lines.push('## API Endpoints', '');
    lines.push('| Method | Path | File |', '|--------|------|------|');
    for (const ep of analysis.apiEndpoints) {
      lines.push(`| ${ep.method} | ${ep.path} | \`${ep.file}\` |`);
    }
    lines.push('');
  }

  if (analysis.configFiles.length) {
    lines.push('## Config Inventory', '');
    for (const cf of analysis.configFiles) {
      lines.push(`- \`${cf.file}\` — ${cf.purpose}`);
    }
    lines.push('');
  }

  lines.push('---', '', '*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit) codebase scanner*', '');

  return lines.join('\n');
}
