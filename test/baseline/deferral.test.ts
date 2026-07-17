/**
 * Capture-time deferral partition (CLAUDE.md Rule 20, applied to the baseline).
 *
 * Pins both signals that make a finding class unobservable in the current
 * environment — a missing registry scanner (the stale-mirror incident) and an
 * unmet execution requirement (the wrong-host / missing-SDK case) — and the
 * boundary that keeps non-baseline capabilities out of the partition.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assessCaptureDeferral } from '../../src/baseline/deferral';
import type { ToolStatus } from '../../src/analyzers/tools/tool-registry';
import type { CapabilityRequirement, ExecutionEnvironment } from '../../src/execution';

const tmpRepo = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-deferral-'));

const linux: ExecutionEnvironment = { host: 'linux', hasToolchain: () => false };

/** A ToolStatus with just the fields the partition reads. */
const status = (
  name: string,
  source: ToolStatus['source'],
  description = `${name} desc`,
): ToolStatus =>
  ({
    name,
    available: source !== 'missing' && source !== 'n/a',
    path: null,
    version: null,
    source,
    requirement: { description } as ToolStatus['requirement'],
  }) as ToolStatus;

const capReq = (
  pack: string,
  capability: CapabilityRequirement['capability'],
  hosts: CapabilityRequirement['requirement']['hosts'],
): CapabilityRequirement => ({
  pack,
  capability,
  requirement: { hosts, toolchains: [], needsBuild: false, buildTarget: 'none', weight: 'cheap' },
});

describe('assessCaptureDeferral — capturable-here vs defer-to-CI', () => {
  it('defers nothing when every scanner is present and every requirement is met', () => {
    const repo = tmpRepo();
    const { deferred } = assessCaptureDeferral(repo, {
      env: linux,
      statuses: [status('gitleaks', 'path'), status('semgrep', 'path')],
      requirements: [capReq('typescript', 'depVulns', ['any'])],
    });
    expect(deferred).toEqual([]);
  });

  it('defers a missing scanner (the stale-mirror signal) with its tool description as the label', () => {
    const repo = tmpRepo();
    const { deferred } = assessCaptureDeferral(repo, {
      env: linux,
      statuses: [
        status('gitleaks', 'path'),
        status('semgrep', 'missing', 'Static analysis security scanner (SAST)'),
      ],
      requirements: [],
    });
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({
      id: 'semgrep',
      label: 'Static analysis security scanner (SAST)',
      cause: 'scanner-missing',
    });
    expect(deferred[0].reason).toMatch(/mirror|proxy|CI/i);
  });

  it('does NOT defer a not-applicable scanner (nothing to capture ≠ a gap)', () => {
    const repo = tmpRepo();
    const { deferred } = assessCaptureDeferral(repo, {
      env: linux,
      statuses: [status('pip-audit', 'n/a')],
      requirements: [],
    });
    expect(deferred).toEqual([]);
  });

  it('defers a baseline-contributing capability whose host requirement is unmet', () => {
    const repo = tmpRepo();
    const { deferred } = assessCaptureDeferral(repo, {
      env: linux,
      statuses: [],
      requirements: [capReq('csharp', 'depVulns', ['windows'])],
    });
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ id: 'csharp:depVulns', cause: 'unmet-requirement' });
    expect(deferred[0].reason).toMatch(/windows/i);
  });

  it('does NOT defer non-baseline capabilities (correctness floor, lint fragment path)', () => {
    const repo = tmpRepo();
    const { deferred } = assessCaptureDeferral(repo, {
      env: linux,
      statuses: [],
      requirements: [
        capReq('csharp', 'correctness', ['windows']),
        capReq('csharp', 'lintGate', ['windows']),
      ],
    });
    expect(deferred).toEqual([]);
  });

  it('unions both signals, dedups by id, and sorts deterministically', () => {
    const repo = tmpRepo();
    const { deferred } = assessCaptureDeferral(repo, {
      env: linux,
      statuses: [status('semgrep', 'missing'), status('pip-audit', 'missing')],
      requirements: [capReq('csharp', 'deepSast', ['windows'])],
    });
    expect(deferred.map((d) => d.id)).toEqual(['csharp:deepSast', 'pip-audit', 'semgrep']);
  });
});
