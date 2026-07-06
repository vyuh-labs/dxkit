import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planUninstall, executeUninstall } from '../src/uninstall';
import { sha256 } from '../src/files';
import { GITIGNORE_HEADER, GITIGNORE_ENTRIES, DXKIT_PACKAGE } from '../src/ship-installers';
import { CLAUDE_BLOCK_START, CLAUDE_BLOCK_END } from '../src/loop/scaffold';
import type { InstallFlags } from '../src/update';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-uninst-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(tmp, rel));
}
function read(rel: string): string {
  return fs.readFileSync(path.join(tmp, rel), 'utf-8');
}

const ALL_FLAGS: InstallFlags = {
  withDxkitAgents: true,
  withHooks: true,
  withPrecommit: true,
  withDevcontainer: true,
  withCiGuardrails: true,
  withBaselineRefresh: true,
  withPrReview: true,
  withClaudeLoop: true,
};

function writeManifest(
  files: Record<string, { hash: string | null; evolving: boolean }>,
  flags = ALL_FLAGS,
): void {
  write(
    '.vyuh-dxkit.json',
    JSON.stringify({
      version: '2.24.0',
      mode: 'full',
      generatedAt: 'x',
      config: {},
      files,
      installFlags: flags,
    }),
  );
}

describe('planUninstall / executeUninstall — restores pre-dxkit state', () => {
  it('reverts additive merges into pre-existing user files, byte-for-byte', () => {
    // A user who already had .gitignore + CLAUDE.md; dxkit appended to both.
    const userGitignore = 'node_modules/\ndist/\n';
    const userClaude = '# My rules\n\nDo the thing.\n';
    write(
      '.gitignore',
      userGitignore + '\n' + GITIGNORE_HEADER + '\n' + GITIGNORE_ENTRIES.join('\n') + '\n',
    );
    write(
      'CLAUDE.md',
      userClaude + '\n' + CLAUDE_BLOCK_START + '\nloop stuff\n' + CLAUDE_BLOCK_END + '\n',
    );
    // package.json the user owns, with dxkit's devDep added (no trailing newline).
    write(
      'package.json',
      JSON.stringify(
        { name: 'x', devDependencies: { [DXKIT_PACKAGE]: '^2.24.0', react: '^18' } },
        null,
        2,
      ),
    );
    // CLAUDE.md is NOT in the manifest → dxkit only appended (user's own file).
    writeManifest({});

    const plan = planUninstall(tmp, { removeDevDependency: true });
    executeUninstall(tmp, plan, { removeDevDependency: true });

    expect(read('.gitignore')).toBe(userGitignore); // dxkit block gone, user lines intact
    expect(read('CLAUDE.md')).toBe(userClaude); // loop block gone, prose intact
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.devDependencies).toEqual({ react: '^18' }); // only dxkit removed
    expect(pkg.name).toBe('x');
  });

  it("deletes a dxkit-CREATED CLAUDE.md entirely (was not the user's)", () => {
    const shim = '# Project — Claude config\n\ndxkit shim prose\n';
    write('CLAUDE.md', shim + '\n' + CLAUDE_BLOCK_START + '\nloop\n' + CLAUDE_BLOCK_END + '\n');
    writeManifest({ 'CLAUDE.md': { hash: sha256(shim), evolving: false } });

    const plan = planUninstall(tmp);
    executeUninstall(tmp, plan);
    expect(exists('CLAUDE.md')).toBe(false); // whole dxkit-created file removed
  });

  it('deletes created files + the .dxkit tree, pruning empty dxkit dirs', () => {
    write('.claude/skills/dxkit-learn/SKILL.md', 'x');
    write('.claude/skills/dxkit-loop/SKILL.md', 'x');
    write('AGENTS.md', 'agents');
    write('.dxkit/policy.json', '{}');
    write('.dxkit/reports/health.md', '#');
    writeManifest({
      'AGENTS.md': { hash: null, evolving: true },
      '.claude/skills/dxkit-learn/SKILL.md': { hash: null, evolving: true },
      '.claude/skills/dxkit-loop/SKILL.md': { hash: null, evolving: true },
    });

    const plan = planUninstall(tmp);
    executeUninstall(tmp, plan);
    expect(exists('AGENTS.md')).toBe(false);
    expect(exists('.claude/skills/dxkit-learn/SKILL.md')).toBe(false);
    expect(exists('.dxkit')).toBe(false);
    expect(exists('.claude')).toBe(false); // pruned (no non-dxkit content)
    expect(exists('.vyuh-dxkit.json')).toBe(false); // manifest removed last
  });

  it('skips a dxkit-created file the user edited (hash mismatch), unless --force', () => {
    write('AGENTS.md', 'the user rewrote this');
    writeManifest({ 'AGENTS.md': { hash: sha256('original dxkit content'), evolving: false } });

    const plan = planUninstall(tmp);
    expect(plan.warnings.some((w) => w.includes('AGENTS.md'))).toBe(true);
    executeUninstall(tmp, plan);
    expect(exists('AGENTS.md')).toBe(true); // preserved — not clobbered

    const forced = planUninstall(tmp, { force: true });
    executeUninstall(tmp, forced, { force: true });
    expect(exists('AGENTS.md')).toBe(false);
  });

  it('--keep-baselines preserves the committed curated artifacts', () => {
    write('.dxkit/baselines/main.json', '{}');
    write('.dxkit/allowlist.json', '{}');
    // Committed cross-repo flow contract + participant list — curated like a
    // baseline (a repo commits them and a counterpart gates against them).
    write('.dxkit/flow/served.json', '{"side":"served","routes":[]}');
    write('.dxkit/flow/consumed.json', '{"side":"consumed","bindings":[]}');
    write('.dxkit/workspace.json', '{"participants":[]}');
    write('.dxkit/reports/x.md', '#');
    write('.dxkit/policy.json', '{}');
    writeManifest({});

    const plan = planUninstall(tmp, { keepBaselines: true });
    executeUninstall(tmp, plan, { keepBaselines: true });
    expect(exists('.dxkit/baselines/main.json')).toBe(true); // kept
    expect(exists('.dxkit/allowlist.json')).toBe(true); // kept
    expect(exists('.dxkit/flow/served.json')).toBe(true); // kept — committed contract
    expect(exists('.dxkit/flow/consumed.json')).toBe(true); // kept
    expect(exists('.dxkit/workspace.json')).toBe(true); // kept — committed participants
    expect(exists('.dxkit/reports/x.md')).toBe(false); // runtime removed
    expect(exists('.dxkit/policy.json')).toBe(false); // config removed (not curated)
  });

  it('reports empty on a repo with no dxkit footprint', () => {
    write('package.json', '{"name":"x"}');
    expect(planUninstall(tmp).empty).toBe(true);
  });
});

describe('recipe symmetry — every install surface has a removal path', () => {
  // For each install flag, its gated artifact must appear as a pending removal.
  const FLAG_ARTIFACT: Array<[keyof InstallFlags, string]> = [
    ['withHooks', '.githooks/pre-push'],
    ['withPrecommit', '.githooks/pre-commit'],
    ['withCiGuardrails', '.github/workflows/dxkit-guardrails.yml'],
    ['withBaselineRefresh', '.github/workflows/dxkit-baseline-refresh.yml'],
    ['withPrReview', '.github/workflows/pr-review.yml'],
  ];

  it.each(FLAG_ARTIFACT)('flag %s → its artifact is planned for removal', (flag, artifact) => {
    write(artifact, 'content');
    writeManifest({}, { ...ALL_FLAGS, [flag]: true } as InstallFlags);
    const plan = planUninstall(tmp);
    const act = plan.actions.find((a) => a.target === artifact);
    expect(act, `${artifact} not in plan`).toBeDefined();
    expect(act!.status).toBe('pending');
  });

  it('self-invocation surfaces are all reversed (settings hooks + pre-push + CI)', () => {
    // The four Rule-14 self-invocation surfaces, present together.
    write(
      '.claude/settings.json',
      JSON.stringify({
        $schema: 's',
        permissions: { allow: ['Bash(vyuh-dxkit:*)'], deny: [] },
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [{ command: 'vyuh-dxkit context-hook' }] }],
          Stop: [{ hooks: [{ command: 'npx vyuh-dxkit hook stop-gate' }] }],
        },
      }),
    );
    write('.githooks/pre-push', '#!/bin/sh');
    write('.github/workflows/dxkit-guardrails.yml', 'name: x');
    writeManifest({ '.claude/settings.json': { hash: null, evolving: false } });

    const plan = planUninstall(tmp);
    const targets = plan.actions.filter((a) => a.status === 'pending').map((a) => a.target);
    expect(targets).toContain('.claude/settings.json'); // both context-hook + stop-gate
    expect(targets).toContain('.githooks/pre-push');
    expect(targets).toContain('.github/workflows/dxkit-guardrails.yml');
  });
});

describe('planUninstall — skills resilience for older manifests', () => {
  it('removes .claude/skills/dxkit-* dirs even when the manifest did not record them', () => {
    // Simulate a repo installed by an OLDER dxkit whose manifest omits skills.
    write('.claude/skills/dxkit-learn/SKILL.md', '# learn');
    write('.claude/skills/dxkit-flow/SKILL.md', '# flow');
    write('.claude/skills/my-own-skill/SKILL.md', '# not dxkit'); // must be preserved
    write(
      '.vyuh-dxkit.json',
      JSON.stringify({
        version: '2.22.0',
        mode: 'committed-full',
        generatedAt: 't',
        config: {},
        files: {}, // no skills recorded — the older-manifest bug
        installFlags: ALL_FLAGS,
      }),
    );

    const plan = planUninstall(tmp);
    const targets = plan.actions.filter((a) => a.status === 'pending').map((a) => a.target);
    expect(targets).toContain('.claude/skills/dxkit-learn');
    expect(targets).toContain('.claude/skills/dxkit-flow');
    expect(targets).not.toContain('.claude/skills/my-own-skill');

    executeUninstall(tmp, plan);
    expect(exists('.claude/skills/dxkit-learn')).toBe(false);
    expect(exists('.claude/skills/dxkit-flow')).toBe(false);
    expect(exists('.claude/skills/my-own-skill')).toBe(true); // user skill untouched
  });

  it('does not double-remove skills the manifest DID record (hash-guarded path wins)', () => {
    write('.claude/skills/dxkit-learn/SKILL.md', '# learn');
    const hash = sha256('# learn');
    write(
      '.vyuh-dxkit.json',
      JSON.stringify({
        version: '2.26.0',
        mode: 'committed-full',
        generatedAt: 't',
        config: {},
        files: { '.claude/skills/dxkit-learn/SKILL.md': { hash, evolving: false } },
        installFlags: ALL_FLAGS,
      }),
    );
    const plan = planUninstall(tmp);
    // Recorded as the SKILL.md file, not a duplicate delete-dir.
    const learnActions = plan.actions.filter((a) => a.target.includes('dxkit-learn'));
    expect(learnActions).toHaveLength(1);
    expect(learnActions[0].target).toBe('.claude/skills/dxkit-learn/SKILL.md');
  });
});
