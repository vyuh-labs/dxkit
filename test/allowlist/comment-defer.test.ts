/**
 * The PR-comment defer lane. Pins:
 *   - the STRICT grammar: fingerprints + three known flags, everything else
 *     refused with the token named — including shell-metacharacter and
 *     option-injection shapes (the comment body is untrusted text);
 *   - only the first `/dxkit` line is read; surrounding prose is ignored;
 *   - a comment with no `/dxkit` line is IGNORED (no reply);
 *   - the env-only transport (no argv);
 *   - end-to-end: a well-formed command writes the same deferred entries the
 *     local `allowlist defer` writes (one core), attributed to the commenter,
 *     and the payload carries a postable reply on every handled path;
 *   - the dep-vuln-only restriction survives the lane (a fingerprint the
 *     warmed verdict cache shows as another kind refuses).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import * as path from 'path';
import { parseCommentCommand, runCommentDeferCore } from '../../src/allowlist/comment-defer';
import { writeVerdict, type CachedBlockingFinding } from '../../src/baseline/verdict-cache';
import type { BrownfieldPolicy } from '../../src/baseline/policy';

const FP_A = 'aaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbb';

describe('parseCommentCommand — the strict grammar', () => {
  it('parses fingerprints + flags', () => {
    const out = parseCommentCommand(
      `/dxkit defer ${FP_A} ${FP_B} --expires=+3d --reason="axios batch"`,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.command.fingerprints).toEqual([FP_A, FP_B]);
      expect(out.command.expires).toBe('+3d');
      expect(out.command.reason).toBe('axios batch');
      expect(out.command.fromLastCheck).toBe(false);
    }
  });

  it('parses --new-advisories and a bare reason token', () => {
    const out = parseCommentCommand('/dxkit defer --new-advisories --reason=feed-batch');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.command.fromLastCheck).toBe(true);
      expect(out.command.reason).toBe('feed-batch');
    }
  });

  it('reads only the first /dxkit line; prose around it is ignored', () => {
    const out = parseCommentCommand(
      `These are all from the advisory feed, not this PR.\n\n/dxkit defer ${FP_A}\n\nthanks!`,
    );
    expect(out.ok).toBe(true);
  });

  it('ignores a comment with no /dxkit line at all (no reply)', () => {
    const out = parseCommentCommand('LGTM, merging after CI');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBeNull();
  });

  it('refuses every unrecognized token, naming it — nothing partially executes', () => {
    for (const bad of [
      `/dxkit defer ${FP_A}; rm -rf /`, // shell metachar glued to a fingerprint
      `/dxkit defer $(whoami)`, // command substitution shape
      `/dxkit defer ${FP_A} --mode=sanitized`, // real CLI flag NOT in the comment grammar
      `/dxkit defer ../../etc/passwd`, // path shape
      `/dxkit defer DEADBEEFDEADBEEF`, // uppercase — not a fingerprint
      `/dxkit defer ${FP_A} --added-by=someone-else`, // attribution is never caller-chosen
    ]) {
      const out = parseCommentCommand(bad);
      expect(out.ok, bad).toBe(false);
      if (!out.ok) expect(out.refusal, bad).toBeTruthy();
    }
  });

  it('refuses unknown subcommands and malformed expiries', () => {
    const sub = parseCommentCommand('/dxkit undefer aaaaaaaaaaaaaaaa');
    expect(sub.ok).toBe(false);
    const exp = parseCommentCommand(`/dxkit defer ${FP_A} --expires=whenever`);
    expect(exp.ok).toBe(false);
    const empty = parseCommentCommand('/dxkit defer');
    expect(empty.ok).toBe(false);
  });
});

function mkRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dxkit-comment-defer-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'dev'], { cwd: dir });
  writeFileSync(path.join(dir, 'app.js'), 'const x = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
  return dir;
}

describe('runCommentDeferCore — end to end over the one defer core', () => {
  it('writes deferred entries attributed to the commenter and returns a postable reply', () => {
    const dir = mkRepo();
    try {
      const payload = runCommentDeferCore(dir, {
        DXKIT_COMMENT_BODY: `/dxkit defer ${FP_A} --expires=+7d --reason="feed batch"`,
        DXKIT_COMMENT_AUTHOR: 'reviewer-login',
        DXKIT_COMMENT_PR: '42',
      });
      expect(payload.action).toBe('deferred');
      expect(payload.added).toEqual([FP_A]);
      expect(payload.replyMarkdown).toContain('dxkit-comment-defer');
      expect(payload.replyMarkdown).toContain(FP_A);

      const file = JSON.parse(readFileSync(path.join(dir, '.dxkit', 'allowlist.json'), 'utf8'));
      expect(file.entries).toHaveLength(1);
      expect(file.entries[0]).toMatchObject({
        fingerprint: FP_A,
        kind: 'dep-vuln',
        category: 'deferred',
        addedBy: 'reviewer-login',
        reason: 'feed batch',
      });
      expect(file.entries[0].expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults the reason to an attributable line when none is given', () => {
    const dir = mkRepo();
    try {
      const payload = runCommentDeferCore(dir, {
        DXKIT_COMMENT_BODY: `/dxkit defer ${FP_A}`,
        DXKIT_COMMENT_AUTHOR: 'reviewer-login',
        DXKIT_COMMENT_PR: '42',
      });
      expect(payload.action).toBe('deferred');
      const file = JSON.parse(readFileSync(path.join(dir, '.dxkit', 'allowlist.json'), 'utf8'));
      expect(file.entries[0].reason).toContain('@reviewer-login');
      expect(file.entries[0].reason).toContain('#42');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a refused parse writes NOTHING and still yields a reply', () => {
    const dir = mkRepo();
    try {
      const payload = runCommentDeferCore(dir, {
        DXKIT_COMMENT_BODY: '/dxkit defer $(curl evil)',
        DXKIT_COMMENT_AUTHOR: 'reviewer-login',
      });
      expect(payload.action).toBe('refused');
      expect(payload.replyMarkdown).toContain('refused');
      expect(existsSync(path.join(dir, '.dxkit', 'allowlist.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-/dxkit comment is ignored with an empty reply', () => {
    const dir = mkRepo();
    try {
      const payload = runCommentDeferCore(dir, {
        DXKIT_COMMENT_BODY: 'looks good to me',
        DXKIT_COMMENT_AUTHOR: 'reviewer-login',
      });
      expect(payload.action).toBe('ignored');
      expect(payload.replyMarkdown).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the dep-vuln-only restriction survives the lane: a cached non-dep-vuln kind refuses', () => {
    const dir = mkRepo();
    try {
      const secretFinding: CachedBlockingFinding = {
        fingerprint: FP_A,
        kind: 'secret',
        status: 'added',
        severity: 'critical',
        locator: 'src/config.ts:12',
      };
      writeVerdict(dir, {} as unknown as BrownfieldPolicy, {
        blocks: true,
        warns: false,
        blockingCount: 1,
        unattributableCount: 0,
        warningCount: 0,
        markdown: '## dxkit signals',
        ranAt: '2026-07-25T00:00:00.000Z',
        blockingFindings: [secretFinding],
      });
      const payload = runCommentDeferCore(dir, {
        DXKIT_COMMENT_BODY: `/dxkit defer ${FP_A}`,
        DXKIT_COMMENT_AUTHOR: 'reviewer-login',
      });
      expect(payload.action).toBe('refused');
      expect(payload.replyMarkdown).toContain('dep-vuln-only');
      expect(existsSync(path.join(dir, '.dxkit', 'allowlist.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing commenter identity refuses — attribution is mandatory', () => {
    const dir = mkRepo();
    try {
      const payload = runCommentDeferCore(dir, {
        DXKIT_COMMENT_BODY: `/dxkit defer ${FP_A}`,
      });
      expect(payload.action).toBe('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
