/**
 * Lane-template TOKEN discipline — the net for the per-template-drift class.
 *
 * History, because this net's SHAPE is the lesson: the dep-bump template
 * exported GH_TOKEN while baseline-refresh did not (4.3.6 defect B); then
 * 4.4.1 gave three hand-picked templates the three-tier token chain while
 * the baseline-refresh -branch/-cache variants, comment-defer's push to the
 * PR branch, and the flow/extensions standing-PR lanes silently stayed on
 * the default token (dxkit #323). Both times the root cause was the same:
 * the invariant lived in a hand-maintained filename list, and files not on
 * the list drifted.
 *
 * The 4.4.2 root fix this file pins:
 *   - the chain text exists ONCE (src/lanes/lane-token.ts); templates carry
 *     placeholders; the ONE workflow writer substitutes them unconditionally;
 *   - membership is derived from template CONTENT (does it shell gh, push,
 *     or open PRs?), never from a filename list; deliberate non-members are
 *     DECLARED exemptions with reasons (the DEFERRED_KINDS discipline);
 *   - every template also renders + parses as YAML with the real
 *     substitutions applied, so an indentation break in the shared block or
 *     a template cannot ship.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  LANE_TOKEN_APP_ID_VARIABLE_NAME,
  LANE_TOKEN_APP_KEY_SECRET_NAME,
  LANE_TOKEN_CHAIN,
  LANE_TOKEN_PAT_SECRET_NAME,
  LANE_TOKEN_STEPS,
  LANE_TOKEN_SUBSTITUTIONS,
  LANE_TOKEN_TASK_STEPS,
} from '../src/lanes/lane-token';
import { INSTALL_DEPS_PLACEHOLDER, renderInstallDependenciesShell } from '../src/package-manager';

const WORKFLOWS = path.join(__dirname, '..', 'src-templates', '.github', 'workflows');

/**
 * Templates that interact with GitHub write surfaces but DELIBERATELY stay
 * on the default token. An entry here is a declared decision with a reason,
 * never an omission — a new template with write-shaped content must either
 * carry the chain or add itself here with a defensible reason.
 */
const CHAIN_EXEMPT: Readonly<Record<string, string>> = {
  'dxkit-guardrails.yml':
    'posts a PR comment only — commenting works with the default token and ' +
    'triggers nothing; the guardrail check itself is the PR run',
  'dxkit-deep-sast-refresh.yml':
    'direct snapshot commit with the CI-skip marker, no PRs or issues — ' +
    'nothing downstream needs triggering',
  'dxkit-graph-refresh.yml':
    'side-branch artifact push only, no PRs or issues — nothing downstream ' + 'needs triggering',
  'dxkit-reports-refresh.yml':
    'side-branch artifact push only, no PRs or issues — nothing downstream ' + 'needs triggering',
};

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
 *  items). Regex-based on purpose: the raw templates carry `__DXKIT_*__`
 *  placeholders that break YAML parsers (the render test below parses the
 *  substituted form instead). */
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

function shellsGh(body: string): boolean {
  // A literal gh invocation in a run block, or a gh-shelling lane command.
  if (/\bgh (api|pr|issue|repo|run|workflow)\b/.test(body)) return true;
  return GH_SHELLING_COMMANDS.some((c) => body.includes(c));
}

/**
 * Does this template touch a GitHub WRITE surface that the token tier
 * matters for — creating PRs/issues, or pushing commits? (A push with the
 * default token never triggers workflow runs, so a pushed PR branch shows
 * no checks and a pushed defer commit never re-greens its PR.) Pure over
 * content so the synthetic-injection test below can prove it bites.
 */
export function needsTokenChain(content: string): boolean {
  if (/\bgh (pr|issue) create\b/.test(content)) return true;
  if (/\bgit push\b/.test(content)) return true;
  // Lane CLI commands that open/update PRs internally.
  if (GH_SHELLING_COMMANDS.some((c) => content.includes(c))) return true;
  // The CLI-driven standing-PR lanes document themselves with this phrase;
  // the structural signals above already catch them (git push / gh), this
  // is belt-and-braces for a lane whose push happens inside the CLI.
  if (content.includes('--land pr') || content.includes('opens the standing PR')) return true;
  return false;
}

/** Apply the REAL lane-token substitutions (the ones installWorkflow uses),
 *  then neutralize the caller-supplied placeholders with dummies so the
 *  result is plain YAML. */
function renderForParse(content: string): string {
  let out = content;
  for (const [key, value] of Object.entries(LANE_TOKEN_SUBSTITUTIONS)) {
    out = out.split(key).join(value);
  }
  // The dependency-install block renders unconditionally too (4.4.5), so the
  // parse below sees the real multi-line shell body at the `run: |` indent.
  out = out
    .split(`          ${INSTALL_DEPS_PLACEHOLDER}`)
    .join(renderInstallDependenciesShell('          '));
  // Whole-line placeholders (multi-line slots: runtime setup, fragment jobs)
  // vanish; inline placeholders become inert identifiers.
  out = out.replace(/^__DXKIT_[A-Z_]+__$/gm, '');
  out = out.replace(/__DXKIT_[A-Z_]+__/g, 'dxkit-placeholder');
  return out;
}

describe('workflow-template token discipline', () => {
  it('every gh-shelling step in every template carries GH_TOKEN', () => {
    const offenders: string[] = [];
    for (const { file, content } of templates()) {
      for (const step of stepsOf(file, content)) {
        if (!shellsGh(step.body)) continue;
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

  it('membership is content-derived: every write-surface template carries the chain or a declared exemption', () => {
    const missing: string[] = [];
    for (const { file, content } of templates()) {
      if (!needsTokenChain(content)) continue;
      if (file in CHAIN_EXEMPT) continue;
      if (!content.includes('__DXKIT_LANE_TOKEN_STEPS__')) {
        missing.push(`${file}: creates PRs/issues or pushes, but carries no lane-token steps`);
      }
    }
    expect(
      missing,
      `write-surface templates off the token chain (the #323 class):\n${missing.join('\n')}\n` +
        `Either add __DXKIT_LANE_TOKEN_STEPS__ + __DXKIT_LANE_TOKEN__ or declare a ` +
        `CHAIN_EXEMPT entry with a reason.`,
    ).toEqual([]);
  });

  it('exemptions are honest: every declared exemption exists and would otherwise be a member', () => {
    for (const [file, reason] of Object.entries(CHAIN_EXEMPT)) {
      expect(reason.length, `${file} exemption needs a real reason`).toBeGreaterThan(20);
      const abs = path.join(WORKFLOWS, file);
      expect(fs.existsSync(abs), `${file} is exempt but does not exist — prune the entry`).toBe(
        true,
      );
    }
  });

  it('chain-carrying templates hold NO hand-copied token machinery (one definition)', () => {
    const offenders: string[] = [];
    for (const { file, content } of templates()) {
      if (!content.includes('__DXKIT_LANE_TOKEN_STEPS__')) continue;
      // The chain text and the mint action come only from the substitution.
      // The one allowed inline mint is remediate's task-time RE-mint (its
      // one-hour-lifetime fix), identified by its distinct step id.
      const inlineMints = content.split('create-github-app-token').length - 1;
      const allowedRemint = content.includes('id: dxkit-app-token-task') ? 1 : 0;
      if (inlineMints > allowedRemint) {
        offenders.push(`${file}: hand-copied mint step (use __DXKIT_LANE_TOKEN_STEPS__)`);
      }
      if (content.includes(LANE_TOKEN_CHAIN)) {
        offenders.push(`${file}: literal chain text (use __DXKIT_LANE_TOKEN__)`);
      }
      // No credential may bypass the chain back to the default token.
      if (/(?:GH_TOKEN|token):\s*\$\{\{\s*github\.token\s*\}\}/.test(content)) {
        offenders.push(`${file}: a credential pinned to github.token beside the chain`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every template renders to valid YAML with the real substitutions (no residue)', () => {
    for (const { file, content } of templates()) {
      const rendered = renderForParse(content);
      expect(rendered, `${file}: unsubstituted lane-token residue`).not.toContain(
        '__DXKIT_LANE_TOKEN',
      );
      expect(() => yaml.load(rendered), `${file}: rendered template is not valid YAML`).not.toThrow(
        undefined,
      );
      if (content.includes('__DXKIT_LANE_TOKEN_STEPS__')) {
        expect(rendered, `${file}: mint step missing after render`).toContain(
          'actions/create-github-app-token@v2',
        );
        expect(rendered, `${file}: tier disclosure missing after render`).toContain(
          'Disclose token mode',
        );
        expect(rendered, `${file}: chain missing after render`).toContain(LANE_TOKEN_CHAIN);
      }
    }
  });

  it('the shared steps block is itself well-formed at template indentation', () => {
    // Parsed standalone under a steps: key, exactly as it lands in a job.
    const doc = `jobs:\n  j:\n    steps:\n${LANE_TOKEN_STEPS}\n`;
    expect(() => yaml.load(doc)).not.toThrow();
    const parsed = yaml.load(doc) as {
      jobs: { j: { steps: Array<Record<string, unknown>> } };
    };
    expect(parsed.jobs.j.steps).toHaveLength(2);
    expect(parsed.jobs.j.steps[0].id).toBe('dxkit-app-token');
  });

  it('SYNTHETIC INJECTION: the content-derived membership check bites', () => {
    // A hypothetical new lane that opens a PR with no chain — the exact
    // shape that drifted twice. If needsTokenChain stops seeing it, this
    // net has gone blind.
    const offender = [
      'name: dxkit synthetic lane',
      'jobs:',
      '  go:',
      '    steps:',
      '      - name: Open the PR',
      '        env:',
      '          GH_TOKEN: ${{ github.token }}',
      '        run: gh pr create --title x --body y',
    ].join('\n');
    expect(needsTokenChain(offender)).toBe(true);
    expect(offender.includes('__DXKIT_LANE_TOKEN_STEPS__')).toBe(false);
    // And a genuinely read-only template stays a non-member.
    const readOnly = 'name: x\njobs:\n  a:\n    steps:\n      - run: gh api /rate_limit\n';
    expect(needsTokenChain(readOnly)).toBe(false);
  });

  it('the remediate lane re-mints before the task and refreshes the landing credential (App-token 1h cap)', () => {
    // App INSTALLATION tokens are hard-capped at one hour by GitHub. Only
    // the remediate lane runs long enough to outlive one (an agent budget
    // plus setup); the other lanes are minutes-long jobs and deliberately
    // keep the single top-of-job mint.
    const content = fs.readFileSync(path.join(WORKFLOWS, 'dxkit-remediate.yml'), 'utf8');
    // A fresh mint gated on the same App variable, immediately before the
    // task step (the hour starts at agent launch, not at job start). The
    // step arrives via the __DXKIT_LANE_TOKEN_TASK_STEPS__ placeholder
    // (the raw template holds no hand-copied mint), so assert on the
    // RENDERED content.
    expect(content).toContain('__DXKIT_LANE_TOKEN_TASK_STEPS__');
    expect(renderForParse(content)).toContain('id: dxkit-app-token-task');
    // ONE credential writer (the live 4.4.3 class): checkout v6 persists
    // its credential where `git config --unset-all` cannot reliably reach,
    // and a second Authorization source makes GitHub 400 the landing push
    // ("Duplicate header"). So the task job's checkout persists NOTHING,
    // and the tier-generic install step is the only writer — defensive
    // unsets, a count assertion, and an ls-remote PROOF at $0, before any
    // agent spend, on every tier (not only the App).
    expect(content).toContain('persist-credentials: false');
    // A working credential right after checkout (setup-phase git needs —
    // a private git-pinned dependency installs before the landing step),
    // then the landing credential with the FRESH task token replacing it.
    expect(content).toContain('- name: Install the working credential');
    expect(content).toContain('DXKIT_LANE_TOKEN: __DXKIT_LANE_TOKEN__');
    expect(content).toContain('- name: Install the landing credential');
    expect(content).toContain('DXKIT_LANE_TOKEN: __DXKIT_LANE_TOKEN_TASK__');
    const checkoutIdx = content.indexOf('persist-credentials: false');
    const workingIdx = content.indexOf('- name: Install the working credential');
    // The plan job has its own earlier install step; the ordering that
    // matters is inside the TASKS job, so search from the working step on.
    const depsIdx = content.indexOf('- name: Install dependencies + dxkit', workingIdx);
    expect(workingIdx).toBeGreaterThan(checkoutIdx);
    expect(depsIdx).toBeGreaterThan(workingIdx);
    expect(content).toContain('http.https://github.com/.extraheader');
    expect(content).toContain('--unset-all http.https://github.com/.extraheader');
    expect(content).toContain('git ls-remote --heads origin');
    expect(content).toContain('expected exactly 1 auth header config');
    // The task step's gh credential prefers the fresh token (the _TASK
    // placeholder), and the CLI learns the tier so it can clamp the wall
    // clock to the token lifetime (disclosed, never silent).
    expect(content).toContain('GH_TOKEN: __DXKIT_LANE_TOKEN_TASK__');
    expect(content).toContain('DXKIT_TOKEN_MODE: __DXKIT_LANE_TOKEN_MODE__');
    // Ordering: agent-CLI install → re-mint → credential refresh → task, so
    // setup time cannot eat the token's hour. The re-mint step exists only
    // after substitution, so order over the RENDERED content.
    const rendered = renderForParse(content);
    const install = rendered.indexOf('Install the agent CLI');
    const remint = rendered.indexOf('id: dxkit-app-token-task');
    const refresh = rendered.indexOf('- name: Install the landing credential');
    const task = rendered.indexOf('Run task ${{ matrix.task }}');
    expect(install).toBeGreaterThan(-1);
    expect(remint).toBeGreaterThan(install);
    expect(refresh).toBeGreaterThan(remint);
    expect(task).toBeGreaterThan(refresh);
  });
});

/**
 * ONE definition of the tier NAMES (4.4.5, dxkit #325 round 2). The three
 * configuration names live as constants in src/lanes/lane-token.ts; every
 * workflow reference arrives via a __DXKIT_LANE_TOKEN_*__ substitution and
 * every src consumer (the doctor probe, install notes, disclosures)
 * imports the constants, so a rename cannot leave a template, a probe,
 * or a remedy on a stale name.
 */
describe('lane token NAME discipline (one definition)', () => {
  const NAME_LITERALS = [
    LANE_TOKEN_APP_ID_VARIABLE_NAME,
    LANE_TOKEN_APP_KEY_SECRET_NAME,
    LANE_TOKEN_PAT_SECRET_NAME,
  ];

  it('raw templates carry NO tier-name literals (names arrive only via substitution)', () => {
    const offenders: string[] = [];
    for (const { file, content } of templates()) {
      for (const name of NAME_LITERALS) {
        if (content.includes(name)) offenders.push(`${file}: literal ${name}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the rendered remediate template gets the task re-mint from the one definition', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS, 'dxkit-remediate.yml'), 'utf8');
    const rendered = renderForParse(content);
    expect(rendered).toContain(LANE_TOKEN_TASK_STEPS);
    expect(rendered).toContain(`vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME}`);
    expect(rendered).toContain(`secrets.${LANE_TOKEN_APP_KEY_SECRET_NAME}`);
  });

  it('within src/, the raw name literals appear ONLY in lane-token.ts', () => {
    const SRC = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(SRC, p).split(path.sep).join('/');
        if (rel === 'lanes/lane-token.ts') continue;
        const content = fs.readFileSync(p, 'utf8');
        for (const name of NAME_LITERALS) {
          if (content.includes(name)) offenders.push(`src/${rel}: literal ${name}`);
        }
      }
    };
    walk(SRC);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
