import { describe, it, expect } from 'vitest';
import {
  matchesManifestPattern,
  allDependencyManifestPatterns,
  changedFilesTouchDependencyManifest,
  getLanguage,
  LANGUAGES,
} from '../src/languages';
import type { LanguageSupport } from '../src/languages';

/**
 * Unit tests for the dependency-manifest matcher and registry helpers that
 * drive the incremental ref-based dep-audit skip (2.16). A net-new dependency
 * vulnerability requires a manifest/lockfile change; these helpers decide
 * whether a PR's changed-file set touched one.
 */

describe('matchesManifestPattern', () => {
  it('matches a bare name by basename anywhere in the tree', () => {
    expect(matchesManifestPattern('package.json', 'package.json')).toBe(true);
    expect(matchesManifestPattern('packages/app/package.json', 'package.json')).toBe(true);
    expect(matchesManifestPattern('src/package.json', 'package.json')).toBe(true);
  });

  it('does not match a different basename', () => {
    expect(matchesManifestPattern('src/index.ts', 'package.json')).toBe(false);
    expect(matchesManifestPattern('package.json.bak', 'package.json')).toBe(false);
    expect(matchesManifestPattern('my-package.json', 'package.json')).toBe(false);
  });

  it('matches a glob pattern on the basename', () => {
    expect(matchesManifestPattern('src/App.csproj', '*.csproj')).toBe(true);
    expect(matchesManifestPattern('deep/nested/Web.csproj', '*.csproj')).toBe(true);
    expect(matchesManifestPattern('App.csproj.user', '*.csproj')).toBe(false);
    expect(matchesManifestPattern('requirements-dev.txt', 'requirements*.txt')).toBe(true);
    expect(matchesManifestPattern('requirements.txt', 'requirements*.txt')).toBe(true);
  });

  it('matches a multi-segment pattern as a path suffix', () => {
    expect(
      matchesManifestPattern(
        'gradle/verification-metadata.xml',
        'gradle/verification-metadata.xml',
      ),
    ).toBe(true);
    expect(
      matchesManifestPattern(
        'app/gradle/verification-metadata.xml',
        'gradle/verification-metadata.xml',
      ),
    ).toBe(true);
    // Same basename but wrong parent dir → no match.
    expect(
      matchesManifestPattern('other/verification-metadata.xml', 'gradle/verification-metadata.xml'),
    ).toBe(false);
  });

  it('normalizes Windows-style separators', () => {
    expect(matchesManifestPattern('packages\\app\\package.json', 'package.json')).toBe(true);
  });
});

describe('allDependencyManifestPatterns', () => {
  it('unions the depVulns manifest patterns of the given packs', () => {
    const ts = getLanguage('typescript')!;
    const go = getLanguage('go')!;
    const patterns = allDependencyManifestPatterns([ts, go]);
    expect(patterns).toContain('package.json');
    expect(patterns).toContain('package-lock.json');
    expect(patterns).toContain('go.mod');
    // No csharp pack passed → its patterns absent.
    expect(patterns).not.toContain('*.csproj');
  });

  it('every real pack with a depVulns capability contributes patterns', () => {
    for (const lang of LANGUAGES as LanguageSupport[]) {
      if (!lang.capabilities?.depVulns) continue;
      expect(
        allDependencyManifestPatterns([lang]).length,
        `${lang.id} contributes no manifest patterns`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('changedFilesTouchDependencyManifest', () => {
  const ts = getLanguage('typescript')!;

  it('is true when a manifest is among the changed files', () => {
    expect(changedFilesTouchDependencyManifest(['src/a.ts', 'package.json'], [ts])).toBe(true);
    expect(changedFilesTouchDependencyManifest(['package-lock.json'], [ts])).toBe(true);
  });

  it('is false for a source-only change (the skip case)', () => {
    expect(changedFilesTouchDependencyManifest(['src/a.ts', 'README.md'], [ts])).toBe(false);
    expect(changedFilesTouchDependencyManifest([], [ts])).toBe(false);
  });

  it('is fail-safe (true) when no pack declares any patterns', () => {
    const bare = { capabilities: {} } as unknown as LanguageSupport;
    expect(changedFilesTouchDependencyManifest(['src/a.ts'], [bare])).toBe(true);
  });
});
