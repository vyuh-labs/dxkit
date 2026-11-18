/**
 * The owner-section primitives (`src/owner-section.ts`): split, normal form,
 * provenance hash, splice, and the uninstall projection. Every consumer
 * (generator write + hash, uninstall) reads these, so their edge cases are
 * pinned here once.
 */
import { describe, it, expect } from 'vitest';
import {
  OWNER_SECTION_START as S,
  OWNER_SECTION_END as E,
  splitOwnerSection,
  hasOwnerContent,
  normalizeOwnerSection,
  managedContentHash,
  spliceOwnerSection,
  ownerContentOnly,
} from '../src/owner-section';
import { sha256 } from '../src/files';

const doc = (body: string, top = '# P\n\n', bottom = '\n## dxkit\n\nrefreshable\n') =>
  `${top}${S}\n${body}${E}\n${bottom}`;

describe('splitOwnerSection', () => {
  it('splits a well-formed section, body verbatim', () => {
    const split = splitOwnerSection(doc('line one\n\nline {{TWO}}\n'));
    expect(split).not.toBeNull();
    expect(split!.body).toBe('line one\n\nline {{TWO}}\n');
    expect(split!.head.endsWith(`${S}\n`)).toBe(true);
    expect(split!.tail.startsWith(E)).toBe(true);
  });

  it('accepts an empty section and CRLF / indented marker lines', () => {
    expect(splitOwnerSection(doc(''))!.body).toBe('');
    const crlf = `a\r\n  ${S}\r\nbody\r\n${E}\r\nz\r\n`;
    expect(splitOwnerSection(crlf)!.body).toBe('body\r\n');
  });

  it('returns null for anything not exactly one start + one later end', () => {
    expect(splitOwnerSection('# no markers\n')).toBeNull();
    expect(splitOwnerSection(`${S}\nbody\n`)).toBeNull(); // lone start
    expect(splitOwnerSection(`${E}\n${S}\n`)).toBeNull(); // reversed
    expect(splitOwnerSection(doc('x\n') + `${S}\ny\n${E}\n`)).toBeNull(); // duplicated
    // A marker mentioned inline in prose is not a marker line.
    expect(splitOwnerSection(`text ${S} more\n${E}\n`)).toBeNull();
  });
});

describe('normal form + provenance hash', () => {
  it('owner text never moves the hash; text outside the section does', () => {
    const empty = doc('');
    const filled = doc('Product: order intake.\nBuild: msbuild.\n');
    expect(normalizeOwnerSection(filled)).toBe(empty);
    expect(managedContentHash('AGENTS.md', filled)).toBe(managedContentHash('AGENTS.md', empty));
    const outside = filled.replace('refreshable', 'the user rewrote this');
    expect(managedContentHash('AGENTS.md', outside)).not.toBe(
      managedContentHash('AGENTS.md', empty),
    );
  });

  it('a file without a well-formed section hashes byte-for-byte (legacy installs)', () => {
    const legacy = '# P\n\nA project\n\n## How to use this file\n';
    expect(managedContentHash('AGENTS.md', legacy)).toBe(sha256(legacy));
  });

  it('only owner-section files are normalized; every other file hashes as-is', () => {
    const filled = doc('owner text\n');
    expect(managedContentHash('CLAUDE.md', filled)).toBe(sha256(filled));
    expect(managedContentHash('.claude/skills/x/SKILL.md', filled)).toBe(sha256(filled));
  });

  it('hasOwnerContent ignores whitespace-only bodies', () => {
    expect(hasOwnerContent(doc(''))).toBe(false);
    expect(hasOwnerContent(doc('\n  \n'))).toBe(false);
    expect(hasOwnerContent(doc('x\n'))).toBe(true);
    expect(hasOwnerContent('no markers\n')).toBe(false);
  });
});

describe('spliceOwnerSection', () => {
  const rendered = doc('', '# P v2\n\n', '\n## dxkit v2\n');

  it('carries the owner body verbatim into the new render', () => {
    const disk = doc('Our notes {{NOT_A_VAR}}\n');
    expect(spliceOwnerSection(rendered, disk)).toBe(
      doc('Our notes {{NOT_A_VAR}}\n', '# P v2\n\n', '\n## dxkit v2\n'),
    );
  });

  it('absent file / empty section / unrecognisable file → the render unchanged', () => {
    expect(spliceOwnerSection(rendered, null)).toBe(rendered);
    expect(spliceOwnerSection(rendered, doc(''))).toBe(rendered);
    expect(spliceOwnerSection(rendered, '# legacy without markers\n')).toBe(rendered);
  });

  it('refuses (null) when the render has no section but the disk holds owner text', () => {
    expect(spliceOwnerSection('# no section\n', doc('keep me\n'))).toBeNull();
  });
});

describe('ownerContentOnly (uninstall keeps the owner text)', () => {
  it('returns just the owner text, trimmed of surrounding blank lines', () => {
    expect(ownerContentOnly(doc('\n\n## Product\n\nWarehouse API.\n\n'))).toBe(
      '## Product\n\nWarehouse API.\n',
    );
  });
  it('null when there is nothing of the owner to keep', () => {
    expect(ownerContentOnly(doc(''))).toBeNull();
    expect(ownerContentOnly('no markers\n')).toBeNull();
  });
});
