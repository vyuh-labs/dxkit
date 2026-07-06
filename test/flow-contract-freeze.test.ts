/**
 * The 3.0 flow contract-freeze net — every COMMITTED flow/cross-repo artifact
 * carries a `schemaVersion`, so a future schema change is migratable instead of
 * silently misread. This is the platform-level anti-recurrence guard (mirror of
 * managed-artifacts-playbook / recipe-playbook): a new committed artifact that
 * ships WITHOUT a version stamp cannot pass here, because the freeze registry
 * below is the single enumerated declaration of the frozen contract and every
 * entry is exercised by a real write + read-back.
 *
 * The frozen v1 contract (do not break these shapes; evolve additively, and bump
 * the version + add a migration for any incompatible change):
 *   - .dxkit/flow/served.json    → ServedContract.schemaVersion   (=1)
 *   - .dxkit/flow/consumed.json  → ConsumedContract.schemaVersion (=1)
 *   - .dxkit/workspace.json      → Workspace.schemaVersion         (=1)
 *   - .dxkit/policy.json:flow    → flow.schemaVersion              (=1)
 *
 * (The non-committed graph overlay .dxkit/reports/graph.json is versioned
 * separately at GRAPH_SCHEMA_VERSION=2; flow-console.html + csv_output are
 * ephemeral and intentionally unversioned.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  writeServedContract,
  writeConsumedContract,
  readServedContract,
  readConsumedContract,
  SERVED_CONSUMED_SCHEMA_VERSION,
  type ServedContract,
  type ConsumedContract,
} from '../src/analyzers/flow/contract';
import {
  writeWorkspace,
  readWorkspace,
  workspacePath,
  WORKSPACE_SCHEMA_VERSION,
} from '../src/workspace';
import { writeFlowPolicy, FLOW_CONFIG_SCHEMA_VERSION } from '../src/analyzers/flow/config';

/** One committed artifact in the freeze contract: how to write it, where it
 *  lands, and how to read its stamped version out of the raw file. */
interface FrozenArtifact {
  readonly name: string;
  readonly version: number;
  /** Perform a real write into `cwd`. */
  readonly write: (cwd: string) => void;
  /** Repo-relative path of the written artifact. */
  readonly rel: string;
  /** Extract the schemaVersion from the parsed raw JSON. */
  readonly versionOf: (raw: unknown) => unknown;
}

const SERVED: ServedContract = {
  schemaVersion: 1,
  generatedAt: '2020-01-01T00:00:00.000Z',
  side: 'served',
  routes: [],
};
const CONSUMED: ConsumedContract = {
  schemaVersion: 1,
  generatedAt: '2020-01-01T00:00:00.000Z',
  side: 'consumed',
  bindings: [],
};

const FROZEN: readonly FrozenArtifact[] = [
  {
    name: 'served.json',
    version: SERVED_CONSUMED_SCHEMA_VERSION,
    write: (cwd) => writeServedContract(cwd, SERVED),
    rel: path.join('.dxkit', 'flow', 'served.json'),
    versionOf: (raw) => (raw as { schemaVersion?: unknown }).schemaVersion,
  },
  {
    name: 'consumed.json',
    version: SERVED_CONSUMED_SCHEMA_VERSION,
    write: (cwd) => writeConsumedContract(cwd, CONSUMED),
    rel: path.join('.dxkit', 'flow', 'consumed.json'),
    versionOf: (raw) => (raw as { schemaVersion?: unknown }).schemaVersion,
  },
  {
    name: 'workspace.json',
    version: WORKSPACE_SCHEMA_VERSION,
    write: (cwd) =>
      writeWorkspace(cwd, { participants: [{ name: 'api', path: '.' }], external: [] }),
    rel: path.join('.dxkit', 'workspace.json'),
    versionOf: (raw) => (raw as { schemaVersion?: unknown }).schemaVersion,
  },
  {
    name: 'policy.json:flow',
    version: FLOW_CONFIG_SCHEMA_VERSION,
    write: (cwd) => writeFlowPolicy(cwd, { mode: 'block' }),
    rel: path.join('.dxkit', 'policy.json'),
    versionOf: (raw) => (raw as { flow?: { schemaVersion?: unknown } }).flow?.schemaVersion,
  },
];

describe('flow contract freeze — every committed artifact carries a schemaVersion', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function scratch(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-freeze-'));
    cleanups.push(d);
    return d;
  }

  it.each(FROZEN)('$name is written with a numeric schemaVersion === its constant', (art) => {
    const cwd = scratch();
    art.write(cwd);
    const raw = JSON.parse(fs.readFileSync(path.join(cwd, art.rel), 'utf8'));
    const v = art.versionOf(raw);
    expect(typeof v, `${art.name} must stamp a numeric schemaVersion`).toBe('number');
    expect(v, `${art.name} version must equal its exported constant`).toBe(art.version);
  });

  it('served.json / consumed.json round-trip through the fail-open readers with the version', () => {
    const cwd = scratch();
    writeServedContract(cwd, SERVED);
    writeConsumedContract(cwd, CONSUMED);
    expect(readServedContract(cwd)?.schemaVersion).toBe(SERVED_CONSUMED_SCHEMA_VERSION);
    expect(readConsumedContract(cwd)?.schemaVersion).toBe(SERVED_CONSUMED_SCHEMA_VERSION);
  });

  it('workspace.json is stamped by the writer even though callers omit the version', () => {
    const cwd = scratch();
    // The caller supplies only participants + external (no schemaVersion) — the
    // writer stamps the current version; the reader always surfaces it.
    writeWorkspace(cwd, { participants: [{ name: 'web', path: '.' }], external: [] });
    expect(readWorkspace(cwd)?.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    const raw = JSON.parse(fs.readFileSync(workspacePath(cwd), 'utf8'));
    // schemaVersion is written FIRST for readability.
    expect(Object.keys(raw)[0]).toBe('schemaVersion');
  });

  it('a versionless legacy workspace.json reads as v1 (migration-safe default)', () => {
    const cwd = scratch();
    fs.mkdirSync(path.join(cwd, '.dxkit'), { recursive: true });
    // Simulate a file written before the stamp existed — no schemaVersion.
    fs.writeFileSync(
      workspacePath(cwd),
      JSON.stringify({ participants: [{ name: 'x', path: '.' }], external: [] }),
      'utf8',
    );
    expect(readWorkspace(cwd)?.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
  });

  it('writeFlowPolicy preserves other policy sections while stamping the flow version', () => {
    const cwd = scratch();
    fs.mkdirSync(path.join(cwd, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.dxkit', 'policy.json'),
      JSON.stringify(
        { loop: { preset: 'security-only' }, baseline: { mode: 'ref-based' } },
        null,
        2,
      ),
      'utf8',
    );
    writeFlowPolicy(cwd, { mode: 'warn' });
    const policy = JSON.parse(fs.readFileSync(path.join(cwd, '.dxkit', 'policy.json'), 'utf8'));
    expect(policy.flow.schemaVersion).toBe(FLOW_CONFIG_SCHEMA_VERSION);
    expect(policy.flow.mode).toBe('warn');
    // Untouched sections survive.
    expect(policy.loop.preset).toBe('security-only');
    expect(policy.baseline.mode).toBe('ref-based');
  });
});
