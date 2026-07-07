/**
 * Self-invocation playbook + contract — closes the class of bug where a
 * surface that auto-invokes the dxkit CLI is added without teaching the
 * install flow it needs a resolvable dxkit. That class shipped the loop
 * Stop hook 404-ing on pure-npx installs (it was absent from the
 * hand-maintained `wantHooks || wantCi` chain). Mirror of
 * `recipe-playbook.test.ts` (language packs) and `producer-playbook.test.ts`
 * (baseline producers).
 *
 * Two guarantees:
 *   1. Contract — every registered surface is well-formed, and every flag
 *      that gates a surface actually flips `requiresResolvableCli`.
 *   2. Playbook — a synthetic surface injected into the registry flows
 *      through `requiresResolvableCli`. If a future refactor makes that
 *      function iterate a hardcoded subset instead of its registry argument,
 *      this fails — the architecture stopped being registry-driven.
 */
import { describe, it, expect } from 'vitest';
import {
  DXKIT_CLI,
  dxkitCli,
  claudeHookCommand,
  SELF_INVOCATION_SURFACES,
  activeSelfInvocationSurfaces,
  requiresResolvableCli,
  type SelfInvocationSurface,
  type SurfaceFlags,
} from '../src/self-invocation';

describe('dxkitCli — canonical CLI invocation', () => {
  it('builds the bare and sub-command forms', () => {
    expect(DXKIT_CLI).toBe('npx vyuh-dxkit');
    expect(dxkitCli()).toBe('npx vyuh-dxkit');
    expect(dxkitCli('hook stop-gate')).toBe('npx vyuh-dxkit hook stop-gate');
    expect(dxkitCli('baseline create')).toBe('npx vyuh-dxkit baseline create');
  });
});

describe('claudeHookCommand — cwd-anchored form for .claude/settings.json hooks', () => {
  it('anchors to the project root before invoking, and keeps the subcommand intact', () => {
    // A Claude Code hook fires from the agent's shell cwd, which may be a
    // subdirectory. Anchor to $CLAUDE_PROJECT_DIR so dxkit analyzes the repo
    // root, not whatever subtree the shell sits in.
    const cmd = claudeHookCommand('hook stop-gate');
    expect(cmd).toBe('cd "${CLAUDE_PROJECT_DIR:-.}" && npx vyuh-dxkit hook stop-gate');
    // The `:-.}` default keeps a non-Claude invocation a harmless no-op cd.
    expect(cmd).toContain('${CLAUDE_PROJECT_DIR:-.}');
    // Doctor + installer detection keys on the raw subcommand — it must survive.
    expect(cmd).toContain('hook stop-gate');
    expect(claudeHookCommand('context-hook')).toBe(
      'cd "${CLAUDE_PROJECT_DIR:-.}" && npx vyuh-dxkit context-hook',
    );
  });
});

describe('SELF_INVOCATION_SURFACES — contract', () => {
  it('registers the four auto-running surfaces with unique ids', () => {
    const ids = SELF_INVOCATION_SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The four surfaces that auto-execute the dxkit CLI after install.
    expect(ids).toEqual(
      expect.arrayContaining([
        'context-hook',
        'loop-stop-gate-hook',
        'pre-push-guardrail-hook',
        'ci-guardrail-workflow',
      ]),
    );
  });

  it('every surface is well-formed', () => {
    for (const s of SELF_INVOCATION_SURFACES) {
      expect(s.id).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.invokes).toBeTruthy();
      expect(typeof s.installedWhen).toBe('function');
    }
  });

  it('no flags → no surface active → CLI not required', () => {
    expect(activeSelfInvocationSurfaces({})).toEqual([]);
    expect(requiresResolvableCli({})).toBe(false);
  });

  it('each surface flag independently requires a resolvable CLI', () => {
    const cases: Array<[keyof SurfaceFlags, string]> = [
      ['claudeSettings', 'context-hook'],
      ['claudeLoop', 'loop-stop-gate-hook'],
      ['gitHooks', 'pre-push-guardrail-hook'],
      ['ciGuardrails', 'ci-guardrail-workflow'],
    ];
    for (const [flag, expectedId] of cases) {
      const flags: SurfaceFlags = { [flag]: true };
      expect(requiresResolvableCli(flags)).toBe(true);
      expect(activeSelfInvocationSurfaces(flags).map((s) => s.id)).toContain(expectedId);
    }
  });
});

describe('self-invocation playbook — synthetic surface injection', () => {
  it('a newly registered surface flows through requiresResolvableCli', () => {
    const sentinel: SelfInvocationSurface = {
      id: 'synthetic-surface',
      description: 'synthetic test surface that invokes the CLI',
      invokes: 'synthetic-subcommand',
      // Active only on a flag no real surface reads, so the assertion is
      // unambiguous: it must be THIS surface flipping the result.
      installedWhen: (f) => (f as Record<string, unknown>).__synthetic === true,
    };
    const registry = [...SELF_INVOCATION_SURFACES, sentinel];
    const flags = { __synthetic: true } as unknown as SurfaceFlags;

    // The real registry doesn't know this flag → no surface.
    expect(requiresResolvableCli(flags)).toBe(false);
    // The injected registry does → the function iterates what it's given.
    expect(requiresResolvableCli(flags, registry)).toBe(true);
    expect(activeSelfInvocationSurfaces(flags, registry).map((s) => s.id)).toEqual([
      'synthetic-surface',
    ]);
  });
});
