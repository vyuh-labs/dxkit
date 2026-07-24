/**
 * The interpreted-trio import-resolution floors (4.2 fold-in): Python, Ruby,
 * and PHP analogs of the TS/JS phantom-dependency check. Fixture-driven like
 * ts-resolution-check.test.ts — the checks' whole job is reading the
 * installed/declared dependency surface, so each case builds a real tree.
 * The bias cases matter as much as detection: every ambiguous shape must be
 * a DISCLOSED skip or a silent pass, never a false block.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pyResolutionCheck } from '../src/languages/python';
import { rubyResolutionCheck, parseGemfileLockGems } from '../src/languages/ruby';
import { phpResolutionCheck, phpAutoloadRoots } from '../src/languages/php';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-trio-resfloor-'));
  cleanups.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === '') {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
  }
  return dir;
}

const ctx = (cwd: string) => ({ cwd, changedFiles: [], scope: 'full' as const });
const SITE = '.venv/lib/python3.12/site-packages';

describe('pyResolutionCheck', () => {
  it('flags a phantom import: not installed, not declared, not stdlib/local', () => {
    const cwd = repo({
      [`${SITE}/requests/__init__.py`]: '',
      'requirements.txt': 'requests==2.31.0\n',
      'app/main.py': 'import requests\nimport leftpadpy\n',
      'app/__init__.py': '',
    });
    const r = pyResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.unresolved).toEqual([{ specifier: 'leftpadpy', file: 'app/main.py' }]);
    }
  });

  it('clean: installed, declared-not-installed, stdlib, local, and relative all resolve', () => {
    const cwd = repo({
      [`${SITE}/requests/__init__.py`]: '',
      'requirements.txt': 'requests\nnot-installed-yet\n',
      'myapp/__init__.py': '',
      'myapp/core.py':
        'import os\nimport requests\nimport not_installed_yet\nimport myapp\nfrom . import helpers\n',
      'myapp/helpers.py': '',
    });
    expect(pyResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('the known import↔dist aliases resolve on the declared side (yaml → pyyaml)', () => {
    const cwd = repo({
      [`${SITE}/`]: '',
      'requirements.txt': 'pyyaml>=6\n',
      'app.py': 'import yaml\n',
    });
    expect(pyResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('an INDENTED import (optional-dependency guard / TYPE_CHECKING) is never flagged', () => {
    const cwd = repo({
      [`${SITE}/`]: '',
      'app.py': 'try:\n    import ujson\nexcept ImportError:\n    import json\n',
    });
    expect(pyResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('pyproject and Pipfile declarations exempt (poetry key form included)', () => {
    const cwd = repo({
      [`${SITE}/`]: '',
      'pyproject.toml':
        '[project]\ndependencies = ["fastapi>=0.100", "uvicorn[standard]==0.23"]\n[tool.poetry.dependencies]\nhttpx = "^0.24"\n',
      Pipfile: '[packages]\nflask = "*"\n',
      'app.py': 'import fastapi\nimport uvicorn\nimport httpx\nimport flask\n',
    });
    expect(pyResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('disclosed skip when no repo-local venv exists', () => {
    const cwd = repo({ 'app.py': 'import requests\n' });
    const r = pyResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toContain('venv');
  });

  it('declines (disclosed) on implausibly many misses', () => {
    const imports = Array.from({ length: 12 }, (_, i) => `import mysterypkg${i}`).join('\n');
    const cwd = repo({ [`${SITE}/`]: '', 'app.py': imports + '\n' });
    const r = pyResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toContain('12');
  });
});

describe('rubyResolutionCheck', () => {
  const LOCK = [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    rack (3.0.0)',
    '    rack-test (2.1.0)',
    '    activesupport (7.1.0)',
    '',
    'DEPENDENCIES',
    '  rack',
  ].join('\n');

  it('flags a phantom require: not in Gemfile.lock, not stdlib, not local', () => {
    const cwd = repo({
      'Gemfile.lock': LOCK,
      'app/service.rb': "require 'rack'\nrequire 'left_pad_rb'\n",
    });
    const r = rubyResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.unresolved).toEqual([{ specifier: 'left_pad_rb', file: 'app/service.rb' }]);
    }
  });

  it('require↔gem name folding resolves both directions (active_support, rack/test)', () => {
    const cwd = repo({
      'Gemfile.lock': LOCK,
      'app/a.rb':
        "require 'active_support'\nrequire 'active_support/core_ext'\nrequire 'rack/test'\n",
    });
    expect(rubyResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('stdlib, require_relative, indented optional requires, and local files never flag', () => {
    const cwd = repo({
      'Gemfile.lock': LOCK,
      'lib/my_local.rb': 'MODULE = 1\n',
      'app/a.rb': [
        "require 'json'",
        "require_relative '../lib/my_local'",
        'begin',
        "  require 'optional_gem'",
        'rescue LoadError',
        'end',
        "require 'my_local'",
      ].join('\n'),
    });
    expect(rubyResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('disclosed skip without a Gemfile.lock', () => {
    const cwd = repo({ 'app.rb': "require 'rack'\n" });
    const r = rubyResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toContain('Gemfile.lock');
  });

  it('parseGemfileLockGems reads the specs section', () => {
    expect([...parseGemfileLockGems(LOCK)].sort()).toEqual(['activesupport', 'rack', 'rack-test']);
  });
});

describe('phpResolutionCheck', () => {
  const PSR4 =
    "<?php\nreturn array(\n    'Monolog\\\\Handler\\\\' => array($vendorDir . '/monolog'),\n    'GuzzleHttp\\\\' => array($vendorDir . '/guzzle'),\n);\n";

  it('flags a namespace no autoloader serves', () => {
    const cwd = repo({
      'vendor/composer/autoload_psr4.php': PSR4,
      'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }),
      'src/Service.php': '<?php\nuse GuzzleHttp\\Client;\nuse PhantomVendor\\Thing;\n',
    });
    const r = phpResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.unresolved).toEqual([{ specifier: 'phantomvendor', file: 'src/Service.php' }]);
    }
  });

  it('vendor maps, own PSR-4 roots, grouped uses, globals, and require paths all pass', () => {
    const cwd = repo({
      'vendor/composer/autoload_psr4.php': PSR4,
      'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }),
      'src/Service.php': [
        '<?php',
        'use Monolog\\Handler\\StreamHandler;',
        'use GuzzleHttp\\{Client, HandlerStack};',
        'use App\\Domain\\User;',
        'use DateTime;', // global class — single segment, never considered
        "require_once __DIR__ . '/../bootstrap.php';",
      ].join('\n'),
    });
    expect(phpResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('disclosed skip when vendor/composer is absent', () => {
    const cwd = repo({
      'composer.json': '{}',
      'src/A.php': '<?php\nuse Foo\\Bar;\n',
    });
    const r = phpResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toContain('vendor');
  });

  it('phpAutoloadRoots unions vendor maps and composer.json declarations', () => {
    const cwd = repo({
      'vendor/composer/autoload_psr4.php': PSR4,
      'composer.json': JSON.stringify({
        autoload: { 'psr-4': { 'App\\': 'src/' } },
        'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } },
      }),
    });
    const roots = phpAutoloadRoots(cwd);
    for (const expected of ['monolog', 'guzzlehttp', 'app', 'tests']) {
      expect(roots.has(expected)).toBe(true);
    }
  });
});
