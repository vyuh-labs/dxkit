import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installStrategyProviders, LANGUAGES } from '../../src/languages';
import {
  INSTALL_OUTCOME_RECORD,
  renderInstallDependenciesShell,
  defaultResolvedTolerances,
  classifyInstallLog,
  readInstallOutcome,
  renderInstallOutcomeComment,
  summarizeInstallOutcome,
  writeInstallOutcome,
  type InstallOutcomeRecord,
} from '../../src/install';
import { describeLockfileDrift } from '../../src/languages/capabilities/install-strategy';
import { NODE_STRATEGY_BY_PM } from '../../src/languages/node-install';

/**
 * The install-outcome seam (#381): the generated workflow's rendered install
 * chain, EXECUTED as CI executes it (`bash -e` on the rendered `run:` body,
 * the smoke workflow's own method) against fake package managers on PATH,
 * records how it ended through the real CLI (`dist/index.js install
 * classify`), and the comment step's renderer turns that record into the
 * BLOCK form on a drifted lockfile or the "did not run" form that names
 * the failing command otherwise.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const PROVIDERS = installStrategyProviders(LANGUAGES).map((p) => p.provider);

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error('dist/index.js missing: run `npm run build` first (test:run does this).');
  }
});

/** A fake `npm` whose `ci` prints `outputs[n]` on its n-th call and exits 1
 *  (0 when the output is empty), plus a `vyuh-dxkit` shim onto the built
 *  CLI so the rendered chain's classify call-back resolves on PATH without
 *  a node_modules install. */
function fakeBin(dir: string, outputs: readonly string[]): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  ci)',
    `    n=$(cat "${dir}/calls" 2>/dev/null || echo 0)`,
    `    echo $((n + 1)) > "${dir}/calls"`,
    ...outputs.map(
      (o, i) =>
        `    if [ "$n" = "${i}" ]; then printf '%s\\n' ${JSON.stringify(o)}; exit ${o === '' ? 0 : 1}; fi`,
    ),
    '    echo "unexpected npm ci call $n" >&2; exit 99 ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n');
  writeFileSync(join(bin, 'npm'), script);
  chmodSync(join(bin, 'npm'), 0o755);
  writeFileSync(join(bin, 'vyuh-dxkit'), `#!/usr/bin/env bash\nexec node "${CLI}" "$@"\n`);
  chmodSync(join(bin, 'vyuh-dxkit'), 0o755);
  return bin;
}

/** Execute the rendered install block the way the workflow runner does. */
function runRenderedChain(repo: string, bin: string): { code: number; stdout: string } {
  const body = renderInstallDependenciesShell('', PROVIDERS, defaultResolvedTolerances());
  const script = join(repo, 'rendered-install-step.sh');
  writeFileSync(script, body);
  const r = spawnSync('bash', ['-e', script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  return { code: r.status ?? -1, stdout: `${r.stdout}${r.stderr}` };
}

function npmRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'dxkit-install-outcome-'));
  writeFileSync(join(repo, 'package.json'), '{"name":"x","dependencies":{"left-pad":"^2"}}');
  writeFileSync(join(repo, 'package-lock.json'), '{"name":"x","lockfileVersion":3}');
  return repo;
}

const DRIFT =
  'npm ERR! code EUSAGE\nnpm ERR! `npm ci` can only install packages when your package.json ' +
  'and package-lock.json are in sync.\nnpm ERR! Missing: left-pad@2.0.0 from lock file';
const PEER = 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve peer dependency';
const REGISTRY =
  'npm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.example/left-pad failed';

describe('the rendered install chain records a classified outcome (executed as CI executes it)', () => {
  it('a drifted lockfile: the chain records lockfile-drift, exits non-zero, and the comment is the BLOCK form', () => {
    const repo = npmRepo();
    try {
      // The live shape from #381: the primary fails ERESOLVE, the blanket
      // --legacy-peer-deps retry fails EUSAGE.
      const bin = fakeBin(repo, [PEER, DRIFT]);
      const run = runRenderedChain(repo, bin);
      expect(run.code, run.stdout).not.toBe(0);
      expect(run.stdout).toContain('--- fallback (npm ci --legacy-peer-deps) ---');
      expect(run.stdout).toContain('dxkit: dependency install failed on lockfile drift');

      const record = readInstallOutcome(repo);
      expect(record, `no record at ${INSTALL_OUTCOME_RECORD}\n${run.stdout}`).not.toBeNull();
      expect(record!.ok).toBe(false);
      expect(record!.class).toBe('lockfile-drift');
      expect(record!.primaryClass).toBe('peer-conflict');
      expect(record!.command).toBe('npm ci --legacy-peer-deps');
      expect(record!.attempts).toEqual(['npm ci', 'npm ci --legacy-peer-deps']);
      expect(record!.manager).toBe('npm');
      expect(record!.tail).toContain('EUSAGE');

      const comment = renderInstallOutcomeComment(record!);
      expect(comment.finding).toBe(true);
      expect(comment.markdown).toContain('### dxkit guardrails: BLOCKED');
      expect(comment.markdown).toContain('package-lock.json is out of sync with package.json');
      expect(comment.markdown).toContain(
        'Run `npm install --no-audit --no-fund` and commit package-lock.json.',
      );
      expect(comment.markdown).toContain('a finding of the change');
      expect(comment.markdown).not.toContain('did not run');
      expect(comment.markdown).not.toContain('not a finding in your change');
      expect(comment.annotation).toMatch(
        /^::error::dxkit guardrail blocked: package-lock\.json is out of sync/,
      );

      // And the comment subcommand renders the same from the record on disk.
      const rendered = spawnSync('node', [CLI, 'install', 'comment'], {
        cwd: repo,
        encoding: 'utf8',
      });
      expect(rendered.status).toBe(0);
      expect(rendered.stdout).toBe(comment.markdown);
      expect(rendered.stderr.trim()).toBe(comment.annotation);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a registry-down failure: unclassified, and the comment is the did-not-run form naming the commands', () => {
    const repo = npmRepo();
    try {
      const bin = fakeBin(repo, [REGISTRY, REGISTRY]);
      const run = runRenderedChain(repo, bin);
      expect(run.code).not.toBe(0);
      const record = readInstallOutcome(repo)!;
      expect(record.ok).toBe(false);
      expect(record.class).toBe('unclassified');
      expect(record.primaryClass).toBeUndefined();
      expect(record.attempts).toEqual(['npm ci', 'npm ci --legacy-peer-deps']);

      const comment = renderInstallOutcomeComment(record);
      expect(comment.finding).toBe(false);
      expect(comment.markdown).toContain('### dxkit guardrails: did not run');
      expect(comment.markdown).toContain(
        '`npm ci`, then `npm ci --legacy-peer-deps` exited non-zero',
      );
      expect(comment.markdown).toContain('Last lines of `npm ci --legacy-peer-deps`');
      expect(comment.markdown).toContain('ENOTFOUND');
      expect(comment.markdown).not.toContain('See the failing step in this job log');
      expect(comment.annotation).toContain('did not run');
      expect(comment.annotation).toContain('npm ci --legacy-peer-deps');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a peer conflict the fallback answers: the chain exits 0 and records ok (nothing new)', () => {
    const repo = npmRepo();
    try {
      const bin = fakeBin(repo, [PEER, '']);
      const run = runRenderedChain(repo, bin);
      expect(run.code, run.stdout).toBe(0);
      const record = readInstallOutcome(repo)!;
      expect(record.ok).toBe(true);
      expect(record.class).toBeUndefined();
      expect(record.command).toBe('npm ci --legacy-peer-deps');
      const comment = renderInstallOutcomeComment(record);
      expect(comment.finding).toBe(false);
      expect(comment.markdown).toContain('The dependency install succeeded');
      expect(comment.markdown).toContain('not a finding in your change');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('no record: the comment subcommand exits 1 so the workflow keeps its generic text', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dxkit-install-outcome-'));
    try {
      const r = spawnSync('node', [CLI, 'install', 'comment'], { cwd: repo, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the outcome record and its renderer', () => {
  it('a classified drift on a pnpm root phrases the remedy for pnpm (manager-aware, one phrasing)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dxkit-install-outcome-'));
    try {
      writeFileSync(join(repo, 'package.json'), '{"name":"x"}');
      writeFileSync(join(repo, 'pnpm-lock.yaml'), '');
      // pnpm declares no drift classifier today, so this is the structural
      // check: the record carries pnpm's facts and the renderer words them.
      const record = classifyInstallLog(repo, PROVIDERS, 'ERR_PNPM_OUTDATED_LOCKFILE', 1);
      expect(record.manager).toBe('pnpm');
      expect(record.drift?.lockfile).toBe('pnpm-lock.yaml');
      const forced: InstallOutcomeRecord = { ...record, class: 'lockfile-drift' };
      const sentence = describeLockfileDrift(record.drift);
      expect(sentence).toContain('pnpm-lock.yaml is out of sync with package.json');
      expect(sentence).toContain(
        'Run `pnpm install --no-frozen-lockfile` and commit pnpm-lock.yaml.',
      );
      expect(renderInstallOutcomeComment(forced).markdown).toContain(sentence);
      expect(summarizeInstallOutcome(forced)).toContain(sentence);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('the generic drift sentence (the floor, no strategy in hand) is unchanged', () => {
    expect(describeLockfileDrift()).toBe(
      'The lockfile does not satisfy the manifest: a frozen install (what CI runs before ' +
        'any gate) fails on this tree. Re-run the package manager install so the lockfile ' +
        'records the manifest, and commit both.',
    );
    expect(describeLockfileDrift(null)).toBe(describeLockfileDrift());
  });

  it('every node strategy names its manifest, so the remedy never says "the manifest" on a node root', () => {
    for (const s of Object.values(NODE_STRATEGY_BY_PM)) expect(s.manifest).toBe('package.json');
  });

  it('the no-manifest branch records the global CLI install as the command', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dxkit-install-outcome-'));
    try {
      const record = classifyInstallLog(repo, PROVIDERS, 'npm ERR! whatever', 1);
      expect(record.manager).toBeNull();
      expect(record.class).toBe('unclassified');
      expect(record.command).toBe('npm install -g @vyuhlabs/dxkit');
      expect(renderInstallOutcomeComment(record).markdown).toContain(
        '`npm install -g @vyuhlabs/dxkit` exited non-zero',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a classified non-drift class is named with its doctrine in the did-not-run form', () => {
    const repo = npmRepo();
    try {
      const record = classifyInstallLog(repo, PROVIDERS, PEER, 1);
      expect(record.class).toBe('peer-conflict');
      const comment = renderInstallOutcomeComment(record);
      expect(comment.finding).toBe(false);
      expect(comment.markdown).toContain('classified the failure as `peer-conflict`');
      expect(comment.markdown).toContain(
        'a peer-dependency conflict the lockfile tree already tolerates',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writeInstallOutcome / readInstallOutcome round-trip at the one constant path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dxkit-install-outcome-'));
    try {
      const record = classifyInstallLog(repo, PROVIDERS, '', 0);
      const abs = writeInstallOutcome(repo, record);
      expect(abs).toBe(join(repo, INSTALL_OUTCOME_RECORD));
      expect(JSON.parse(readFileSync(abs, 'utf8'))).toEqual(record);
      expect(readInstallOutcome(repo)).toEqual(record);
      writeFileSync(abs, '{not json');
      expect(readInstallOutcome(repo)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('the guardrails template reads the record through the CLI in its comment step, before the generic text', () => {
    const tpl = readFileSync(
      join(__dirname, '..', '..', 'src-templates', '.github', 'workflows', 'dxkit-guardrails.yml'),
      'utf8',
    );
    const comment = tpl.indexOf('"$DXKIT" install comment');
    const generic = tpl.indexOf("printf '### dxkit guardrails: did not run");
    expect(comment).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(comment);
  });
});
