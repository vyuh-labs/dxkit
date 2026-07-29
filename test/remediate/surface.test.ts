import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { installCiRemediate } from '../../src/ship-installers';
import { AGENT_DRIVERS, driverById } from '../../src/remediate/registry';
import { landRemediateHead, remediateBranchFor } from '../../src/remediate/land';
import type { Exec } from '../../src/land-refresh';

/**
 * The remediate SURFFACES: the managed workflow's secret wiring must DERIVE
 * from the driver registry's credentialEnv (a new driver never means editing
 * the template), its cron must come from the one cadence grammar, its
 * triggers must stay schedule + dispatch only (the trust analysis), and the
 * landing must push the agent's commits with --no-verify and open the
 * standing PR — as a DRAFT exactly when the salvage policy says so.
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-remediate-surface-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  mkdirSync(join(repo, '.dxkit'), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const workflowPath = () => join(repo, '.github', 'workflows', 'dxkit-remediate.yml');

describe('installCiRemediate (the managed workflow)', () => {
  it('renders secret wiring FROM the configured driver credentialEnv declaration', () => {
    writeFileSync(
      join(repo, '.dxkit', 'policy.json'),
      '{"remediate": {"enabled": true, "schedule": "daily"}}',
      'utf8',
    );
    installCiRemediate(repo);
    expect(existsSync(workflowPath())).toBe(true);
    const text = readFileSync(workflowPath(), 'utf8');
    const claude = driverById('claude-code')!;
    for (const name of claude.credentialEnv) {
      expect(text).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    // no unrendered substitution keys survive
    expect(text).not.toContain('__DXKIT_REMEDIATE_CREDENTIAL_ENV__');
    expect(text).not.toContain('__DXKIT_REMEDIATE_CRON__');
  });

  it('renders the schedule through the one cadence grammar (daily → its cron)', () => {
    writeFileSync(
      join(repo, '.dxkit', 'policy.json'),
      '{"remediate": {"enabled": true, "schedule": "daily"}}',
      'utf8',
    );
    installCiRemediate(repo);
    expect(readFileSync(workflowPath(), 'utf8')).toContain("cron: '0 6 * * *'");
  });

  it('triggers stay schedule + workflow_dispatch only — never PR or comment events', () => {
    writeFileSync(join(repo, '.dxkit', 'policy.json'), '{"remediate": {"enabled": true}}', 'utf8');
    installCiRemediate(repo);
    // YAML only — the security comment MENTIONS the banned events by name,
    // so match against comment-stripped lines.
    const yaml = readFileSync(workflowPath(), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(yaml).toContain('workflow_dispatch');
    expect(yaml).not.toMatch(/pull_request/);
    expect(yaml).not.toMatch(/issue_comment/);
  });
});

describe('landRemediateHead', () => {
  function captureExec(prListJson = '[]'): { calls: string[][]; exec: Exec } {
    const calls: string[][] = [];
    const exec: Exec = (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'list') return prListJson;
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'create')
        return 'https://github.com/o/r/pull/7';
      return '';
    };
    return { calls, exec };
  }

  it('force-pushes HEAD to the standing branch with --no-verify and opens the PR', () => {
    const { calls, exec } = captureExec();
    const result = landRemediateHead({
      cwd: repo,
      taskId: 'fix-vulns',
      defaultBranch: 'main',
      prTitle: 't',
      prBody: 'b',
      exec,
    });
    const push = calls.find((c) => c[0] === 'git' && c.includes('push'))!;
    expect(push).toContain('--no-verify');
    expect(push).toContain('--force');
    expect(push.join(' ')).toContain(`HEAD:refs/heads/${remediateBranchFor('fix-vulns')}`);
    expect(result.outcome).toBe('pr-opened');
    expect(result.prUrl).toBe('https://github.com/o/r/pull/7');
    const create = calls.find((c) => c[0] === 'gh' && c[2] === 'create')!;
    expect(create).not.toContain('--draft');
  });

  it('opens a DRAFT exactly when asked (the budget-exhausted salvage)', () => {
    const { calls, exec } = captureExec();
    landRemediateHead({
      cwd: repo,
      taskId: 'fix-lint',
      defaultBranch: 'main',
      prTitle: 't',
      prBody: 'b',
      draft: true,
      exec,
    });
    const create = calls.find((c) => c[0] === 'gh' && c[2] === 'create')!;
    expect(create).toContain('--draft');
  });

  it('updates an existing standing PR in place (never a pile)', () => {
    const { calls, exec } = captureExec('[{"url": "https://github.com/o/r/pull/3"}]');
    const result = landRemediateHead({
      cwd: repo,
      taskId: 'fix-vulns',
      defaultBranch: 'main',
      prTitle: 't',
      prBody: 'b',
      exec,
    });
    expect(result.outcome).toBe('pr-updated');
    expect(calls.some((c) => c[0] === 'gh' && c[2] === 'edit')).toBe(true);
    expect(calls.some((c) => c[0] === 'gh' && c[2] === 'create')).toBe(false);
  });
});

describe('registry coherence', () => {
  it('the workflow installer and the plan CLI read the SAME driver registry', () => {
    // Every registered driver's credentialEnv is renderable — the substitution
    // cannot fail on a driver the schema/plan admits.
    for (const driver of AGENT_DRIVERS) {
      for (const name of driver.credentialEnv) {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});
