/**
 * Lane-template TOKEN parity — the net for the per-template-drift class: the
 * dep-bump template exported GH_TOKEN while the baseline-refresh template did
 * not, so the refresh's gh calls (expiry-notice issue, advisory decision PR)
 * ran unauthenticated and failed silently for a full horizon. Templates are
 * hand-maintained files with no compiler; parity lives here.
 *
 * Two invariants over EVERY workflow template:
 *   1. any step that shells `gh` — directly or through a gh-shelling dxkit
 *      lane command — carries GH_TOKEN in its env;
 *   2. the PR-opening lane templates route their push credential + GH_TOKEN
 *      through the optional DXKIT_BOT_TOKEN (falling back to github.token),
 *      because a branch pushed with the default token never triggers workflow
 *      runs and the lane's PRs would show no checks.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WORKFLOWS = path.join(__dirname, '..', 'src-templates', '.github', 'workflows');

/** dxkit lane subcommands that shell `gh` internally (PR/issue creation). A
 *  template invoking one of these needs GH_TOKEN exactly like a literal `gh`
 *  call. Test-side list, updated when a lane gains gh calls — the assertion
 *  below fails loudly when a NEW template ships a bare `gh` either way. */
const GH_SHELLING_COMMANDS = [
  'baseline refresh',
  'deps bump',
  'remediate configured',
  'remediate --task',
];

interface Step {
  readonly file: string;
  readonly header: string;
  readonly body: string;
}

/** Split a workflow template into step blocks (6-space `- name:` / `- uses:`
 *  items). Regex-based on purpose: the templates carry `__DXKIT_*__`
 *  placeholders that break YAML parsers. */
function stepsOf(file: string, content: string): Step[] {
  const out: Step[] = [];
  const re = /\n {6}- (?:name|uses):[^\n]*/g;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : content.length;
    const block = content.slice(from, to);
    out.push({ file, header: block.split('\n')[1] ?? '', body: block });
  }
  return out;
}

function templates(): Array<{ file: string; content: string }> {
  return fs
    .readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml'))
    .map((file) => ({ file, content: fs.readFileSync(path.join(WORKFLOWS, file), 'utf8') }));
}

function shellsGh(step: Step): boolean {
  // A literal gh invocation in a run block, or a gh-shelling lane command.
  if (/\bgh (api|pr|issue|repo|run|workflow)\b/.test(step.body)) return true;
  return GH_SHELLING_COMMANDS.some((c) => step.body.includes(c));
}

describe('workflow-template token parity', () => {
  it('every gh-shelling step in every template carries GH_TOKEN', () => {
    const offenders: string[] = [];
    for (const { file, content } of templates()) {
      for (const step of stepsOf(file, content)) {
        if (!shellsGh(step)) continue;
        if (!step.body.includes('GH_TOKEN')) {
          offenders.push(`${file}: ${step.header.trim() || '(unnamed step)'}`);
        }
      }
    }
    expect(
      offenders,
      `steps shelling gh without GH_TOKEN (unauthenticated gh fails silently in CI):\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('PR-opening lane templates route credentials through the ONE three-tier token chain (4.4.1 WP7)', () => {
    const PR_LANES = ['dxkit-dep-bump.yml', 'dxkit-remediate.yml', 'dxkit-baseline-refresh.yml'];
    const TIER_CHAIN =
      'steps.dxkit-app-token.outputs.token || secrets.DXKIT_BOT_TOKEN || github.token';
    for (const file of PR_LANES) {
      const content = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
      // Tier 1: the App mint step, gated on the DXKIT_APP_ID VARIABLE
      // (secrets cannot gate an `if:`), pinned action version.
      expect(content, `${file} must mint the App token when configured`).toContain(
        'actions/create-github-app-token@v2',
      );
      expect(content, `${file} must gate the mint on the App variable`).toContain(
        "if: ${{ vars.DXKIT_APP_ID != '' }}",
      );
      // Tiers 1→2→3 in one expression — App token, then PAT, then default.
      expect(content, `${file} must use the three-tier token chain`).toContain(TIER_CHAIN);
      // The degraded default is disclosed, not silent — and the notice
      // names the App tier as the preferred remedy.
      expect(content, `${file} must disclose the default-token degradation`).toContain(
        'DXKIT_BOT_TOKEN_SET',
      );
      expect(content, `${file} degraded-mode notice must name the App remedy`).toContain(
        'DXKIT_APP_ID variable',
      );
    }
  });

  it('the remediate lane re-mints before the task and refreshes the landing credential (App-token 1h cap)', () => {
    // App INSTALLATION tokens are hard-capped at one hour by GitHub. Only
    // the remediate lane runs long enough to outlive one (an agent budget
    // plus setup); dep-bump and baseline-refresh are minutes-long jobs and
    // deliberately keep the single top-of-job mint.
    const content = fs.readFileSync(path.join(WORKFLOWS, 'dxkit-remediate.yml'), 'utf8');
    // A fresh mint gated on the same App variable, immediately before the
    // task step — the hour starts at agent launch, not at job start.
    expect(content).toContain('id: dxkit-app-token-task');
    // The checkout persisted the FIRST mint as the git credential (what the
    // landing push authenticates with); it must be REWRITTEN with the fresh
    // token, in the same extraheader shape actions/checkout writes.
    expect(content).toContain('http.https://github.com/.extraheader');
    // The task step's gh credential prefers the fresh token, keeping the
    // full four-tier fallback.
    expect(content).toContain(
      'steps.dxkit-app-token-task.outputs.token || steps.dxkit-app-token.outputs.token',
    );
    // The CLI learns the tier so it can clamp the wall clock to the token
    // lifetime (disclosed in the envelope, never silent).
    expect(content).toContain('DXKIT_TOKEN_MODE');
    // Ordering: agent-CLI install → re-mint → credential refresh → task, so
    // setup time cannot eat the token's hour.
    const install = content.indexOf('Install the agent CLI');
    const remint = content.indexOf('id: dxkit-app-token-task');
    const refresh = content.indexOf('Refresh the landing credential');
    const task = content.indexOf('Run task ${{ matrix.task }}');
    expect(install).toBeGreaterThan(-1);
    expect(remint).toBeGreaterThan(install);
    expect(refresh).toBeGreaterThan(remint);
    expect(task).toBeGreaterThan(refresh);
  });
});
