import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
  INSTALL_DEPS_PLACEHOLDER,
  defaultResolvedTolerances,
  renderInstallDependenciesShell,
} from '../src/install';
import { installStrategyProviders, LANGUAGES } from '../src/languages';
import { installCiGuardrails } from '../src/ship-installers';

/**
 * Workflow templates install a repo's dependencies through ONE definition
 * (4.4.5, Rule 2.30): `src/package-manager.ts` owns the frozen-install table,
 * the templates carry a whole-line placeholder, and the ONE workflow writer
 * substitutes the rendered block. Before this, twelve templates carried a
 * hand-copied shell chain (one of them npm-only, already drifted), and the
 * remediate lane verified a tree with a different install than CI ran.
 *
 * Membership is derived from template CONTENT (a template that invokes the
 * dxkit CLI from a repo checkout needs the repo's dependencies installed the
 * frozen way), never from a filename list; deliberate non-members are
 * declared exemptions with reasons.
 */

const WORKFLOWS = path.join(__dirname, '..', 'src-templates', '.github', 'workflows');

/** Templates that invoke the CLI from a checkout but DELIBERATELY do not
 *  install the repo's dependencies. A reason, never an omission. */
const INSTALL_EXEMPT: Readonly<Record<string, string>> = {
  'dxkit-gate-host.yml':
    'the per-host floor job installs only the dxkit CLI; the placed pack’s own ' +
    'ciSetup provisions the toolchain, and the floor commands install nothing',
};

function templates(): Array<{ file: string; content: string }> {
  return fs
    .readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml'))
    .map((file) => ({ file, content: fs.readFileSync(path.join(WORKFLOWS, file), 'utf8') }));
}

/** Does this template run dxkit against a repo checkout? Then it must have
 *  installed that checkout's dependencies the frozen way first. */
function runsDxkitOnCheckout(content: string): boolean {
  return content.includes('node_modules/.bin/vyuh-dxkit');
}

describe('dependency-install block: one definition, rendered into every template', () => {
  it('no template carries a hand-written frozen-install chain', () => {
    for (const { file, content } of templates()) {
      expect(
        content,
        `${file}: inline install chain (use ${INSTALL_DEPS_PLACEHOLDER})`,
      ).not.toMatch(
        /npm ci( \|\||\n)|pnpm install --frozen-lockfile|yarn install --immutable|bun install --frozen-lockfile/,
      );
    }
  });

  it('every template that runs dxkit on a checkout carries the placeholder, or a declared exemption', () => {
    for (const { file, content } of templates()) {
      if (!runsDxkitOnCheckout(content)) continue;
      const has = content.includes(`          ${INSTALL_DEPS_PLACEHOLDER}\n`);
      if (file in INSTALL_EXEMPT) {
        expect(has, `${file}: exempt but carries the placeholder; drop the exemption`).toBe(false);
        continue;
      }
      expect(has, `${file}: runs dxkit on a checkout without the frozen install placeholder`).toBe(
        true,
      );
    }
  });

  it('every exemption names a real template', () => {
    const names = templates().map((t) => t.file);
    for (const f of Object.keys(INSTALL_EXEMPT)) expect(names).toContain(f);
  });

  it('the writer renders the block from the one definition (the guardrails workflow, end to end)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-install-tpl-'));
    try {
      fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
      installCiGuardrails(tmp);
      const out = fs.readFileSync(
        path.join(tmp, '.github', 'workflows', 'dxkit-guardrails.yml'),
        'utf8',
      );
      expect(out).not.toContain(INSTALL_DEPS_PLACEHOLDER);
      expect(out).toContain(
        renderInstallDependenciesShell(
          '          ',
          installStrategyProviders(LANGUAGES).map((p) => p.provider),
          defaultResolvedTolerances(),
        ),
      );
      // And it is still valid YAML with a real `run:` body.
      const parsed = yaml.load(out) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
      const runs = Object.values(parsed.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ''));
      expect(runs.some((r) => r.includes('npm ci || npm ci --legacy-peer-deps'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Synthetic injection: the content-derived membership predicate must bite
  // on a template that runs dxkit without installing.
  it('the membership predicate bites on a synthetic template', () => {
    expect(runsDxkitOnCheckout('run: ./node_modules/.bin/vyuh-dxkit guardrail check')).toBe(true);
    expect(runsDxkitOnCheckout('run: echo nothing')).toBe(false);
  });
});
