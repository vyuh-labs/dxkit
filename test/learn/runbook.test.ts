/**
 * The runbook surface (issue #246): rendered from repo truth, dxkit-owned via
 * the marker line, registered as a managed ship surface (Rule 15) so update
 * refreshes it and uninstall removes it — and `capabilities --markdown`
 * renders from the same learn bundle as the page (one content path).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RUNBOOK_FILENAME, RUNBOOK_MARKER, renderRunbook } from '../../src/learn/runbook';
import { installRunbook } from '../../src/ship-installers';
import { MANAGED_SHIP_SURFACES, managedGatedArtifacts } from '../../src/managed-artifacts';
import { renderCapabilitiesMarkdown } from '../../src/discovery/capabilities-cli';
import type { ManifestInstallFlags } from '../../src/types';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-runbook-'));
}

function seedRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.dxkit', 'policy.json'),
    JSON.stringify({ loop: { preset: 'security-only' }, checks: [{}, {}] }),
  );
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.github', 'workflows', 'dxkit-guardrails.yml'),
    'on: pull_request\n',
  );
  fs.writeFileSync(
    path.join(dir, '.github', 'workflows', 'dxkit-dep-bump.yml'),
    "on:\n  schedule:\n    - cron: '0 7 * * 1'\n",
  );
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.githooks', 'pre-push'), '#!/bin/sh\n');
}

describe('renderRunbook — repo truth, deterministic, marker-first', () => {
  it('renders the armed gates, policy posture, and lane schedules of THIS repo', () => {
    const dir = tmpdir();
    seedRepo(dir);
    const md = renderRunbook(dir);
    expect(md.startsWith(RUNBOOK_MARKER)).toBe(true);
    expect(md).toContain('pre-push hook');
    expect(md).toContain('dxkit-guardrails');
    expect(md).toContain('security-only');
    expect(md).toContain('2 repo-specific custom checks');
    expect(md).toContain('Dependency bump');
    expect(md).toContain('0 7 * * 1');
    expect(md).toContain('allowlist defer');
    expect(md).toContain('CANNOT GATE');
  });

  it('an empty repo renders honestly: no gates armed, no lanes', () => {
    const dir = tmpdir();
    const md = renderRunbook(dir);
    expect(md).toContain('No dxkit gate is currently armed');
    expect(md).toContain('No scheduled lanes are installed');
  });

  it('is deterministic: same tree, same bytes', () => {
    const dir = tmpdir();
    seedRepo(dir);
    expect(renderRunbook(dir)).toBe(renderRunbook(dir));
  });
});

describe('installRunbook — ownership contract', () => {
  it('fresh install writes; identical re-run is a no-op skip', () => {
    const dir = tmpdir();
    seedRepo(dir);
    const first = installRunbook(dir);
    expect(first.installed).toContain(RUNBOOK_FILENAME);
    const second = installRunbook(dir);
    expect(second.installed).toEqual([]);
    expect(second.skipped).toContain(RUNBOOK_FILENAME);
  });

  it('a marker-less (user-owned) file is preserved with a note; --force overwrites', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, RUNBOOK_FILENAME), '# My own runbook\n');
    const kept = installRunbook(dir);
    expect(kept.installed).toEqual([]);
    expect(fs.readFileSync(path.join(dir, RUNBOOK_FILENAME), 'utf8')).toBe('# My own runbook\n');
    expect(kept.notes.join(' ')).toContain('user-owned');
    const forced = installRunbook(dir, { force: true });
    expect(forced.installed).toContain(RUNBOOK_FILENAME);
    expect(fs.readFileSync(path.join(dir, RUNBOOK_FILENAME), 'utf8')).toContain(RUNBOOK_MARKER);
  });

  it('a dxkit-owned (marker) file is refreshed when repo truth changes', () => {
    const dir = tmpdir();
    installRunbook(dir);
    // Repo truth changes: a lane workflow appears.
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.github', 'workflows', 'dxkit-dep-bump.yml'),
      "on:\n  schedule:\n    - cron: '0 7 * * 1'\n",
    );
    const refreshed = installRunbook(dir);
    expect(refreshed.installed).toContain(RUNBOOK_FILENAME);
    expect(fs.readFileSync(path.join(dir, RUNBOOK_FILENAME), 'utf8')).toContain('Dependency bump');
  });
});

describe('runbook is a registered managed surface (Rule 15)', () => {
  it('is in MANAGED_SHIP_SURFACES: always-gated, refreshed on update, artifact declared', () => {
    const surface = MANAGED_SHIP_SURFACES.find((s) => s.id === 'runbook');
    expect(surface).toBeDefined();
    expect(surface!.gate.kind).toBe('always');
    expect(surface!.refreshOnUpdate).toBe(true);
    expect(surface!.artifacts({} as ManifestInstallFlags)).toEqual([RUNBOOK_FILENAME]);
  });

  it('uninstall picks it up via managedGatedArtifacts', () => {
    expect(managedGatedArtifacts({} as ManifestInstallFlags)).toContain(RUNBOOK_FILENAME);
  });
});

describe('capabilities --markdown — one content path with the learn bundle', () => {
  it('renders core commands, groups, and the verbatim limits statement', () => {
    const md = renderCapabilitiesMarkdown();
    expect(md).toContain('# dxkit capabilities');
    expect(md).toContain('`guardrail`');
    expect(md).toContain('`learn`');
    expect(md).toContain('What dxkit verifies, and what it cannot');
    expect(md).toContain('## What dxkit does not verify');
  });
});
