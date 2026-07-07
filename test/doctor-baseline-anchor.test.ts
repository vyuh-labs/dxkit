/**
 * Doctor's committed-baseline anchoring advisory (#118). A committed baseline
 * is anchored to the default branch (its refresh runs only on push to it), so a
 * gitflow repo — where PRs commonly target a long-lived non-default branch — is
 * surfaced a note: the CI guardrail auto-gates those PRs ref-based, but pinning
 * ref-based keeps the LOCAL guardrail agreeing. The note is informational (never
 * fails doctor) and only appears when a `develop`/`dev`/`release/*` branch is
 * actually present.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDoctor } from '../src/doctor';

const tmps: string[] = [];
function mkRepo(remoteBranches: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-anchor-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  fs.writeFileSync(path.join(d, 'f.txt'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: d });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
  // Synthesize remote-tracking refs so `git branch -r` sees them without a
  // real remote. origin/main is the default; the rest are the test's shape.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', sha], { cwd: d });
  for (const b of remoteBranches) {
    execFileSync('git', ['update-ref', `refs/remotes/origin/${b}`, sha], { cwd: d });
  }
  // A manifest makes doctor run the operational (baseline) checks.
  fs.writeFileSync(
    path.join(d, '.vyuh-dxkit.json'),
    JSON.stringify({ version: '3.0.0', files: [] }),
  );
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const anchorNote = (labels: string[]) =>
  labels.find((l) => l.includes('default-branch-anchored') && l.includes('ref-based'));

describe('doctor — committed baseline anchoring advisory (#118)', () => {
  it('surfaces the note when a gitflow branch (develop) exists', async () => {
    const report = await runDoctor(mkRepo(['develop']), { json: true });
    const note = anchorNote(report.checks.map((c) => c.label));
    expect(note).toBeDefined();
    expect(note).toContain("'develop'");
    // Informational — it does not fail doctor.
    const check = report.checks.find((c) => c.label === note);
    expect(check?.ok).toBe(true);
  });

  it('stays silent on a single-trunk repo (no long-lived non-default branch)', async () => {
    const report = await runDoctor(mkRepo(['feature/x']), { json: true });
    expect(anchorNote(report.checks.map((c) => c.label))).toBeUndefined();
  });
});
