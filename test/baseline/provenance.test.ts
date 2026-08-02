/**
 * The baseline-provenance module (#222 / #224 / #227 + defects A/B class):
 * one place answers "where did the baseline come from, and is it still a
 * sound anchor?", consumed by the drift remedies, doctor, and the guardrail's
 * baseline-suspect disclosure.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  REFRESH_WORKFLOW_RELPATH,
  refreshWorkflowInstalled,
  readBaselineProvenance,
  detectBaselineSuspect,
  describeBaselineSuspect,
} from '../../src/baseline/provenance';
import { MANAGED_SHIP_SURFACES } from '../../src/managed-artifacts';
import { attributionGapRemedy } from '../../src/baseline/attribution-gap';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-provenance-'));
  dirs.push(d);
  return d;
}

describe('refresh-workflow path parity (Rule 2.30)', () => {
  it('the provenance constant matches the ci-baseline-refresh managed surface', () => {
    // The path is declared canonically on the managed surface; the provenance
    // module duplicates it as a constant (a runtime import would pull the
    // ship-installer graph into every guardrail run). This pin is what makes
    // the duplication safe: they cannot drift silently.
    const surface = MANAGED_SHIP_SURFACES.find((s) => s.id === 'ci-baseline-refresh');
    expect(surface).toBeDefined();
    expect(surface!.artifacts({} as never)).toContain(REFRESH_WORKFLOW_RELPATH);
  });

  it('detects presence/absence of the workflow file', () => {
    const cwd = tmp();
    expect(refreshWorkflowInstalled(cwd)).toBe(false);
    fs.mkdirSync(path.join(cwd, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(cwd, REFRESH_WORKFLOW_RELPATH), 'name: refresh\n');
    expect(refreshWorkflowInstalled(cwd)).toBe(true);
    expect(readBaselineProvenance(cwd, { capturedIn: 'local' })).toMatchObject({
      capturedIn: 'local',
      refreshWorkflowInstalled: true,
    });
  });
});

describe('detectBaselineSuspect (#222 — the stale-anchor signature)', () => {
  const provenance = { refreshWorkflowInstalled: false, createdAt: '2026-07-01T00:00:00Z' };
  const files = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}/f${i}.ts`);

  it('fires when most added findings live in files the diff never touched', () => {
    const s = detectBaselineSuspect({
      addedFiles: [...files(9, 'untouched'), 'touched/a.ts'],
      changedFiles: ['touched/a.ts'],
      provenance,
    });
    expect(s).not.toBeNull();
    expect(s!.untouchedAdded).toBe(9);
    expect(s!.totalAdded).toBe(10);
    expect(s!.remedy).toContain('baseline create --force'); // no lane installed
    const text = describeBaselineSuspect(s!);
    expect(text).toContain('9 of 10');
    expect(text).toContain('2026-07-01');
  });

  it('recommends the CI refresh lane when it is installed', () => {
    const s = detectBaselineSuspect({
      addedFiles: files(10, 'untouched'),
      changedFiles: ['touched/a.ts'],
      provenance: { ...provenance, refreshWorkflowInstalled: true },
    });
    expect(s!.remedy).toContain('baseline-refresh workflow');
    expect(s!.remedy).not.toContain('--force');
  });

  it('stays silent on small deltas (hand-triaged, no meta-disclosure)', () => {
    expect(
      detectBaselineSuspect({
        addedFiles: files(5, 'untouched'),
        changedFiles: ['touched/a.ts'],
        provenance,
      }),
    ).toBeNull();
  });

  it('stays silent when the added findings mostly sit in the diff (developer-introduced)', () => {
    const touched = files(8, 'touched');
    expect(
      detectBaselineSuspect({
        addedFiles: [...touched, 'untouched/x.ts'],
        changedFiles: touched,
        provenance,
      }),
    ).toBeNull();
  });

  it('makes no claim when the changed set is unknowable', () => {
    expect(
      detectBaselineSuspect({ addedFiles: files(20, 'u'), changedFiles: null, provenance }),
    ).toBeNull();
  });
});

describe('attributionGapRemedy (workflow-aware)', () => {
  it('points at the refresh workflow when installed, never a local --force', () => {
    const withLane = attributionGapRemedy(true);
    expect(withLane).toContain('baseline-refresh workflow');
    expect(withLane).not.toContain('--force');
    // Without the lane, the existing remedy is unchanged.
    expect(attributionGapRemedy(false)).toContain('baseline create --force');
    expect(attributionGapRemedy()).toContain('baseline create --force');
  });
});

describe('refresh workflow template carries GH_TOKEN on the recompute step (defect class: per-template drift)', () => {
  it('the recompute step exports GH_TOKEN so syncExpiryNotice / the decision PR can call gh', () => {
    const template = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'src-templates',
        '.github',
        'workflows',
        'dxkit-baseline-refresh.yml',
      ),
      'utf8',
    );
    const recompute = template.slice(template.indexOf('- name: Recompute baseline'));
    const step = recompute.slice(0, recompute.indexOf('- name:', 10));
    expect(step).toContain('GH_TOKEN');
  });
});
