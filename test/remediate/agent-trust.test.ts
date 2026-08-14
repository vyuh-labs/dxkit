import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  armInLoopGate,
  checkoutTrusted,
  preTrustAgentCheckout,
  probeStopGateWiring,
} from '../../src/remediate/agent-trust';

/**
 * #305 — the in-loop Stop-gate wiring. The class under test: the driver
 * armed DXKIT_LOOP_ACTIVE while the CI checkout was an untrusted
 * workspace, so the committed Stop hook never loaded and the in-loop
 * gate was silently absent on every lane run ever. These tests pin the
 * three duties: the pre-trust write (merge-preserving, CI-gated), the
 * positive-evidence probe (armed only when every verifiable link holds),
 * and the disclosure (backstop-only always carries the first missing
 * link as its reason).
 */

let home: string;
let checkout: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dxkit-agent-home-'));
  checkout = mkdtempSync(join(tmpdir(), 'dxkit-agent-checkout-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(checkout, { recursive: true, force: true });
});

function writeStopHook(cmd = 'npx vyuh-dxkit hook stop-gate'): void {
  mkdirSync(join(checkout, '.claude'), { recursive: true });
  writeFileSync(
    join(checkout, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] } }),
  );
}

function installLocalCli(): void {
  // resolveDxkitCli probes the project-local .bin shim first.
  const bin = join(checkout, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'vyuh-dxkit'), '#!/bin/sh\n', { mode: 0o755 });
}

describe('preTrustAgentCheckout', () => {
  it('creates ~/.claude.json with the project trusted', () => {
    const res = preTrustAgentCheckout(checkout, { home });
    expect(res.applied).toBe(true);
    expect(checkoutTrusted(checkout, { home })).toBe(true);
  });

  it('merges into an existing config without clobbering other keys or projects', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        theme: 'dark',
        projects: { '/other/repo': { hasTrustDialogAccepted: true, allowedTools: ['x'] } },
      }),
    );
    preTrustAgentCheckout(checkout, { home });
    const doc = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(doc.theme).toBe('dark');
    expect(doc.projects['/other/repo']).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ['x'],
    });
    expect(doc.projects[resolve(checkout)].hasTrustDialogAccepted).toBe(true);
  });

  it('reports (never throws) when the home config is unwritable', () => {
    const res = preTrustAgentCheckout(checkout, { home: join(home, 'missing', 'nested') });
    expect(res.applied).toBe(false);
    expect(res.reason).toBeTruthy();
  });
});

describe('probeStopGateWiring — positive evidence only', () => {
  it('no Stop hook in the checkout → backstop-only naming the missing link', () => {
    const status = probeStopGateWiring(checkout, { home });
    expect(status.mode).toBe('backstop-only');
    expect(status.reason).toContain('no Stop hook');
  });

  it('hook present but the workspace untrusted → backstop-only (THE #305 shape)', () => {
    writeStopHook();
    const status = probeStopGateWiring(checkout, { home });
    expect(status.mode).toBe('backstop-only');
    expect(status.reason).toContain('not a trusted workspace');
  });

  it('hook + trust but vyuh-dxkit does not resolve → backstop-only (the 404 class)', () => {
    writeStopHook();
    preTrustAgentCheckout(checkout, { home });
    // Injected resolver: a dev machine's global install must not leak in.
    const status = probeStopGateWiring(checkout, { home, cliResolves: () => false });
    expect(status.mode).toBe('backstop-only');
    expect(status.reason).toContain('does not resolve');
  });

  it('every link verified → in-loop-gated, with the max_turns limit still named', () => {
    writeStopHook();
    preTrustAgentCheckout(checkout, { home });
    installLocalCli();
    const status = probeStopGateWiring(checkout, { home, cliResolves: () => true });
    expect(status.mode).toBe('in-loop-gated');
    expect(status.reason).toContain('max_turns');
  });

  it('a non-dxkit hook command with settings + trust counts as armed (dxkit does not invent refusals for commands it does not own)', () => {
    writeStopHook('node scripts/my-own-stop-gate.js');
    preTrustAgentCheckout(checkout, { home });
    const status = probeStopGateWiring(checkout, { home });
    expect(status.mode).toBe('in-loop-gated');
  });
});

describe('armInLoopGate — the lane entry point', () => {
  it('CI: pre-trusts the checkout, then probes (the untrusted link closes)', () => {
    writeStopHook();
    installLocalCli();
    const status = armInLoopGate(checkout, { home, ci: true });
    expect(status.mode).toBe('in-loop-gated');
    expect(checkoutTrusted(checkout, { home })).toBe(true);
  });

  it('non-CI: never touches the home config — a local ~/.claude.json is the maintainer’s', () => {
    writeStopHook();
    installLocalCli();
    const status = armInLoopGate(checkout, { home, ci: false });
    expect(status.mode).toBe('backstop-only');
    expect(checkoutTrusted(checkout, { home })).toBe(false);
  });
});

describe('lane-owned arming (4.4.3) — the gate is the lane’s guarantee, not a repo opt-in', () => {
  it('CI + no committed Stop hook → the lane installs it at runner scope and arms', () => {
    // The live class: every lane run on a repo without the loop pack was
    // backstop-only by construction, disclosed but unfixable repo-side.
    installLocalCli();
    const status = armInLoopGate(checkout, { home, ci: true });
    expect(status.mode).toBe('in-loop-gated');
    expect(status.reason).toContain('runner scope');
    const runner = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(runner.hooks.Stop).toHaveLength(1);
    expect(runner.hooks.Stop[0].hooks[0].command).toContain('hook stop-gate');
  });

  it('idempotent: a second arming never duplicates the runner-scope hook', () => {
    installLocalCli();
    armInLoopGate(checkout, { home, ci: true });
    armInLoopGate(checkout, { home, ci: true });
    const runner = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as {
      hooks: { Stop: unknown[] };
    };
    expect(runner.hooks.Stop).toHaveLength(1);
  });

  it('a committed Stop hook wins: nothing is installed at runner scope', () => {
    writeStopHook();
    installLocalCli();
    const status = armInLoopGate(checkout, { home, ci: true });
    expect(status.mode).toBe('in-loop-gated');
    expect(status.reason).toContain('committed settings');
    expect(() => readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toThrow();
  });

  it('existing runner-scope settings are merge-preserved, never clobbered', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [] } }),
    );
    installLocalCli();
    armInLoopGate(checkout, { home, ci: true });
    const runner = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as {
      permissions: { allow: string[] };
      hooks: { PreToolUse: unknown[]; Stop: unknown[] };
    };
    expect(runner.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(runner.hooks.PreToolUse).toEqual([]);
    expect(runner.hooks.Stop).toHaveLength(1);
  });

  it('WORKTREE PURITY: arming writes nothing under the checkout — an injected hook must never leak into the landed commit via the work sweep', () => {
    installLocalCli();
    armInLoopGate(checkout, { home, ci: true });
    expect(() => readFileSync(join(checkout, '.claude', 'settings.json'), 'utf8')).toThrow();
  });

  it('non-CI: no runner-scope installation either — backstop-only stays honest', () => {
    installLocalCli();
    const status = armInLoopGate(checkout, { home, ci: false });
    expect(status.mode).toBe('backstop-only');
    expect(() => readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toThrow();
  });
});
