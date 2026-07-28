import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parsePolicyText,
  readPolicyRoot,
  readPolicyObjectSafe,
  readPolicySection,
  policyPathFor,
} from '../../src/baseline/policy-text';
import { mergeIntoPolicyFile, readPolicyFileRaw } from '../../src/baseline/policy-write';
import { resolvePolicy } from '../../src/baseline/policy';

/**
 * The policy file is JSONC and dxkit's own tooling must never destroy what it
 * teaches through: these tests pin the two halves of that promise. Parse side —
 * comments and trailing commas are accepted by the ONE entry point (and by the
 * canonical policy loader through it), and a `//` inside a string is DATA, not
 * a comment (the case every hand-rolled stripper corrupts). Write side —
 * `mergeIntoPolicyFile` preserves the user's comments and formatting on every
 * edit, because a scaffold whose comments die on the first `configure --apply`
 * is worse UX than no comments at all.
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-policy-text-'));
  mkdirSync(join(repo, '.dxkit'), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writePolicy(text: string): void {
  writeFileSync(policyPathFor(repo), text, 'utf8');
}

function policyText(): string {
  return readFileSync(policyPathFor(repo), 'utf8');
}

describe('parsePolicyText', () => {
  it('parses strict JSON unchanged', () => {
    expect(parsePolicyText('{"a": 1, "b": [true, null]}')).toEqual({ a: 1, b: [true, null] });
  });

  it('accepts line comments, block comments, and trailing commas', () => {
    const text = `{
      // the gate posture
      "flow": {
        "mode": "block", /* chosen 2026-07 */
      },
    }`;
    expect(parsePolicyText(text)).toEqual({ flow: { mode: 'block' } });
  });

  it('treats // inside a string as data, never a comment', () => {
    const text = `{"reason": "see https://example.com/docs#anchor"}`;
    expect(parsePolicyText(text)).toEqual({ reason: 'see https://example.com/docs#anchor' });
  });

  it('throws a positional error on malformed input', () => {
    expect(() => parsePolicyText('{ "a": }')).toThrow(/line 1/);
  });
});

describe('readPolicyRoot / readPolicyObjectSafe / readPolicySection', () => {
  it('reports absent for a missing file', () => {
    expect(readPolicyRoot(policyPathFor(repo)).status).toBe('absent');
    expect(readPolicyObjectSafe(repo)).toBeNull();
    expect(readPolicySection(repo, 'flow')).toBeUndefined();
  });

  it('reports malformed for junk and for a non-object root', () => {
    writePolicy('not json at all');
    expect(readPolicyRoot(policyPathFor(repo)).status).toBe('malformed');
    writePolicy('[1, 2]');
    expect(readPolicyRoot(policyPathFor(repo)).status).toBe('malformed');
    expect(readPolicyObjectSafe(repo)).toBeNull();
  });

  it('reads a commented file and exposes sections fail-open', () => {
    writePolicy(`{
      // posture
      "flow": { "mode": "warn" },
      "loop": { "preset": "security-only" },
    }`);
    expect(readPolicySection(repo, 'flow')).toEqual({ mode: 'warn' });
    expect(readPolicySection(repo, 'loop')).toEqual({ preset: 'security-only' });
    expect(readPolicySection(repo, 'absent-section')).toBeUndefined();
  });

  it('returns undefined for a section that is not a plain object', () => {
    writePolicy('{"flow": "block"}');
    expect(readPolicySection(repo, 'flow')).toBeUndefined();
  });
});

describe('resolvePolicy over JSONC', () => {
  it('loads a commented policy file through the canonical loader', () => {
    writePolicy(`{
      // stricter than the preset default
      "blockRules": { "newSecret": true },
    }`);
    const policy = resolvePolicy(undefined, repo);
    expect(policy.blockRules.newSecret).toBe(true);
  });

  it('still refuses a malformed file with a named reason', () => {
    writePolicy('{ nope');
    expect(() => resolvePolicy(undefined, repo)).toThrow(/not valid JSON\/JSONC/);
  });
});

describe('mergeIntoPolicyFile — comment preservation', () => {
  it('preserves comments and formatting when editing a value', () => {
    writePolicy(`{
  // dxkit policy — JSONC, comments welcome
  "flow": {
    "mode": "warn" // start gentle
  },
  "loop": { "preset": "security-only" }
}
`);
    const outcome = mergeIntoPolicyFile(repo, { flow: { mode: 'block' } });
    expect(outcome.changed).toBe(true);
    const text = policyText();
    expect(text).toContain('// dxkit policy — JSONC, comments welcome');
    expect(text).toContain('// start gentle');
    expect(text).toContain('"mode": "block"');
    // sibling sections untouched
    expect(text).toContain('"preset": "security-only"');
  });

  it('adds a new key without disturbing existing comments', () => {
    writePolicy(`{
  // header comment
  "flow": { "mode": "warn" }
}
`);
    const outcome = mergeIntoPolicyFile(repo, { licenses: { prohibited: ['GPL-'] } });
    expect(outcome.changed).toBe(true);
    const text = policyText();
    expect(text).toContain('// header comment');
    expect(parsePolicyText(text)).toEqual({
      flow: { mode: 'warn' },
      licenses: { prohibited: ['GPL-'] },
    });
  });

  it('is idempotent: an unchanged patch leaves the file byte-identical', () => {
    writePolicy(`{
  // note
  "flow": { "mode": "warn" }
}
`);
    const before = policyText();
    const outcome = mergeIntoPolicyFile(repo, { flow: { mode: 'warn' } });
    expect(outcome).toEqual({ changed: false, reason: 'no-change' });
    expect(policyText()).toBe(before);
  });

  it('refuses to touch a malformed file', () => {
    writePolicy('{ broken');
    const outcome = mergeIntoPolicyFile(repo, { flow: { mode: 'block' } });
    expect(outcome).toEqual({ changed: false, reason: 'malformed-policy' });
    expect(policyText()).toBe('{ broken');
  });

  it('creates the file when absent', () => {
    rmSync(join(repo, '.dxkit'), { recursive: true, force: true });
    const outcome = mergeIntoPolicyFile(repo, { flow: { mode: 'warn' } });
    expect(outcome.changed).toBe(true);
    expect(parsePolicyText(policyText())).toEqual({ flow: { mode: 'warn' } });
  });

  it('deep-merges: a nested patch preserves sibling keys AND their comments', () => {
    writePolicy(`{
  "flow": {
    // the served-spec list — hand-curated
    "specs": ["openapi.json"],
    "mode": "warn"
  }
}
`);
    mergeIntoPolicyFile(repo, { flow: { mode: 'block' } });
    const text = policyText();
    expect(text).toContain('// the served-spec list — hand-curated');
    expect(parsePolicyText(text)).toEqual({
      flow: { specs: ['openapi.json'], mode: 'block' },
    });
  });

  it('replaces arrays wholesale (no element merge)', () => {
    writePolicy('{"flow": {"specs": ["a.json", "b.json"]}}\n');
    mergeIntoPolicyFile(repo, { flow: { specs: ['c.json'] } });
    expect(parsePolicyText(policyText())).toEqual({ flow: { specs: ['c.json'] } });
  });

  it('readPolicyFileRaw keeps its contract: {} absent, null malformed, object ok', () => {
    expect(readPolicyFileRaw(repo)).toEqual({});
    writePolicy('{ bad');
    expect(readPolicyFileRaw(repo)).toBeNull();
    writePolicy('{ /* c */ "a": 1 }');
    expect(readPolicyFileRaw(repo)).toEqual({ a: 1 });
  });

  it('round-trips a fully commented scaffold-shaped file through an apply', () => {
    writePolicy(`{
  // ── dxkit policy (JSONC) ──  docs: https://example.com/policy
  "baseline": {
    "mode": "committed-full" // how the guardrail finds its "before"
  },
  // ── Paired-change rules ──  uncomment to activate
  // "pairedChecks": [
  //   { "if": ["src/models/**"], "then": ["migrations/**"] }
  // ],
  "flow": {
    "mode": "warn"
  }
}
`);
    mergeIntoPolicyFile(repo, { flow: { mode: 'block' }, loop: { preset: 'security-only' } });
    const text = policyText();
    // every comment line survives, including the commented-out stanza
    expect(text).toContain('── dxkit policy (JSONC) ──');
    expect(text).toContain('how the guardrail finds its "before"');
    expect(text).toContain('//   { "if": ["src/models/**"], "then": ["migrations/**"] }');
    expect(parsePolicyText(text)).toEqual({
      baseline: { mode: 'committed-full' },
      flow: { mode: 'block' },
      loop: { preset: 'security-only' },
    });
  });
});
