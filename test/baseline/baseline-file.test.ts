import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import {
  BASELINE_SCHEMA_VERSION,
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  readBaselineFile,
  writeBaselineFile,
} from '../../src/baseline/baseline-file';
import type { BaselineFile } from '../../src/baseline/baseline-file';

function sampleFile(overrides: Partial<BaselineFile> = {}): BaselineFile {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name: DEFAULT_BASELINE_NAME,
    createdAt: '2026-05-18T12:00:00.000Z',
    repo: { commitSha: 'a'.repeat(40), branch: 'main', root: '/repo' },
    analysis: {
      dxkitVersion: '2.5.0',
      policyHash: 'p'.repeat(16),
      ignoreHash: 'i'.repeat(16),
      toolchainHash: 't'.repeat(16),
      configHash: 'c'.repeat(16),
    },
    tools: { gitleaks: 'unknown', semgrep: 'unknown' },
    saltMode: 'deterministic',
    findings: [],
    ...overrides,
  };
}

describe('baseline-file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-baseline-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('pathForBaseline puts the file under .dxkit/baselines/<name>.json', () => {
    expect(pathForBaseline('/r', 'main')).toBe('/r/.dxkit/baselines/main.json');
    expect(pathForBaseline('/r', 'release')).toBe('/r/.dxkit/baselines/release.json');
  });

  it('roundtrips through write + read', () => {
    const file = sampleFile({
      findings: [
        {
          id: 'abc123def4567890',
          kind: 'secret',
          tool: 'gitleaks',
          rule: 'generic-api-key',
          file: 'src/config.ts',
          line: 42,
        },
      ],
    });
    const p = pathForBaseline(dir, 'main');
    writeBaselineFile(p, file);
    expect(existsSync(p)).toBe(true);
    const back = readBaselineFile(p);
    expect(back).toEqual(file);
  });

  it('creates the parent directory on write', () => {
    const p = pathForBaseline(dir, 'main');
    expect(existsSync(join(dir, '.dxkit', 'baselines'))).toBe(false);
    writeBaselineFile(p, sampleFile());
    expect(existsSync(join(dir, '.dxkit', 'baselines'))).toBe(true);
  });

  it('writes pretty-printed JSON with trailing newline', () => {
    const p = pathForBaseline(dir, 'main');
    writeBaselineFile(p, sampleFile());
    const raw = readFileSync(p, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toMatch(/\n {2}"schemaVersion": /);
  });

  const writeRaw = (p: string, raw: string): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, raw, 'utf8');
  };

  it('throws when reading invalid JSON', () => {
    const p = pathForBaseline(dir, 'main');
    writeRaw(p, '{not-json');
    expect(() => readBaselineFile(p)).toThrow(/not valid JSON/);
  });

  it('throws when the schema banner is missing', () => {
    const p = pathForBaseline(dir, 'main');
    writeRaw(p, JSON.stringify({ name: 'x' }));
    expect(() => readBaselineFile(p)).toThrow(/schemaVersion/);
  });

  it('throws when the schema banner is an unrecognized version', () => {
    const p = pathForBaseline(dir, 'main');
    writeRaw(p, JSON.stringify({ schemaVersion: 'dxkit-baseline/v999' }));
    expect(() => readBaselineFile(p)).toThrow(/dxkit-baseline\/v999/);
  });

  it('throws when the JSON root is not an object', () => {
    const p = pathForBaseline(dir, 'main');
    writeRaw(p, '[]');
    expect(() => readBaselineFile(p)).toThrow(/not an object/);
  });

  describe('retired-kind migration', () => {
    it('silently filters license entries written by an older dxkit', () => {
      const p = pathForBaseline(dir, 'main');
      writeRaw(
        p,
        JSON.stringify({
          ...sampleFile(),
          findings: [
            {
              id: 'abc123def4567890',
              kind: 'secret',
              tool: 'gitleaks',
              rule: 'generic-api-key',
              file: 'src/config.ts',
              line: 42,
            },
            {
              id: 'lic1',
              kind: 'license',
              package: 'lodash',
              version: '4.17.20',
              licenseType: 'MIT',
            },
            {
              id: 'lic2',
              kind: 'license',
              package: 'react',
              version: '18.0.0',
              licenseType: 'MIT',
            },
          ],
        }),
      );
      const back = readBaselineFile(p);
      expect(back.findings).toHaveLength(1);
      expect(back.findings[0].kind).toBe('secret');
    });

    it('preserves the file on disk (drop is in-memory only)', () => {
      const p = pathForBaseline(dir, 'main');
      const raw = JSON.stringify({
        ...sampleFile(),
        findings: [
          { id: 'lic1', kind: 'license', package: 'lodash', version: '4.0', licenseType: 'MIT' },
        ],
      });
      writeRaw(p, raw);
      readBaselineFile(p);
      expect(readFileSync(p, 'utf8')).toBe(raw);
    });

    it('returns the identity-equal file when no retired entries are present', () => {
      const p = pathForBaseline(dir, 'main');
      const file = sampleFile({
        findings: [{ id: 'lf1', kind: 'large-file', file: 'src/big.ts' }],
      });
      writeBaselineFile(p, file);
      const back = readBaselineFile(p);
      expect(back.findings).toEqual(file.findings);
    });
  });
});
