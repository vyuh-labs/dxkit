import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensurePolicyJsoncAssociation,
  stripPolicyJsoncAssociation,
  wouldStripPolicyJsoncAssociation,
} from '../src/editor-assoc';

/**
 * The `.vscode/settings.json` association is a MERGE surface into a file the
 * user owns (and one that is itself JSONC): these tests pin the non-clobber
 * contract — only repos already using `.vscode/` get it, the user's comments
 * and keys survive both directions, a malformed file is never touched, and
 * the uninstall strip restores the pre-dxkit shape (pruning only what dxkit
 * added).
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-editor-assoc-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const settingsFile = () => join(repo, '.vscode', 'settings.json');

describe('ensurePolicyJsoncAssociation', () => {
  it('does nothing when the repo has no .vscode directory', () => {
    expect(ensurePolicyJsoncAssociation(repo)).toEqual({ changed: false });
    expect(existsSync(settingsFile())).toBe(false);
  });

  it('creates settings.json with the association when .vscode exists bare', () => {
    mkdirSync(join(repo, '.vscode'));
    expect(ensurePolicyJsoncAssociation(repo)).toEqual({ changed: true });
    const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    expect(parsed['files.associations']['.dxkit/policy.json']).toBe('jsonc');
  });

  it('merges into an existing commented settings.json, preserving everything', () => {
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(
      settingsFile(),
      `{
  // team prefers explicit rulers
  "editor.rulers": [100],
  "files.associations": {
    "*.tpl": "html"
  }
}
`,
      'utf8',
    );
    expect(ensurePolicyJsoncAssociation(repo)).toEqual({ changed: true });
    const text = readFileSync(settingsFile(), 'utf8');
    expect(text).toContain('// team prefers explicit rulers');
    expect(text).toContain('"editor.rulers": [100]');
    expect(text).toContain('"*.tpl": "html"');
    expect(text).toContain('".dxkit/policy.json": "jsonc"');
  });

  it('is idempotent', () => {
    mkdirSync(join(repo, '.vscode'));
    ensurePolicyJsoncAssociation(repo);
    const before = readFileSync(settingsFile(), 'utf8');
    expect(ensurePolicyJsoncAssociation(repo)).toEqual({ changed: false });
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);
  });

  it('refuses to touch a malformed settings.json', () => {
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(settingsFile(), '{ broken', 'utf8');
    expect(ensurePolicyJsoncAssociation(repo)).toEqual({ changed: false });
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{ broken');
  });
});

describe('stripPolicyJsoncAssociation (the uninstall reversal)', () => {
  it('removes the association and prunes an emptied files.associations', () => {
    mkdirSync(join(repo, '.vscode'));
    ensurePolicyJsoncAssociation(repo);
    expect(wouldStripPolicyJsoncAssociation(repo)).toBe(true);
    expect(stripPolicyJsoncAssociation(repo)).toEqual({ changed: true });
    const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    expect(parsed['files.associations']).toBeUndefined();
    expect(wouldStripPolicyJsoncAssociation(repo)).toBe(false);
  });

  it("keeps the user's other associations and comments", () => {
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(
      settingsFile(),
      `{
  // ours
  "files.associations": {
    "*.tpl": "html",
    ".dxkit/policy.json": "jsonc"
  }
}
`,
      'utf8',
    );
    expect(stripPolicyJsoncAssociation(repo)).toEqual({ changed: true });
    const text = readFileSync(settingsFile(), 'utf8');
    expect(text).toContain('// ours');
    expect(text).toContain('"*.tpl": "html"');
    expect(text).not.toContain('.dxkit/policy.json');
  });

  it('no-ops when the association is absent', () => {
    expect(wouldStripPolicyJsoncAssociation(repo)).toBe(false);
    expect(stripPolicyJsoncAssociation(repo)).toEqual({ changed: false });
  });
});
