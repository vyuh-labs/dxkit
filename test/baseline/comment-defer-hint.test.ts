/**
 * The PR-comment defer hint: when the guardrail comment shows blocking
 * dependency advisories AND the repo has the `/dxkit defer` comment workflow
 * installed, the comment itself says the exact reply that defers them —
 * fingerprints filled in, copy-paste ready.
 *
 * Both directions matter. The hint must appear at the one moment it helps (a
 * reviewer staring at a blocked PR), and must NOT appear anywhere else: not
 * on repos without the workflow (a dead hint teaches commands that do
 * nothing), not for non-dep-vuln blocks (the comment lane deliberately
 * defers dependency advisories only — never a secret or code finding), and
 * not as an inventory (fingerprint list capped; the table above has them all).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck, type ClassifiedPair } from '../../src/baseline/check';
import { markdownCommentDeferHint, renderMarkdown } from '../../src/baseline/check-renderers';
import { trustedLocalContext } from '../../src/analysis-trust';

function blockingPair(kind: string, fp: string): ClassifiedPair {
  return {
    pair: { currentId: fp, status: 'added', confidence: 1, reasons: [] },
    classification: { status: 'added', blocks: true, warns: false, reasons: [] },
    kind: kind as ClassifiedPair['kind'],
    severity: 'high',
  };
}

const FP_A = 'aaaa111122223333';
const FP_B = 'bbbb444455556666';

describe('markdownCommentDeferHint (unit)', () => {
  it('prints the copy-pasteable reply with real fingerprints and the bulk form', () => {
    const lines = markdownCommentDeferHint({ commentDeferInstalled: true }, [
      blockingPair('dep-vuln', FP_A),
      blockingPair('dep-vuln', FP_B),
    ]);
    const hint = lines.join('\n');
    expect(hint).toContain(`/dxkit defer ${FP_A} ${FP_B} --reason="…"`);
    expect(hint).toContain('/dxkit defer --new-advisories');
    expect(hint).toContain('Dependency advisories only');
  });

  it('is silent without the workflow — a dead hint teaches commands that do nothing', () => {
    expect(markdownCommentDeferHint({}, [blockingPair('dep-vuln', FP_A)])).toEqual([]);
  });

  it('is silent when the blocks are not dependency advisories (the lane never allowlists those)', () => {
    expect(
      markdownCommentDeferHint({ commentDeferInstalled: true }, [
        blockingPair('secret', FP_A),
        blockingPair('code', FP_B),
      ]),
    ).toEqual([]);
  });

  it('caps the spelled-out fingerprints and points at the table for the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      blockingPair('dep-vuln', `${String(i).padStart(4, '0')}aaaabbbbcccc`),
    );
    const hint = markdownCommentDeferHint({ commentDeferInstalled: true }, many).join('\n');
    expect(hint).toContain('0007aaaabbbbcccc');
    expect(hint).not.toContain('0008aaaabbbbcccc');
    expect(hint).toContain('first 8 of 12');
    expect(hint).toContain('table above');
  });
});

describe('the check detects the workflow and the comment renders the hint (integration)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-defer-hint-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flag absent without the workflow; present with it; hint fires only on blocking dep-vulns', async () => {
    await createBaseline({ cwd: dir });
    const without = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });
    expect(without.commentDeferInstalled).toBeUndefined();
    expect(renderMarkdown(without)).not.toContain('/dxkit defer');

    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'dxkit-comment-defer.yml'), 'name: stub\n');
    const withIt = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });
    expect(withIt.commentDeferInstalled).toBe(true);
    // Installed but nothing blocking → still silent.
    expect(renderMarkdown(withIt)).not.toContain('Defer from this conversation');

    // A blocking dependency advisory appears → the comment carries the reply.
    const blocked = {
      ...withIt,
      blocks: true,
      pairs: [...withIt.pairs, blockingPair('dep-vuln', FP_A)],
    };
    const md = renderMarkdown(blocked);
    expect(md).toContain('Defer from this conversation');
    expect(md).toContain(`/dxkit defer ${FP_A} --reason="…"`);
  }, 240_000);
});
