/**
 * Multi-environment baseline composition (CLAUDE.md Rule 20, design §3.4 —
 * 4.0 increment 4): check-level recall honesty, fragment capture, the
 * kind/check-scoped merge with its comparability guards, and the generated
 * refresh-workflow orchestration.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  captureFragment,
  mergeFragment,
  readFragment,
  writeFragment,
  FragmentMergeError,
  FRAGMENT_SCHEMA,
  type BaselineFragment,
} from '../../src/baseline/fragment';
import { customCheckRecallInputs } from '../../src/analyzers/custom-checks/gather';
import { RECALL_EPOCHS } from '../../src/baseline/recall';
import { CURRENT_IDENTITY_SCHEME } from '../../src/baseline/types';
import { BASELINE_SCHEMA_VERSION, type BaselineFile } from '../../src/baseline/baseline-file';
import type { BrownfieldPolicy } from '../../src/baseline/policy';
import { csharp } from '../../src/languages/csharp';
import { typescript } from '../../src/languages/typescript';
import { renderFragmentOrchestration } from '../../src/ship-installers';
import type { ExecutionEnvironment } from '../../src/execution';

const LINT_ON = { lint: { enabled: true } } as unknown as BrownfieldPolicy;

function winformsRepo(withPolicy = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-fragment-'));
  fs.writeFileSync(
    path.join(dir, 'App.csproj'),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0-windows</TargetFramework></PropertyGroup></Project>',
  );
  fs.writeFileSync(path.join(dir, 'Main.cs'), 'class P { static void Main() {} }');
  if (withPolicy) {
    fs.mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.dxkit', 'policy.json'),
      JSON.stringify({ lint: { enabled: true } }),
    );
  }
  return dir;
}

const envOf = (host: 'linux' | 'windows'): ExecutionEnvironment => ({
  host,
  hasToolchain: () => true,
});

describe('check-level recall honesty (the unobserved-check lie, closed)', () => {
  it('an env-unrunnable check contributes NO recall inputs; a runnable one does', () => {
    const dir = winformsRepo();
    try {
      const base = { cwd: dir, policy: LINT_ON, packs: [csharp] };
      const onLinux = customCheckRecallInputs({ ...base, env: envOf('linux') });
      // The windows-only gate was NOT observed here — claiming its recall
      // would read as "comparable, zero findings" and flag the whole
      // pre-existing backlog as net-new on the first windows-side check.
      expect(Object.keys(onLinux).filter((k) => k.startsWith('lint:csharp/'))).toEqual([]);
      const onWindows = customCheckRecallInputs({ ...base, env: envOf('windows') });
      expect(onWindows['lint:csharp/cmd']).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('captureFragment', () => {
  it('captures exactly the primary-unobservable slice, with findings + recall', () => {
    const dir = winformsRepo();
    try {
      const fragment = captureFragment({
        cwd: dir,
        policy: LINT_ON,
        packs: [csharp, typescript],
        env: envOf('windows'),
        // MSBuild emits warnings on exit 0 — the regex parse reads them anyway.
        exec: () => ({
          available: true,
          code: 0,
          output: [
            'Main.cs(10,5): warning CA1051: Do not declare visible instance fields [App.csproj]',
            'Main.cs(20,5): warning CA2007: Consider ConfigureAwait [App.csproj]',
          ].join('\n'),
        }),
      });
      // Default scope: the windows-only csharp gate, never the host-agnostic
      // eslint gate (the primary already observes it).
      expect(fragment.checks).toEqual(['lint:csharp']);
      expect(fragment.findings).toHaveLength(2);
      for (const f of fragment.findings) {
        expect(f.kind).toBe('custom-check');
        expect(f.id).toMatch(/^[0-9a-f]{16}$/);
      }
      expect(fragment.recallInputs['lint:csharp/cmd']).toBeTruthy();
      expect(Object.keys(fragment.recallInputs).every((k) => k.startsWith('lint:csharp/'))).toBe(
        true,
      );
      expect(fragment.identityScheme).toBe(CURRENT_IDENTITY_SCHEME);
      expect(fragment.customCheckEpoch).toBe(RECALL_EPOCHS['custom-check']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips through write + read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-fragment-'));
    try {
      const fragment: BaselineFragment = {
        schema: FRAGMENT_SCHEMA,
        capturedAt: '2026-01-01T00:00:00.000Z',
        host: 'windows',
        identityScheme: CURRENT_IDENTITY_SCHEME,
        customCheckEpoch: RECALL_EPOCHS['custom-check'],
        checks: ['lint:csharp'],
        findings: [],
        recallInputs: {},
      };
      const p = path.join(dir, 'f.json');
      writeFragment(p, fragment);
      expect(readFragment(p)).toEqual(fragment);
      fs.writeFileSync(p, '{"schema":"nope"}');
      expect(() => readFragment(p)).toThrow(FragmentMergeError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeFragment (check-scoped ownership, comparability guards)', () => {
  const baseline: BaselineFile = {
    schemaVersion: BASELINE_SCHEMA_VERSION, // baseline-file-construction-ok: hand-built fixture
    name: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    repo: { headSha: 'x', branch: 'main', dirty: false },
    analysis: {
      dxkitVersion: '4.0.0',
      policyHash: '',
      ignoreHash: '',
      toolchainHash: '',
      configHash: '',
    },
    tools: {},
    saltMode: 'none',
    identityScheme: CURRENT_IDENTITY_SCHEME,
    recall: {
      'custom-check': {
        epoch: RECALL_EPOCHS['custom-check'],
        inputs: { 'lint:csharp/cmd': 'stale', 'lint:typescript/cmd': 'keep-me' },
      },
    },
    findings: [
      { id: 'aaaaaaaaaaaaaaaa', kind: 'custom-check', check: 'lint:csharp', blocking: false },
      { id: 'bbbbbbbbbbbbbbbb', kind: 'custom-check', check: 'lint:typescript', blocking: false },
      {
        id: 'cccccccccccccccc',
        kind: 'secret',
        tool: 'gitleaks',
        rule: 'generic',
        file: 'a.ts',
        line: 1,
      },
    ],
  } as unknown as BaselineFile;

  const fragment: BaselineFragment = {
    schema: FRAGMENT_SCHEMA,
    capturedAt: '2026-01-02T00:00:00.000Z',
    host: 'windows',
    identityScheme: CURRENT_IDENTITY_SCHEME,
    customCheckEpoch: RECALL_EPOCHS['custom-check'],
    checks: ['lint:csharp'],
    findings: [
      { id: 'dddddddddddddddd', kind: 'custom-check', check: 'lint:csharp', blocking: false },
      { id: 'eeeeeeeeeeeeeeee', kind: 'custom-check', check: 'lint:csharp', blocking: false },
    ],
    recallInputs: { 'lint:csharp/cmd': 'fresh', 'lint:csharp/config': 'hash' },
  };

  it('replaces exactly the owned checks — entries and recall keys — and nothing else', () => {
    const merged = mergeFragment(baseline, fragment);
    const ids = merged.findings.map((f) => f.id).sort();
    expect(ids).toEqual([
      'bbbbbbbbbbbbbbbb',
      'cccccccccccccccc',
      'dddddddddddddddd',
      'eeeeeeeeeeeeeeee',
    ]);
    expect(merged.recall?.['custom-check']?.inputs).toEqual({
      'lint:typescript/cmd': 'keep-me',
      'lint:csharp/cmd': 'fresh',
      'lint:csharp/config': 'hash',
    });
    // Envelope untouched.
    expect(merged.name).toBe('main');
    expect(merged.identityScheme).toBe(CURRENT_IDENTITY_SCHEME);
  });

  it('is idempotent (re-merging the same fragment changes nothing)', () => {
    const once = mergeFragment(baseline, fragment);
    const twice = mergeFragment(once, fragment);
    expect(twice.findings.map((f) => f.id).sort()).toEqual(once.findings.map((f) => f.id).sort());
    expect(twice.recall).toEqual(once.recall);
  });

  it('refuses an identity-scheme mismatch with the remedy named', () => {
    const alien = { ...fragment, identityScheme: 'v1' as const };
    expect(() => mergeFragment(baseline, alien)).toThrow(FragmentMergeError);
    expect(() => mergeFragment(baseline, alien)).toThrow(/update migrates/);
  });

  it('refuses a recall-epoch mismatch (capture and merge must share a dxkit)', () => {
    const stale = { ...fragment, customCheckEpoch: RECALL_EPOCHS['custom-check'] + 1 };
    expect(() => mergeFragment(baseline, stale)).toThrow(/epoch/);
  });
});

describe('refresh-workflow fragment orchestration (generated)', () => {
  it('renders a windows capture job + needs + merge steps for a placed lint gate', () => {
    const dir = winformsRepo(true);
    try {
      const r = renderFragmentOrchestration(dir);
      expect(r.captureJobs).toContain('capture-windows:');
      expect(r.captureJobs).toContain('runs-on: windows-latest');
      expect(r.captureJobs).toContain('--checks lint:csharp');
      expect(r.captureJobs).toContain('upload-artifact');
      expect(r.captureJobs).toContain('actions/setup-dotnet');
      expect(r.needs).toContain('needs: [capture-windows]');
      expect(r.mergeSteps).toContain('merge-fragment');
      // The generator lesson holds here too: setup actions only.
      expect(r.captureJobs).not.toMatch(/Visual Studio.{0,4}\d{4}/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders nothing when lint gating is off, or when nothing is placed off-primary', () => {
    const noPolicy = winformsRepo(false);
    const tsOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-fragment-'));
    try {
      expect(renderFragmentOrchestration(noPolicy)).toEqual({
        captureJobs: '',
        needs: '',
        mergeSteps: '',
      });
      fs.writeFileSync(path.join(tsOnly, 'package.json'), '{"name":"x"}');
      fs.mkdirSync(path.join(tsOnly, '.dxkit'));
      fs.writeFileSync(path.join(tsOnly, '.dxkit', 'policy.json'), '{"lint":{"enabled":true}}');
      expect(renderFragmentOrchestration(tsOnly).captureJobs).toBe('');
    } finally {
      fs.rmSync(noPolicy, { recursive: true, force: true });
      fs.rmSync(tsOnly, { recursive: true, force: true });
    }
  });
});
