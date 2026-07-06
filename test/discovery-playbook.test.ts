/**
 * The capability-registry playbook — enforcement for CLAUDE.md Rule 16 (the
 * block-if-unregistered discovery gate). Mirror of
 * `managed-artifacts-playbook.test.ts` / `recipe-playbook.test.ts`: the
 * registry in `src/discovery/commands.ts` is the single source of truth for
 * "what capabilities exist and how a user + agent discover them," and this
 * test proves the contract that a command cannot ship undiscoverable.
 *
 * It asserts:
 *   - PARITY: every top-level CLI command is registered, and every registered
 *     token dispatches — bidirectional, robustly parsed (belt-and-suspenders
 *     to the bash Rule 16 in check-architecture.sh, which runs pre-commit);
 *   - COMPLETENESS: every user-facing command carries the metadata the help
 *     index + docs need (group, summary, docsBlurb);
 *   - SKILL EXISTENCE: every referenced skill file actually exists;
 *   - SYNTHETIC INJECTION: the parity check actually bites — inject a fake
 *     unregistered command and assert it is flagged.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  COMMANDS,
  allCommandTokens,
  getCommand,
  userCommands,
  suggestCommand,
  renderCommandIndex,
  type CapabilityDescriptor,
} from '../src/discovery/commands';

const REPO_ROOT = path.join(__dirname, '..');

/** Parse the top-level `switch (command)` cases out of src/cli.ts. */
function cliCommandCases(): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli.ts'), 'utf-8');
  const re = /^ {4}case '([a-z][a-z-]*)':/gm;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return [...out].sort();
}

describe('capability registry — Rule 16 parity (block-if-unregistered)', () => {
  it('every top-level CLI command is registered (id or alias)', () => {
    const cases = cliCommandCases();
    const tokens = new Set(allCommandTokens());
    const unregistered = cases.filter((c) => !tokens.has(c));
    expect(unregistered, `unregistered CLI commands: ${unregistered.join(', ')}`).toEqual([]);
  });

  it('every registered token dispatches to a real CLI case (no orphans)', () => {
    const cases = new Set(cliCommandCases());
    const orphans = allCommandTokens().filter((t) => !cases.has(t));
    expect(orphans, `registry tokens with no dispatch: ${orphans.join(', ')}`).toEqual([]);
  });

  it('SYNTHETIC INJECTION: the parity check flags an unregistered command', () => {
    // Prove the gate bites: a fake command absent from the registry must be
    // detected. If this ever passes silently, the parity check has gone blind.
    const casesWithFake = [...cliCommandCases(), 'synthetic-unregistered-cmd'];
    const tokens = new Set(allCommandTokens());
    const unregistered = casesWithFake.filter((c) => !tokens.has(c));
    expect(unregistered).toContain('synthetic-unregistered-cmd');
  });
});

describe('capability registry — descriptor completeness', () => {
  it('every user-facing command has group + summary + docsBlurb', () => {
    for (const c of userCommands()) {
      expect(c.group, `${c.id}: group`).toBeTruthy();
      expect(c.summary.trim().length, `${c.id}: summary`).toBeGreaterThan(0);
      expect(c.docsBlurb?.trim().length ?? 0, `${c.id}: docsBlurb`).toBeGreaterThan(0);
    }
  });

  it('every referenced skill file exists under .claude/skills/', () => {
    for (const c of COMMANDS as readonly CapabilityDescriptor[]) {
      if (!c.skill) continue;
      const skillFile = path.join(
        REPO_ROOT,
        'src-templates',
        '.claude',
        'skills',
        c.skill,
        'SKILL.md',
      );
      expect(fs.existsSync(skillFile), `${c.id}: skill '${c.skill}' has no SKILL.md`).toBe(true);
    }
  });

  it('ids are unique; aliases never collide with an id or another alias', () => {
    const seen = new Set<string>();
    for (const t of allCommandTokens()) {
      expect(seen.has(t), `duplicate command token: ${t}`).toBe(false);
      seen.add(t);
    }
  });

  it('internal commands are registered but exempt from user-facing metadata', () => {
    const internal = (COMMANDS as readonly CapabilityDescriptor[]).filter(
      (c) => c.audience === 'internal',
    );
    // The exemption is the point: internal commands need only id + summary,
    // proving "everything registered, nothing hidden" without forcing a
    // whenToRecommend probe / docsBlurb on a machine-invoked hook body.
    expect(internal.length).toBeGreaterThan(0);
    for (const c of internal) expect(c.summary.trim().length).toBeGreaterThan(0);
  });
});

describe('capability registry — lookup + discovery helpers', () => {
  it('getCommand resolves ids and aliases', () => {
    expect(getCommand('vulnerabilities')?.id).toBe('vulnerabilities');
    expect(getCommand('vuln')?.id).toBe('vulnerabilities');
    expect(getCommand('protect')?.id).toBe('setup-branch-protection');
    expect(getCommand('nope')).toBeUndefined();
  });

  it('suggestCommand offers a near match for a typo', () => {
    expect(suggestCommand('guard')).toContain('guardrail');
    expect(suggestCommand('vulnz')).toContain('vulnerabilities');
    expect(suggestCommand('')).toEqual([]);
  });

  it('renderCommandIndex lists every user-facing command', () => {
    const text = renderCommandIndex().join('\n');
    for (const c of userCommands()) {
      expect(text, `help index missing ${c.id}`).toContain(c.id);
    }
  });
});
