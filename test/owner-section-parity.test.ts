/**
 * Parity net for the AGENTS.md owner section (4.5.0 agents-owner): every path
 * that writes or removes AGENTS.md goes through `src/owner-section.ts`, and
 * they agree on what "user-modified" means.
 *
 * Writers of AGENTS.md: the generator (fresh init, re-init over an install,
 * `update`, `update --force` all reach `applyManaged`) and uninstall.
 * `policy render` and update's ship-surface lane refresh only
 * MANAGED_SHIP_SURFACES, which must never claim an owner-section file. Each
 * writer is driven here with owner text in the section and must (a) keep that
 * text byte-for-byte and (b) record / compare the manifest hash with the
 * owner-section-aware `managedContentHash`. The negative controls prove the
 * fixtures discriminate (a raw sha256 would read the owner edit as a user
 * edit). The arch-check bans the marker literal and a raw sha256 on these
 * paths outside the module.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generate } from '../src/generator';
import { buildConditions, buildVariables } from '../src/constants';
import { processTemplate } from '../src/template-engine';
import { planUninstall, executeUninstall } from '../src/uninstall';
import { MANAGED_SHIP_SURFACES, managedGatedArtifacts } from '../src/managed-artifacts';
import { LANGUAGES } from '../src/languages';
import { sha256 } from '../src/files';
import {
  OWNER_SECTION_FILES,
  OWNER_SECTION_START,
  OWNER_SECTION_END,
  managedContentHash,
  splitOwnerSection,
} from '../src/owner-section';
import type { Manifest, ResolvedConfig } from '../src/types';

const ROOT = path.join(__dirname, '..');

beforeAll(() => {
  // generate() reads the BUILT templates/ dir (`npm run build` copies
  // src-templates/ there; test:run and the pre-push gate build first).
  if (!fs.existsSync(path.join(__dirname, '..', 'templates', 'AGENTS.md.template'))) {
    throw new Error('templates/ missing — run `npm run build` first (test:run does this).');
  }
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-owner-parity-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function config(): ResolvedConfig {
  const languages = Object.fromEntries(LANGUAGES.map((l) => [l.id, l.id === 'typescript']));
  return {
    languages: languages as ResolvedConfig['languages'],
    infrastructure: { docker: false, postgres: false, redis: false },
    projectName: 'parity',
    projectDescription: '',
    versions: {},
    requiredTools: [],
    coverageThreshold: '80',
    claudeCode: true,
  };
}

async function gen(force = false): Promise<void> {
  // Mute generate()'s per-file lines.
  const mute = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await generate(tmp, config(), 'dx-only', force, false, true);
  } finally {
    mute.mockRestore();
  }
}

const agentsPath = () => path.join(tmp, 'AGENTS.md');
const readAgents = () => fs.readFileSync(agentsPath(), 'utf-8');
const manifest = () =>
  JSON.parse(fs.readFileSync(path.join(tmp, '.vyuh-dxkit.json'), 'utf-8')) as Manifest;
const writeManifest = (m: Manifest) =>
  fs.writeFileSync(path.join(tmp, '.vyuh-dxkit.json'), JSON.stringify(m, null, 2));

const OWNER = '## What this is\n\nOrder intake for the warehouse. Build: `msbuild App.sln`.\n';
const fillOwner = (content: string, body = OWNER) => {
  const s = splitOwnerSection(content)!;
  return s.head + body + s.tail;
};

describe('the template carries exactly one empty owner section, for every stack', () => {
  it('renders well-formed with all packs on and all packs off', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'src-templates', 'AGENTS.md.template'), 'utf-8');
    for (const on of [true, false]) {
      const c = config();
      for (const l of LANGUAGES) c.languages[l.id] = on;
      const out = processTemplate(raw, buildVariables(c), buildConditions(c));
      const split = splitOwnerSection(out);
      expect(split).not.toBeNull();
      expect(split!.body).toBe('');
      expect(out).not.toContain('{{'); // every label variable resolved
    }
  });

  it('the generator is the only module that renders the AGENTS.md template', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && fs.readFileSync(p, 'utf-8').includes("'AGENTS.md.template'"))
          hits.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(hits).toEqual(['src/generator.ts']);
  });

  it('no managed ship surface (policy render / update refresh lane) claims an owner-section file', () => {
    const all = {
      withDxkitAgents: true,
      withHooks: true,
      withPrecommit: true,
      withDevcontainer: true,
      withCiGuardrails: true,
      withBaselineRefresh: true,
      withPrReview: true,
      withClaudeLoop: true,
    };
    const artifacts = new Set([
      ...managedGatedArtifacts(all),
      ...MANAGED_SHIP_SURFACES.flatMap((s) => [...s.artifacts(all)]),
    ]);
    for (const f of OWNER_SECTION_FILES) expect(artifacts.has(f)).toBe(false);
  });
});

describe('generator writers keep the owner text and hash it out of provenance', () => {
  it('fresh init records the owner-section-aware hash', async () => {
    await gen();
    const disk = readAgents();
    expect(disk).toContain(`${OWNER_SECTION_START}\n${OWNER_SECTION_END}`);
    expect(manifest().files['AGENTS.md'].hash).toBe(managedContentHash('AGENTS.md', disk));
  });

  for (const force of [false, true]) {
    it(`re-init / update${force ? ' --force' : ''} refreshes dxkit's sections around owner text`, async () => {
      await gen();
      // Simulate an older dxkit's AGENTS.md: stale text OUTSIDE the section,
      // recorded as dxkit's (hash of what that version wrote), plus the owner's
      // text INSIDE the section.
      const stale = readAgents().replace('## How to use this file', '## How to use (OLD)');
      const m = manifest();
      m.files['AGENTS.md'] = {
        hash: managedContentHash('AGENTS.md', stale),
        evolving: false,
        provenance: 'created',
      };
      writeManifest(m);
      const withOwner = fillOwner(stale);
      fs.writeFileSync(agentsPath(), withOwner);
      // Negative control: a raw hash WOULD read the owner text as a user edit.
      expect(sha256(withOwner)).not.toBe(m.files['AGENTS.md'].hash);

      await gen(force);

      const after = readAgents();
      expect(after).not.toContain('(OLD)'); // dxkit's part refreshed
      expect(splitOwnerSection(after)!.body).toBe(OWNER); // owner's part kept
      expect(manifest().files['AGENTS.md'].hash).toBe(managedContentHash('AGENTS.md', after));
    });
  }

  it('an edit OUTSIDE the section is never clobbered, even with --force', async () => {
    await gen();
    const edited = fillOwner(readAgents()).replace('## Conventions', '## Our conventions');
    fs.writeFileSync(agentsPath(), edited);
    await gen(true);
    expect(readAgents()).toBe(edited);
  });

  it('legacy install (no markers, unmodified) migrates to an empty owner section', async () => {
    await gen();
    const legacy = '# parity\n\nA project\n\n## How to use this file\n\nold dxkit prose\n';
    fs.writeFileSync(agentsPath(), legacy);
    const m = manifest();
    m.files['AGENTS.md'] = { hash: sha256(legacy), evolving: false, provenance: 'created' };
    writeManifest(m);
    await gen();
    const after = readAgents();
    expect(after).not.toContain('A project');
    expect(splitOwnerSection(after)!.body).toBe('');
  });

  it('legacy install the user edited is left alone', async () => {
    await gen();
    const legacy = '# parity\n\nOur own description.\n';
    fs.writeFileSync(agentsPath(), legacy);
    const m = manifest();
    m.files['AGENTS.md'] = {
      hash: sha256('# parity\n\nA project\n'),
      evolving: false,
      provenance: 'created',
    };
    writeManifest(m);
    await gen(true);
    expect(readAgents()).toBe(legacy);
  });

  it('fresh init --force never overwrites a pre-existing AGENTS.md dxkit has no record of', async () => {
    const own = '# Ours\n\nProject-authored guidance.\n';
    fs.writeFileSync(agentsPath(), own);
    await gen(true);
    expect(readAgents()).toBe(own);
    expect(manifest().files['AGENTS.md'].provenance).toBe('skipped');
  });
});

describe('uninstall reads the same hash and keeps the owner text', () => {
  it('empty owner section → AGENTS.md removed as before', async () => {
    await gen();
    executeUninstall(tmp, planUninstall(tmp));
    expect(fs.existsSync(agentsPath())).toBe(false);
  });

  it('owner text → the file is reduced to that text, not deleted', async () => {
    await gen();
    fs.writeFileSync(agentsPath(), fillOwner(readAgents()));
    const plan = planUninstall(tmp);
    expect(plan.actions.find((a) => a.target === 'AGENTS.md')?.kind).toBe('keep-owner-section');
    expect(plan.warnings.some((w) => w.startsWith('AGENTS.md kept'))).toBe(true);
    executeUninstall(tmp, plan);
    expect(readAgents()).toBe(OWNER);
    expect(fs.existsSync(path.join(tmp, '.vyuh-dxkit.json'))).toBe(false);
  });

  it('owner text + an edit outside → whole file kept (skip-modified) unless --force', async () => {
    await gen();
    const edited = fillOwner(readAgents()).replace('## Conventions', '## Our conventions');
    fs.writeFileSync(agentsPath(), edited);
    executeUninstall(tmp, planUninstall(tmp));
    expect(readAgents()).toBe(edited);
    const forced = planUninstall(tmp, { force: true });
    executeUninstall(tmp, forced, { force: true });
    expect(readAgents()).toBe(OWNER); // --force removes dxkit's part, never the owner's
  });
});
