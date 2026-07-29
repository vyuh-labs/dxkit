import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computePolicySync, applyPolicySync } from '../src/policy-sync';
import { renderPolicyScaffold } from '../src/baseline/policy-template';
import { parsePolicyText } from '../src/baseline/policy-text';
import type { ScaffoldCtx } from '../src/baseline/policy-metadata';

/**
 * `policy sync` is how a hand-evolved policy adopts knobs that shipped later:
 * these tests pin its non-clobber contract. Presence is detected THREE ways
 * (active key, commented stanza, ignore marker) so sync never re-teaches what
 * the file already knows or the user deliberately deleted; the append touches
 * nothing above it (byte-compared); and the appended file always parses —
 * sync refuses rather than break a policy.
 */

const CTX: ScaffoldCtx = { packIds: ['typescript'], lintCapable: true };

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-policy-sync-'));
  mkdirSync(join(repo, '.dxkit'), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const policyFile = () => join(repo, '.dxkit', 'policy.json');
const writePolicy = (text: string) => writeFileSync(policyFile(), text, 'utf8');

describe('computePolicySync', () => {
  it('reports every applicable stanza missing for a minimal hand-written policy', () => {
    writePolicy('{"baseline": {"mode": "committed-full"}}\n');
    const plan = computePolicySync(repo, CTX);
    expect(plan.status).toBe('ok');
    const keys = plan.missing.map((s) => s.key);
    expect(keys).toContain('flow');
    expect(keys).toContain('pairedChecks');
    expect(keys).not.toContain('baseline'); // active
  });

  it('counts a COMMENTED stanza as present (a scaffolded file needs no sync)', () => {
    writePolicy(renderPolicyScaffold({ active: {}, ctx: CTX, version: '4.3.0-test' }));
    const plan = computePolicySync(repo, CTX);
    expect(plan.status).toBe('ok');
    expect(plan.missing).toEqual([]);
    expect(plan.scaffoldedBy).toBe('4.3.0-test');
  });

  it('honors the ignore marker for a deliberately deleted stanza', () => {
    writePolicy(`{
  // dxkit-policy-sync: ignore pairedChecks
  "baseline": { "mode": "committed-full" }
}
`);
    const plan = computePolicySync(repo, CTX);
    expect(plan.ignored).toEqual(['pairedChecks']);
    expect(plan.missing.map((s) => s.key)).not.toContain('pairedChecks');
    expect(plan.missing.map((s) => s.key)).toContain('flow');
  });

  it('refuses a malformed file with the reason', () => {
    writePolicy('{ broken');
    const plan = computePolicySync(repo, CTX);
    expect(plan.status).toBe('malformed');
    expect(plan.error).toBeTruthy();
    expect(plan.missing).toEqual([]);
  });
});

describe('applyPolicySync', () => {
  it('appends only the missing stanzas; above the append, the ONLY byte change is the terminating comma', () => {
    const original = `{
  // my hand-written policy, with my own notes
  "baseline": {
    "mode": "committed-full" // pinned after the visibility incident
  },
  "flow": { "mode": "block" }
}
`;
    writePolicy(original);
    const plan = computePolicySync(repo, CTX);
    const { written } = applyPolicySync(repo, plan, CTX, '4.3.0-test');
    expect(written).toBe(true);

    const after = readFileSync(policyFile(), 'utf8');
    // everything before the append is byte-identical EXCEPT the one comma
    // sync adds after the last member, so a later uncomment still parses
    const codeEnd = original.lastIndexOf('"block" }') + '"block" }'.length;
    expect(after.startsWith(original.slice(0, codeEnd) + ',')).toBe(true);
    expect(after).toContain('// my hand-written policy, with my own notes');
    expect(after).toContain('// pinned after the visibility incident');
    // appended stanzas are commented and the file still parses
    expect(after).toContain('// ── Paired-change rules');
    expect(parsePolicyText(after)).toMatchObject({
      baseline: { mode: 'committed-full' },
      flow: { mode: 'block' },
    });
  });

  it('is idempotent: a second sync finds nothing missing', () => {
    writePolicy('{"baseline": {"mode": "committed-full"}}\n');
    applyPolicySync(repo, computePolicySync(repo, CTX), CTX, '4.3.0-test');
    const second = computePolicySync(repo, CTX);
    expect(second.missing).toEqual([]);
  });

  it('writes a full scaffold when no policy exists (create-only)', () => {
    rmSync(join(repo, '.dxkit'), { recursive: true, force: true });
    const plan = computePolicySync(repo, CTX);
    expect(plan.status).toBe('absent');
    const { created } = applyPolicySync(repo, plan, CTX, '4.3.0-test');
    expect(created).toBe(true);
    expect(existsSync(policyFile())).toBe(true);
    expect(parsePolicyText(readFileSync(policyFile(), 'utf8'))).toBeTruthy();
  });

  it('activation works after sync onto a strict-JSON policy with NO trailing comma (the real-repo class)', () => {
    // A hand-written policy ends its last member without a trailing comma;
    // sync must leave the file so that uncommenting an appended stanza still
    // parses — mirror validation caught exactly this on a customer-shaped repo.
    writePolicy(`{
  "baseline": {
    "mode": "committed-full"
  },
  "schema": {
    "mode": "warn" // their own trailing comment, with a URL: https://x.test/a
  }
}
`);
    applyPolicySync(repo, computePolicySync(repo, CTX), CTX, '4.3.0-test');
    const synced = readFileSync(policyFile(), 'utf8');
    // uncomment the first appended stanza exactly as a user would
    const lines = synced.split('\n');
    let depth = 0;
    let started = false;
    const uncommented = lines
      .map((l) => {
        const m = /^(\s*)\/\/ (\s*["{}[\]].*)$/.exec(l);
        if (!started && m && /^"pairedChecks":/.test(m[2].trim())) {
          started = true;
          depth = (m[2].match(/[{[]/g) ?? []).length - (m[2].match(/[}\]]/g) ?? []).length;
          return m[1] + m[2];
        }
        if (started && depth > 0 && m) {
          depth += (m[2].match(/[{[]/g) ?? []).length - (m[2].match(/[}\]]/g) ?? []).length;
          return m[1] + m[2];
        }
        return l;
      })
      .join('\n');
    const parsed = parsePolicyText(uncommented) as Record<string, unknown>;
    expect(parsed.pairedChecks).toBeDefined();
    expect(parsed).toMatchObject({
      baseline: { mode: 'committed-full' },
      schema: { mode: 'warn' },
    });
  });

  it('finds the ROOT close by token, not lastIndexOf: a trailing comment containing } is handled', () => {
    // The mirror-validation follow-up class: the last '}' in the FILE lives
    // inside a comment; the append must target the real root close and
    // succeed — and any unexpected failure must be a clean refusal, never a
    // crash.
    writePolicy(`{
  "baseline": { "mode": "committed-full" }
}
// reviewed by ops { done }
`);
    const { written } = applyPolicySync(repo, computePolicySync(repo, CTX), CTX, '4.3.0-test');
    expect(written).toBe(true);
    const after = readFileSync(policyFile(), 'utf8');
    expect(after).toContain('// reviewed by ops { done }');
    expect(after).toContain('// ── Paired-change rules');
    expect(parsePolicyText(after)).toMatchObject({ baseline: { mode: 'committed-full' } });
  });

  it('never writes to a malformed file', () => {
    writePolicy('{ broken');
    const plan = computePolicySync(repo, CTX);
    const { written } = applyPolicySync(repo, plan, CTX, '4.3.0-test');
    expect(written).toBe(false);
    expect(readFileSync(policyFile(), 'utf8')).toBe('{ broken');
  });
});
