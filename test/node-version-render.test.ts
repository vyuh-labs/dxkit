/**
 * Generated workflows render `node-version` from the repo's DECLARED Node
 * through the TypeScript pack (Rule 6), never from a literal in a template
 * (4.4.8 N). ONE placeholder (`{{NODE_VERSION}}`, the AGENTS.md convention)
 * filled from ONE substitution source (`packVersionVariables`) by the ONE
 * workflow writer, so the gate cannot move a customer's test runtime
 * silently: a repo on Node 20 keeps its floor on 20, a repo that declares
 * nothing gets the pack default.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installCiGuardrails,
  installCiBaselineRefresh,
  installPrReview,
  nodeVersionFor,
} from '../src/ship-installers';
import { packVersionVariables } from '../src/constants';
import { typescript } from '../src/languages/typescript';

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_WORKFLOWS = path.join(REPO_ROOT, 'src-templates', '.github', 'workflows');

function workflowTemplates(): string[] {
  const out: string[] = [];
  for (const dir of [TEMPLATE_WORKFLOWS, path.join(TEMPLATE_WORKFLOWS, 'partials')]) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.yml')) out.push(path.join(dir, name));
    }
  }
  return out;
}

function readWorkflow(tmp: string, name: string): string {
  return fs.readFileSync(path.join(tmp, '.github', 'workflows', name), 'utf8');
}

describe('generated workflows render node-version through the pack', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-node-version-'));
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('no template carries a literal node-version: every setup-node line is the ONE placeholder', () => {
    const templates = workflowTemplates();
    expect(templates.length).toBeGreaterThan(5);
    const withSetupNode = templates.filter((f) =>
      fs.readFileSync(f, 'utf8').includes('actions/setup-node'),
    );
    expect(withSetupNode.length).toBeGreaterThan(5);
    for (const file of withSetupNode) {
      const lines = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim().startsWith('node-version:'));
      expect(lines.length, path.basename(file)).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.trim(), path.basename(file)).toBe("node-version: '{{NODE_VERSION}}'");
      }
    }
  });

  it('a repo with .nvmrc = 20 keeps its gate on Node 20', () => {
    fs.writeFileSync(path.join(tmp, '.nvmrc'), '20\n');
    installCiGuardrails(tmp);
    const content = readWorkflow(tmp, 'dxkit-guardrails.yml');
    expect(content).toContain("node-version: '20'");
    expect(content).not.toContain('{{NODE_VERSION}}');
    expect(nodeVersionFor(tmp)).toBe('20');
  });

  it('a repo declaring nothing renders the pack default (24)', () => {
    installCiGuardrails(tmp);
    installCiBaselineRefresh(tmp);
    installPrReview(tmp);
    for (const name of ['dxkit-guardrails.yml', 'dxkit-baseline-refresh.yml', 'pr-review.yml']) {
      const content = readWorkflow(tmp, name);
      expect(content, name).toContain("node-version: '24'");
      expect(content, name).not.toContain('{{NODE_VERSION}}');
    }
    expect(typescript.defaultVersion).toBe('24');
    expect(nodeVersionFor(tmp)).toBe('24');
  });

  it('an engines.node range reads as its declared floor, never the installed Node', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', engines: { node: '>=20 <23' } }),
    );
    installCiGuardrails(tmp);
    expect(readWorkflow(tmp, 'dxkit-guardrails.yml')).toContain("node-version: '20'");
    // Repo-intrinsic: the render does not depend on the machine's Node.
    expect(typescript.detectVersion!(tmp)).toBe('20');
    expect(typescript.detectVersion!(tmp)).not.toBe(process.versions.node.split('.')[0] + 'x');
  });

  it('.nvmrc wins over engines, and a repo declaring nothing detects undefined', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', engines: { node: '^22' } }),
    );
    fs.writeFileSync(path.join(tmp, '.nvmrc'), 'v20.11.1\n');
    expect(typescript.detectVersion!(tmp)).toBe('20');
    fs.rmSync(path.join(tmp, '.nvmrc'));
    expect(typescript.detectVersion!(tmp)).toBe('22');
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );
    expect(typescript.detectVersion!(tmp)).toBeUndefined();
  });

  it('engines.node shapes: bounded ranges name their floor, an open floor defers to the default', () => {
    const cases: Array<[string, string | undefined]> = [
      // Open floors the pack default (24) satisfies declare nothing.
      ['>=10', undefined],
      ['>18', undefined],
      ['>=18.20.2', undefined],
      ['*', undefined],
      // An open floor ABOVE the default is the floor itself.
      ['>=26', '26'],
      ['>25', '26'],
      // Pinned / bounded / alternated ranges name their lowest major.
      ['20', '20'],
      ['20.x', '20'],
      ['^20', '20'],
      ['~20.11.0', '20'],
      ['>=20 <23', '20'],
      ['>=20.0.0 <21', '20'],
      ['^20 || ^22', '20'],
      ['18 - 22', '18'],
    ];
    for (const [engine, want] of cases) {
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0', engines: { node: engine } }),
      );
      expect(typescript.detectVersion!(tmp), engine).toBe(want);
    }
  });

  it('the workflow render and the AGENTS.md render share ONE substitution source', () => {
    // `packVersionVariables` is what buildVariables (the generator's
    // `{{NODE_VERSION}}`) reads and what the workflow writer reads: the same
    // input yields the same value on both surfaces.
    expect(packVersionVariables({ node: '20' }).NODE_VERSION).toBe('20');
    expect(packVersionVariables({}).NODE_VERSION).toBe(typescript.defaultVersion);
  });

  it('update refreshes a dxkit-managed workflow whose node-version moved (no --force)', () => {
    installCiGuardrails(tmp);
    const abs = path.join(tmp, '.github', 'workflows', 'dxkit-guardrails.yml');
    const stale = fs.readFileSync(abs, 'utf8').replace("node-version: '24'", "node-version: '22'");
    expect(stale).toContain("node-version: '22'");
    fs.writeFileSync(abs, stale);

    const result = installCiGuardrails(tmp);
    expect(result.installed).toContain('.github/workflows/dxkit-guardrails.yml');
    expect(fs.readFileSync(abs, 'utf8')).toContain("node-version: '24'");
    expect(result.notes.some((n) => n.includes('Node runtime to 24'))).toBe(true);
  });
});
