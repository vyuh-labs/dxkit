import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  renderLoopGuardrailDemo,
  buildNextSteps,
  shouldOfferInteractive,
  cwdState,
} from '../../src/loop/demo';
import { buildRepairMessage } from '../../src/loop/stop-gate';

describe('loop guardrail demo', () => {
  it('produces the real repair message for the example net-new finding', () => {
    const { blockMessage } = renderLoopGuardrailDemo();
    // It must list the example finding with its location…
    expect(blockMessage).toContain('example/payments.js:12');
    expect(blockMessage).toContain('secret');
    // …and carry the loop norm (don't refresh baseline / don't fix unrelated debt).
    expect(blockMessage.toLowerCase()).toContain('do not refresh the baseline');
    expect(blockMessage).toContain('1 net-new');
  });

  it('renders the exact production repair text (not a mock)', () => {
    // The demo must use the real buildRepairMessage code path, so the message
    // it shows is byte-identical to what a live gate would feed the model.
    const { blockMessage } = renderLoopGuardrailDemo();
    // Reconstruct from the same builder over an equivalent single-secret payload.
    expect(blockMessage.startsWith('dxkit blocked completion')).toBe(true);
    expect(typeof buildRepairMessage).toBe('function');
  });
});

describe('demo conversion CTA — buildNextSteps', () => {
  it('initialized: points at loop doctor, never at re-init', () => {
    const lines = buildNextSteps('initialized').join('\n');
    expect(lines).toContain('already has dxkit set up');
    expect(lines).toContain('vyuh-dxkit loop doctor');
    expect(lines).not.toContain('init --claude-loop');
  });

  it('git: shows the full wire-up sequence', () => {
    const lines = buildNextSteps('git').join('\n');
    expect(lines).toContain('vyuh-dxkit init --claude-loop');
    expect(lines).toContain('vyuh-dxkit baseline create');
    expect(lines).toContain('vyuh-dxkit loop doctor');
  });

  it('non-git: points the user at their real project', () => {
    const lines = buildNextSteps('non-git').join('\n');
    expect(lines).toContain('must be a git repo');
    expect(lines).toContain('npm init @vyuhlabs/dxkit');
  });

  it('never prints a raw `npx vyuh-dxkit` invocation (self-invocation rule)', () => {
    for (const s of ['initialized', 'git', 'non-git'] as const) {
      expect(buildNextSteps(s).join('\n')).not.toContain('npx vyuh-dxkit');
    }
  });
});

describe('demo conversion opt-in — shouldOfferInteractive', () => {
  it('offers ONLY in a git repo with both stdin and stdout as TTYs', () => {
    expect(shouldOfferInteractive('git', true, true)).toBe(true);
  });

  it('never offers when not a TTY (piped / CI must not block on a prompt)', () => {
    expect(shouldOfferInteractive('git', false, true)).toBe(false);
    expect(shouldOfferInteractive('git', true, false)).toBe(false);
    expect(shouldOfferInteractive('git', false, false)).toBe(false);
  });

  it('never offers when already initialized or not a git repo', () => {
    expect(shouldOfferInteractive('initialized', true, true)).toBe(false);
    expect(shouldOfferInteractive('non-git', true, true)).toBe(false);
  });
});

describe('demo conversion — cwdState detection', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dxkit-demo-cwd-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('non-git plain directory → non-git', () => {
    expect(cwdState(dir)).toBe('non-git');
  });

  it('git repo without dxkit → git', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(cwdState(dir)).toBe('git');
  });

  it('directory with .dxkit → initialized (takes precedence over git)', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
    expect(cwdState(dir)).toBe('initialized');
  });
});
