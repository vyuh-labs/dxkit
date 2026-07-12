/**
 * The posture-knob playbook — enforcement for the config-knob layer of
 * CLAUDE.md Rule 16. Mirror of `discovery-playbook.test.ts` (which gates
 * COMMAND discoverability): the `POSTURE_KNOBS` registry names every opt-in
 * config knob, and this test proves each knob's owning command carries the
 * discovery probes the knob declares it needs — so a new gate cannot ship with
 * a knob that `configure` never plans and `doctor`/`capabilities` never
 * surface (the class that shipped the seam gate's `duplication.mode`
 * discovery-invisible until it was caught by hand).
 *
 * It asserts:
 *   - COVERAGE: every knob's owning command satisfies its declared contract
 *     (`requiresPlan` ⟹ planConfig present; `requiresRecommend` ⟹
 *     whenToRecommend present; fully-exempt ⟹ a reason);
 *   - REGRESSION GUARDS: the three knobs this audit closed
 *     (duplication.mode / loop.preset / reports.onMerge) are reachable;
 *   - SYNTHETIC INJECTION: the coverage check actually bites — inject knobs
 *     that violate each rule and assert each is flagged.
 */
import { describe, expect, it } from 'vitest';

import {
  POSTURE_KNOBS,
  checkPostureKnobCoverage,
  type PostureKnob,
} from '../src/discovery/posture-knobs';
import { getCommand, userCommands, type CapabilityDescriptor } from '../src/discovery/commands';

describe('posture-knob registry — discovery coverage (Rule 16 config-knob layer)', () => {
  it('every posture knob satisfies its declared discovery contract', () => {
    const gaps = checkPostureKnobCoverage();
    expect(
      gaps,
      `posture knobs missing their required discovery probes:\n${gaps
        .map((g) => `  - ${g.path} (${g.command}): ${g.problem}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('every knob names a registered user-facing owning command', () => {
    for (const knob of POSTURE_KNOBS) {
      const cmd = getCommand(knob.command);
      expect(cmd, `${knob.path}: owning command '${knob.command}'`).toBeDefined();
      expect(cmd?.audience, `${knob.path}: owning command audience`).toBe('user');
    }
  });

  it('every fully-exempt knob declares a reason (no silent invisibility)', () => {
    for (const knob of POSTURE_KNOBS) {
      if (!knob.requiresPlan && !knob.requiresRecommend) {
        expect(
          knob.exemptionReason?.trim().length ?? 0,
          `${knob.path}: exemptionReason`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('knob paths are unique', () => {
    const seen = new Set<string>();
    for (const knob of POSTURE_KNOBS) {
      expect(seen.has(knob.path), `duplicate knob path: ${knob.path}`).toBe(false);
      seen.add(knob.path);
    }
  });
});

describe('posture-knob registry — regression guards for the audit closes', () => {
  const requiring = (path: string) => POSTURE_KNOBS.find((k) => k.path === path)!;

  it('duplication.mode (the seam-gate class) is plan + recommend reachable', () => {
    const knob = requiring('duplication.mode');
    expect(knob.requiresPlan && knob.requiresRecommend).toBe(true);
    const cmd = getCommand(knob.command)!;
    expect(cmd.planConfig).toBeDefined();
    expect(cmd.whenToRecommend).toBeDefined();
  });

  it('loop.preset now carries a whenToRecommend (gap closed)', () => {
    const knob = requiring('loop.preset');
    expect(knob.requiresRecommend).toBe(true);
    expect(getCommand(knob.command)!.whenToRecommend).toBeDefined();
  });

  it('reports.onMerge now carries a whenToRecommend (gap closed)', () => {
    const knob = requiring('reports.onMerge');
    expect(knob.requiresRecommend).toBe(true);
    expect(getCommand(knob.command)!.whenToRecommend).toBeDefined();
  });
});

describe('posture-knob registry — SYNTHETIC INJECTION (the check bites)', () => {
  // A user-facing command that carries NEITHER probe — the vehicle for the
  // injections. `dashboard` is a pure renderer with no plan/recommend.
  const probeless: CapabilityDescriptor = getCommand('dashboard')!;

  it('flags a knob that requires a planConfig its command lacks', () => {
    const injected: PostureKnob = {
      path: 'synthetic.mode',
      command: probeless.id,
      requiresPlan: true,
      requiresRecommend: false,
    };
    const gaps = checkPostureKnobCoverage([injected], userCommands());
    expect(gaps.map((g) => g.path)).toContain('synthetic.mode');
    expect(gaps[0].problem).toMatch(/planConfig/);
  });

  it('flags a knob that requires a whenToRecommend its command lacks', () => {
    const injected: PostureKnob = {
      path: 'synthetic.recommend',
      command: probeless.id,
      requiresPlan: false,
      requiresRecommend: true,
    };
    const gaps = checkPostureKnobCoverage([injected], userCommands());
    expect(gaps.map((g) => g.path)).toContain('synthetic.recommend');
    expect(gaps[0].problem).toMatch(/whenToRecommend/);
  });

  it('flags a fully-exempt knob with no exemptionReason', () => {
    const injected: PostureKnob = {
      path: 'synthetic.exempt',
      command: probeless.id,
      requiresPlan: false,
      requiresRecommend: false,
    };
    const gaps = checkPostureKnobCoverage([injected], userCommands());
    expect(gaps.map((g) => g.path)).toContain('synthetic.exempt');
    expect(gaps[0].problem).toMatch(/exemptionReason/);
  });

  it('flags a knob whose owning command is not registered', () => {
    const injected: PostureKnob = {
      path: 'synthetic.orphan',
      command: 'no-such-command',
      requiresPlan: false,
      requiresRecommend: false,
      exemptionReason: 'has a reason, but the command does not exist',
    };
    const gaps = checkPostureKnobCoverage([injected], userCommands());
    expect(gaps.map((g) => g.path)).toContain('synthetic.orphan');
    expect(gaps[0].problem).toMatch(/not a registered user-facing command/);
  });

  it('passes a well-formed injected knob (no false positive)', () => {
    // `quality` carries both probes → a knob requiring both is satisfied.
    const injected: PostureKnob = {
      path: 'synthetic.ok',
      command: 'quality',
      requiresPlan: true,
      requiresRecommend: true,
    };
    expect(checkPostureKnobCoverage([injected], userCommands())).toEqual([]);
  });
});
