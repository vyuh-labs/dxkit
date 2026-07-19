/**
 * Stack-aware CI runtime setup (2.32.0). The CI guardrail workflow must set up
 * the DETECTED stack's language toolchain — pack-declared (`ciSetup`), unioned
 * via `allCiSetupSteps` (Rule 6), rendered into the workflow at install — so a
 * non-Node repo's native dep scanner can install and its correctness floor can
 * run. Before this, the templates set up only Node.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { allCiSetupSteps } from '../src/languages';
import { swift } from '../src/languages/swift';
import { installCiGuardrails } from '../src/ship-installers';
import type { DetectedStack } from '../src/types';

function flags(active: Partial<DetectedStack['languages']>): DetectedStack['languages'] {
  return {
    typescript: false,
    python: false,
    go: false,
    rust: false,
    csharp: false,
    kotlin: false,
    java: false,
    ruby: false,
    ...active,
  } as DetectedStack['languages'];
}

describe('allCiSetupSteps — pack-driven CI runtime setup', () => {
  it('go → setup-go, python → setup-python, ruby → setup-ruby (native per-pack)', () => {
    expect(allCiSetupSteps(flags({ go: true })).some((s) => s.uses === 'actions/setup-go@v5')).toBe(
      true,
    );
    expect(
      allCiSetupSteps(flags({ python: true })).some((s) => s.uses === 'actions/setup-python@v5'),
    ).toBe(true);
    expect(
      allCiSetupSteps(flags({ ruby: true })).some((s) => s.uses === 'ruby/setup-ruby@v1'),
    ).toBe(true);
  });

  it("typescript contributes nothing — Node is dxkit's own runtime, already in the template", () => {
    expect(allCiSetupSteps(flags({ typescript: true }))).toEqual([]);
  });

  it('java + kotlin share actions/setup-java, deduped to a single step', () => {
    const steps = allCiSetupSteps(flags({ java: true, kotlin: true }));
    expect(steps.filter((s) => s.uses === 'actions/setup-java@v4')).toHaveLength(1);
  });

  it('polyglot (TS + Go) sets up Go without a duplicate Node runtime', () => {
    const steps = allCiSetupSteps(flags({ typescript: true, go: true }));
    expect(steps.some((s) => s.uses === 'actions/setup-go@v5')).toBe(true);
    expect(steps.some((s) => s.uses.includes('setup-node'))).toBe(false);
  });

  it('swift: provisioning never sees the pbxproj SWIFT_VERSION language mode (4.1.0 rollout bug)', () => {
    // The shipped class: both real iOS repos' pbxproj said SWIFT_VERSION =
    // 5.0 (Xcode's source-compat MODE), the workflow rendered
    // `swift-version: '5.0'`, and setup-swift 404'd the guardrail job — no
    // such toolchain exists for current runners.
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-swift-ci-'));
    try {
      const proj = join(dir, 'App.xcodeproj');
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, 'project.pbxproj'), 'SWIFT_VERSION = 5.0;\n');
      const step = allCiSetupSteps(flags({ swift: true }), dir).find((s) =>
        s.uses.startsWith('swift-actions/setup-swift'),
      )!;
      // Reporting still sees the dialect; provisioning keeps the declared
      // default.
      expect(swift.detectVersion!(dir)).toBe('5.0');
      expect(step.with!['swift-version']).toBe('6.1');

      // A REAL toolchain pin (.swift-version) IS substituted.
      writeFileSync(join(dir, '.swift-version'), '6.0.3\n');
      const pinned = allCiSetupSteps(flags({ swift: true }), dir).find((s) =>
        s.uses.startsWith('swift-actions/setup-swift'),
      )!;
      expect(pinned.with!['swift-version']).toBe('6.0.3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installCiGuardrails renders + re-renders the CI runtime block', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-ci-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const yml = (): string =>
    readFileSync(join(dir, '.github', 'workflows', 'dxkit-guardrails.yml'), 'utf8');

  it('a Go repo gets setup-go with the DETECTED go.mod version; no leftover placeholder', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x\ngo 1.23\n');
    writeFileSync(join(dir, 'main.go'), 'package main\nfunc main(){}\n');
    installCiGuardrails(dir);
    expect(yml()).toContain('uses: actions/setup-go@v5');
    // The version is DERIVED from the repo's go.mod (`go 1.23`), not the pack's
    // hardcoded default — so CI provisions the Go the repo actually targets.
    expect(yml()).toContain("go-version: '1.23'");
    expect(yml()).not.toContain('__DXKIT_CI_RUNTIME_SETUP__');
  });

  it('a Node-only repo renders no language-setup step (single setup-node)', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    writeFileSync(join(dir, 'index.ts'), 'export const x = 1;\n');
    installCiGuardrails(dir);
    expect(yml()).not.toContain('uses: actions/setup-go');
    expect(yml()).not.toContain('uses: actions/setup-python');
    expect((yml().match(/uses: actions\/setup-node/g) || []).length).toBe(1);
    expect(yml()).not.toContain('__DXKIT_CI_RUNTIME_SETUP__');
  });

  it('re-renders (no --force) when a language is added since install — update migration', () => {
    // Install as a Go repo.
    writeFileSync(join(dir, 'go.mod'), 'module x\ngo 1.24\n');
    writeFileSync(join(dir, 'main.go'), 'package main\nfunc main(){}\n');
    installCiGuardrails(dir);
    expect(yml()).not.toContain('uses: actions/setup-python');
    // The repo adds Python; a plain re-run (no force) must refresh the stale
    // workflow to add setup-python, not skip it.
    writeFileSync(join(dir, 'requirements.txt'), 'requests==2.31.0\n');
    writeFileSync(join(dir, 'app.py'), 'print(1)\n');
    const r = installCiGuardrails(dir);
    expect(yml()).toContain('uses: actions/setup-python@v5');
    expect(yml()).toContain('uses: actions/setup-go@v5'); // Go still present
    expect(r.notes.join('\n')).toMatch(/Refreshed the CI guardrails workflow/);
  });
});
