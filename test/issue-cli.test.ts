import { describe, expect, it } from 'vitest';
import { buildIssueUrl, ISSUE_TYPES, type BuildIssueUrlInput } from '../src/issue-cli';

function baseInput(over: Partial<BuildIssueUrlInput> = {}): BuildIssueUrlInput {
  return {
    type: 'bug',
    dxkitVersion: '2.6.0-test',
    nodeVersion: 'v22.0.0',
    platform: 'linux',
    arch: 'x64',
    ...over,
  };
}

function parseUrl(url: string): { title: string; body: string; labels: string } {
  const u = new URL(url);
  return {
    title: u.searchParams.get('title') ?? '',
    body: u.searchParams.get('body') ?? '',
    labels: u.searchParams.get('labels') ?? '',
  };
}

describe('buildIssueUrl', () => {
  it('targets the dxkit GitHub Issues new-issue endpoint', () => {
    const url = buildIssueUrl(baseInput());
    expect(url).toMatch(/^https:\/\/github\.com\/vyuh-labs\/dxkit\/issues\/new\?/);
  });

  it('encodes title + body + labels as query params', () => {
    const url = buildIssueUrl(baseInput());
    const parsed = parseUrl(url);
    expect(parsed.title.length).toBeGreaterThan(0);
    expect(parsed.body.length).toBeGreaterThan(0);
    expect(parsed.labels.length).toBeGreaterThan(0);
  });

  it('per-type title prefix surfaces in the title', () => {
    const cases: Array<[(typeof ISSUE_TYPES)[number], string]> = [
      ['bug', '[Bug]'],
      ['false-positive', '[False positive]'],
      ['missing-finding', '[Missing finding]'],
      ['feature-request', '[Feature request]'],
      ['docs', '[Docs]'],
    ];
    for (const [type, prefix] of cases) {
      const parsed = parseUrl(buildIssueUrl(baseInput({ type })));
      expect(parsed.title, `type=${type}`).toContain(prefix);
    }
  });

  it('per-type label is applied', () => {
    const cases: Array<[(typeof ISSUE_TYPES)[number], string]> = [
      ['bug', 'bug'],
      ['false-positive', 'false-positive'],
      ['missing-finding', 'missing-finding'],
      ['feature-request', 'enhancement'],
      ['docs', 'documentation'],
    ];
    for (const [type, label] of cases) {
      const parsed = parseUrl(buildIssueUrl(baseInput({ type })));
      expect(parsed.labels, `type=${type}`).toBe(label);
    }
  });

  it('body includes env metadata (dxkit version, node version, platform, arch)', () => {
    const parsed = parseUrl(
      buildIssueUrl(
        baseInput({
          dxkitVersion: '2.6.0-test',
          nodeVersion: 'v22.1.0',
          platform: 'darwin',
          arch: 'arm64',
        }),
      ),
    );
    expect(parsed.body).toContain('**dxkit version:** 2.6.0-test');
    expect(parsed.body).toContain('**Node version:** v22.1.0');
    expect(parsed.body).toContain('**Platform:** darwin / arm64');
  });

  it('body includes the type', () => {
    const parsed = parseUrl(buildIssueUrl(baseInput({ type: 'false-positive' })));
    expect(parsed.body).toContain('**Type:** false-positive');
  });

  it('embeds --fingerprint in the body when provided', () => {
    const parsed = parseUrl(
      buildIssueUrl(baseInput({ type: 'false-positive', fingerprint: 'a3f9c0e8b7d2e1f4' })),
    );
    expect(parsed.body).toContain('**Finding fingerprint:** `a3f9c0e8b7d2e1f4`');
  });

  it('embeds the --about text in the title (truncated) and body (full)', () => {
    const long = 'the scanner flagged my intentional placeholder API key as a real secret';
    const parsed = parseUrl(buildIssueUrl(baseInput({ about: long })));
    // Title is truncated to a short summary
    expect(parsed.title.length).toBeLessThanOrEqual(80);
    expect(parsed.title).toContain('the scanner flagged');
    // Body carries the full text
    expect(parsed.body).toContain(long);
  });

  it('falls back to placeholder text in body when --about is omitted', () => {
    const parsed = parseUrl(buildIssueUrl(baseInput({ about: undefined })));
    expect(parsed.body).toContain('Describe what you observed');
  });

  it('falls back to fingerprint-based title when --about is omitted', () => {
    const parsed = parseUrl(
      buildIssueUrl(baseInput({ type: 'false-positive', fingerprint: 'a3f9c0e8b7d2e1f4' })),
    );
    expect(parsed.title).toContain('finding a3f9c0e8b7d2e1f4');
  });

  it('ISSUE_TYPES is the complete known list', () => {
    expect([...ISSUE_TYPES]).toEqual([
      'false-positive',
      'missing-finding',
      'bug',
      'feature-request',
      'docs',
    ]);
  });

  it('URL is < 8KB (GitHub URL limit for safety)', () => {
    // A maximally pre-filled URL — long about text + fingerprint —
    // should still fit comfortably under GitHub's effective URL limit.
    const url = buildIssueUrl(
      baseInput({
        about: 'x'.repeat(2000),
        fingerprint: 'a'.repeat(16),
      }),
    );
    expect(url.length).toBeLessThan(8192);
  });
});
