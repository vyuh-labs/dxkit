/**
 * Unit tests for the small pure-or-filesystem utility modules.
 * Targets the tail of the coverage chart: files.ts, template-engine.ts,
 * logger.ts, and the pure paths through tool-registry.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sha256, writeFile, copyFile, makeExecutable, copyDirectory } from '../src/files';
import { TemplateEngine, processTemplate } from '../src/template-engine';
import * as logger from '../src/logger';
import {
  getInstallCommand,
  buildRequiredTools,
  TOOL_DEFS,
  checkAllTools,
} from '../src/analyzers/tools/tool-registry';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-util-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── files.ts ───────────────────────────────────────────────────────────

describe('sha256', () => {
  it('produces a 64-char hex digest', () => {
    const h = sha256('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
  });

  it('changes for different content', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

const DEFAULT_WRITE_OPTS = { force: false, evolving: false, skipIfExists: false };

describe('writeFile', () => {
  it('writes a new file', async () => {
    const r = await writeFile(path.join(tmp, 'a.txt'), 'hello', DEFAULT_WRITE_OPTS);
    expect(r).toBe('created');
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('hello');
  });

  it('overwrites without force when no skipIfExists', async () => {
    await writeFile(path.join(tmp, 'a.txt'), 'old', DEFAULT_WRITE_OPTS);
    const r = await writeFile(path.join(tmp, 'a.txt'), 'new', DEFAULT_WRITE_OPTS);
    expect(r).toBe('overwritten');
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('new');
  });

  it('skips when evolving flag is true', async () => {
    await writeFile(path.join(tmp, 'a.txt'), 'original', DEFAULT_WRITE_OPTS);
    const r = await writeFile(path.join(tmp, 'a.txt'), 'new', {
      ...DEFAULT_WRITE_OPTS,
      evolving: true,
    });
    expect(r).toBe('skipped');
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('original');
  });

  it('skips when skipIfExists set and not forced', async () => {
    await writeFile(path.join(tmp, 'a.txt'), 'original', DEFAULT_WRITE_OPTS);
    const r = await writeFile(path.join(tmp, 'a.txt'), 'new', {
      ...DEFAULT_WRITE_OPTS,
      skipIfExists: true,
    });
    expect(r).toBe('skipped');
  });

  it('force overrides skipIfExists', async () => {
    await writeFile(path.join(tmp, 'a.txt'), 'original', DEFAULT_WRITE_OPTS);
    const r = await writeFile(path.join(tmp, 'a.txt'), 'new', {
      force: true,
      evolving: false,
      skipIfExists: true,
    });
    expect(r).toBe('overwritten');
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('new');
  });

  it('creates parent directories', async () => {
    const r = await writeFile(path.join(tmp, 'deep/nested/a.txt'), 'x', DEFAULT_WRITE_OPTS);
    expect(r).toBe('created');
    expect(fs.existsSync(path.join(tmp, 'deep/nested/a.txt'))).toBe(true);
  });
});

describe('copyFile', () => {
  it('copies file content', () => {
    fs.writeFileSync(path.join(tmp, 'src.txt'), 'data');
    const r = copyFile(path.join(tmp, 'src.txt'), path.join(tmp, 'dest.txt'), DEFAULT_WRITE_OPTS);
    expect(r).toBe('created');
    expect(fs.readFileSync(path.join(tmp, 'dest.txt'), 'utf8')).toBe('data');
  });

  it('overwrites dest without flags', () => {
    fs.writeFileSync(path.join(tmp, 'src.txt'), 'new');
    fs.writeFileSync(path.join(tmp, 'dest.txt'), 'old');
    const r = copyFile(path.join(tmp, 'src.txt'), path.join(tmp, 'dest.txt'), DEFAULT_WRITE_OPTS);
    expect(r).toBe('overwritten');
  });
});

describe('copyDirectory', () => {
  it('recursively copies a directory tree', () => {
    fs.mkdirSync(path.join(tmp, 'src/sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src/a.txt'), 'a');
    fs.writeFileSync(path.join(tmp, 'src/sub/b.txt'), 'b');
    const count = copyDirectory(path.join(tmp, 'src'), path.join(tmp, 'dest'), { force: false });
    expect(count).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmp, 'dest/a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'dest/sub/b.txt'))).toBe(true);
  });
});

describe('makeExecutable', () => {
  it('sets executable bit on Unix', () => {
    if (process.platform === 'win32') return; // no-op on Windows
    fs.writeFileSync(path.join(tmp, 'script.sh'), '#!/bin/sh\necho ok');
    makeExecutable(path.join(tmp, 'script.sh'));
    const mode = fs.statSync(path.join(tmp, 'script.sh')).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });
});

// ── template-engine.ts ────────────────────────────────────────────────

describe('TemplateEngine.process', () => {
  it('substitutes uppercase variables', () => {
    const e = new TemplateEngine({ NAME: 'world' }, {});
    expect(e.process('Hello {{NAME}}!')).toBe('Hello {{NAME}}!\n'.replace('{{NAME}}', 'world'));
  });

  it('leaves unknown variables alone', () => {
    const e = new TemplateEngine({ NAME: 'world' }, {});
    expect(e.process('{{UNKNOWN}}').trim()).toBe('{{UNKNOWN}}');
  });

  it('does not substitute GitHub Actions ${{ }} syntax', () => {
    const e = new TemplateEngine({ X: 'replaced' }, {});
    expect(e.process('${{ X }}').trim()).toBe('${{ X }}');
  });

  it('processes IF_* conditional when true', () => {
    const e = new TemplateEngine({}, { IF_FEATURE: true });
    expect(e.process('a{{#IF_FEATURE}}B{{/IF_FEATURE}}c').trim()).toBe('aBc');
  });

  it('omits content when IF_* is false', () => {
    const e = new TemplateEngine({}, { IF_FEATURE: false });
    expect(e.process('a{{#IF_FEATURE}}B{{/IF_FEATURE}}c').trim()).toBe('ac');
  });

  it('handles IF/ELSE branches', () => {
    const tOn = new TemplateEngine({}, { IF_X: true }).process('{{#IF_X}}y{{#ELSE}}n{{/IF_X}}');
    const tOff = new TemplateEngine({}, { IF_X: false }).process('{{#IF_X}}y{{#ELSE}}n{{/IF_X}}');
    expect(tOn.trim()).toBe('y');
    expect(tOff.trim()).toBe('n');
  });
});

describe('processTemplate (convenience wrapper)', () => {
  it('combines variables and conditions', () => {
    const out = processTemplate(
      'Hi {{USER}}.{{#IF_VIP}} VIP{{/IF_VIP}}',
      { USER: 'Alice' },
      { IF_VIP: true },
    );
    expect(out.trim()).toBe('Hi Alice. VIP');
  });
});

// ── logger.ts ─────────────────────────────────────────────────────────

describe('logger', () => {
  it('header writes to stderr in json mode', () => {
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      captured.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      logger.setJsonMode(true);
      logger.header('test');
      logger.success('ok');
      logger.warn('w');
      logger.fail('f');
      logger.info('i');
      logger.dim('d');
      logger.detected('label', true);
      logger.detected('label', 'value');
      logger.detected('label', false);
    } finally {
      process.stderr.write = orig;
      logger.setJsonMode(false);
    }
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.some((s) => s.includes('test'))).toBe(true);
  });

  it('bold returns ANSI-wrapped string', () => {
    const out = logger.bold('hi');
    expect(out).toContain('hi');
  });
});

// ── tool-registry.ts (pure paths) ─────────────────────────────────────

describe('getInstallCommand', () => {
  it('returns macos command on darwin', () => {
    const def = TOOL_DEFS.cloc;
    const orig = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      expect(getInstallCommand(def)).toBe(def.installCommands.macos);
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig);
    }
  });

  it('returns linux command on linux', () => {
    const def = TOOL_DEFS.cloc;
    const orig = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(getInstallCommand(def)).toBe(def.installCommands.linux);
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig);
    }
  });
});

describe('buildRequiredTools', () => {
  it('always includes universal tools', () => {
    const tools = buildRequiredTools({ node: false } as never);
    const names = tools.map((t) => t.name);
    expect(names).toContain('cloc');
    expect(names).toContain('gitleaks');
    expect(names).toContain('semgrep');
    expect(names).toContain('graphify');
    expect(names).toContain('jscpd');
  });

  it('adds node tools when node is detected', () => {
    const tools = buildRequiredTools({ node: true } as never);
    const names = tools.map((t) => t.name);
    expect(names).toContain('eslint');
    expect(names).toContain('npm-audit');
    expect(names).toContain('vitest-coverage');
  });

  it('adds python tools when python is detected', () => {
    const tools = buildRequiredTools({ python: true } as never);
    const names = tools.map((t) => t.name);
    expect(names).toContain('ruff');
    expect(names).toContain('pip-audit');
    expect(names).toContain('coverage-py');
  });

  it('adds go tools when go is detected', () => {
    const tools = buildRequiredTools({ go: true } as never);
    const names = tools.map((t) => t.name);
    expect(names).toContain('golangci-lint');
    expect(names).toContain('govulncheck');
  });

  it('adds rust tools when rust is detected', () => {
    const tools = buildRequiredTools({ rust: true } as never);
    const names = tools.map((t) => t.name);
    expect(names).toContain('clippy');
    expect(names).toContain('cargo-audit');
  });

  it('adds csharp tools when csharp is detected', () => {
    const tools = buildRequiredTools({ csharp: true } as never);
    const names = tools.map((t) => t.name);
    expect(names).toContain('dotnet-format');
  });
});

describe('checkAllTools', () => {
  it('returns a status entry for each required tool', () => {
    const statuses = checkAllTools({ node: true } as never, tmp);
    const names = statuses.map((s) => s.name);
    expect(names).toContain('cloc');
    expect(names).toContain('eslint');
    for (const s of statuses) {
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('available');
      expect(s).toHaveProperty('source');
      expect(s).toHaveProperty('requirement');
    }
  });
});
