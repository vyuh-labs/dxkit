import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { runGateCommand, renderGateOutcome } from '../../src/gate-cli';
import { runWaveCommand } from '../../src/gate-wave';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import { policyForPreset } from '../../src/baseline/presets';

/**
 * The GATE ACCEPTANCE MATRIX (4.4.0 WP9) — the committed, neutralized
 * form of the package-mode expected-verdict table, run as a standing
 * gate rather than a one-off. Fixtures live in test/fixtures/gate/
 * (package / abap / workspace); each row states the verdict a
 * conversion-package DoD must produce. The abap rows need the
 * registry-pinned abaplint on PATH (CI installs it; locally they skip
 * with the binary named).
 *
 * The floor-tier row (seeded failing test) is covered by the
 * injected-seam tests in gate-command.test.ts plus the release
 * rehearsal's local tier — running a real jest install per CI run buys
 * no additional truth for its cost.
 */

const FIXTURES = join(__dirname, '..', 'fixtures', 'gate');
const HEAVY = 900_000;

let hasAbaplint = false;
try {
  execSync('abaplint --version', { stdio: ['ignore', 'pipe', 'pipe'] });
  hasAbaplint = true;
} catch {
  /* abap rows skip, named below */
}

/** The DoD every row runs under: security posture + the placeholder
 *  text rule (blocking) — the neutral equivalent of a conversion
 *  package's policy document. */
function dodPolicyPath(dir: string): string {
  const { policy } = policyForPreset('security-only', DEFAULT_BROWNFIELD_POLICY);
  const p = join(dir, 'dod-policy.json');
  writeFileSync(
    p,
    JSON.stringify({
      ...policy,
      id: 'acceptance.dod.pkg',
      version: '1',
      // The matrix's embed scenario gates UNTRUSTED trees on findings; the
      // compile/test floor is exercised by its own --trusted rows, so the
      // DoD opts out of the default-required floor (WP1 §7.1). The default
      // refusal has its own dedicated row below.
      floor: { required: false },
      checks: [
        {
          name: 'no_placeholder',
          pattern: '\\b(TODO|FIXME|XXX)\\b',
          globs: ['code/**', 'tests/**'],
          blocking: true,
        },
      ],
    }),
  );
  return p;
}

let scratch: string;
let policyPath: string;
let savedSalt: string | undefined;

beforeAll(() => {
  savedSalt = process.env.DXKIT_BASELINE_SALT;
  delete process.env.DXKIT_BASELINE_SALT;
  scratch = mkdtempSync(join(tmpdir(), 'dxkit-acceptance-'));
  policyPath = dodPolicyPath(scratch);
});

afterAll(() => {
  if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
  else process.env.DXKIT_BASELINE_SALT = savedSalt;
  rmSync(scratch, { recursive: true, force: true });
});

/** Run a fixture COPY (fixtures stay pristine) through the gate. */
async function gateRow(
  fixture: string,
  opts: { trusted?: boolean; seed?: (copy: string) => void } = {},
) {
  const copy = join(scratch, fixture.replace(/\//g, '-'));
  cpSync(join(FIXTURES, fixture), copy, { recursive: true });
  opts.seed?.(copy);
  const outcome = await runGateCommand(copy, { policyPath, trusted: opts.trusted });
  return { outcome, doc: JSON.parse(renderGateOutcome(outcome, true)) };
}

/** The credential seed is assembled from fragments AT TEST TIME and written
 *  only into the scratch copy — neither the committed fixture nor this test
 *  file carries an adjacent scannable credential, so dxkit's own repo gate
 *  stays clean while the copied tree scans hot. */
function seedCredential(copy: string): void {
  const target = join(copy, 'code', 'service.js');
  const line = ['const apiKey = ', "'", 'fixt', '-live-', '0123456789abcdef', "'", ';'].join('');
  writeFileSync(target, line + '\n' + readFileSync(target, 'utf8'));
}

describe('package rows', () => {
  it(
    'clean → passed',
    async () => {
      const { doc } = await gateRow('package/clean');
      expect(doc.status).toBe('passed');
      expect(doc.exitCode).toBe(0);
    },
    HEAVY,
  );

  it(
    'clean, untrusted, no floor opt-out → cannot_gate: the required floor did not run (WP1 §7.1)',
    async () => {
      // The default posture (no --policy, no tree policy) REQUIRES the
      // floor: an untrusted run that cannot execute compile + tests refuses
      // to certify the tree instead of passing over the skip. Exit 2, and
      // the wire refusal names the floor with both remedies.
      const copy = join(scratch, 'package-clean-required-floor');
      cpSync(join(FIXTURES, 'package/clean'), copy, { recursive: true });
      const outcome = await runGateCommand(copy, {});
      const doc = JSON.parse(renderGateOutcome(outcome, true));
      expect(doc.status).toBe('cannot_gate');
      expect(doc.exitCode).toBe(2);
      expect(doc.floor.ran).toBe(false);
      expect(doc.refusals.some((r: { reason: string }) => r.reason.includes('floor'))).toBe(true);
    },
    HEAVY,
  );

  it(
    'seeded-placeholder → blocked by the text rule, fingerprinted',
    async () => {
      const { doc } = await gateRow('package/seeded-placeholder');
      expect(doc.status).toBe('blocked');
      const f = doc.findings.find(
        (x: { kind: string; blocking: boolean }) => x.kind === 'custom-check' && x.blocking,
      );
      expect(f.file).toBe('code/handlers.js');
      expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    },
    HEAVY,
  );

  it(
    'seeded-credential → blocked as a secret',
    async () => {
      const { doc } = await gateRow('package/seeded-credential', { seed: seedCredential });
      expect(doc.status).toBe('blocked');
      expect(
        doc.findings.some(
          (x: { kind: string; blocking: boolean }) => x.kind === 'secret' && x.blocking,
        ),
      ).toBe(true);
    },
    HEAVY,
  );
});

describe('abap rows (need the registry-pinned abaplint)', () => {
  it.skipIf(!hasAbaplint)(
    'seeded-placeholder → blocked by the text rule over .abap',
    async () => {
      const { doc } = await gateRow('abap/seeded-placeholder');
      expect(doc.status).toBe('blocked');
      const f = doc.findings.find(
        (x: { kind: string; blocking: boolean }) => x.kind === 'custom-check' && x.blocking,
      );
      expect(f.file).toContain('.clas.abap');
    },
    HEAVY,
  );

  it.skipIf(!hasAbaplint)(
    'seeded-truncated-class → blocked by the abaplint parse floor (--trusted)',
    async () => {
      const { outcome, doc } = await gateRow('abap/seeded-truncated-class', { trusted: true });
      expect(doc.status).toBe('blocked');
      expect(outcome.floorNetNew.length).toBeGreaterThan(0);
      const floorCheck = doc.floor.checks.find((c: { id: string }) =>
        c.id.includes('abaplint-syntax'),
      );
      expect(floorCheck.status).toBe('failed');
    },
    HEAVY,
  );
});

describe('workspace rows (both directions)', () => {
  it(
    'seeded estate → blocked: unresolved call + broken flow block, dead route visible',
    async () => {
      const copy = join(scratch, 'workspace-seeded');
      cpSync(join(FIXTURES, 'workspace'), copy, { recursive: true });
      const outcome = await runWaveCommand(copy, { flowsDir: 'flows', policyPath });
      expect(outcome.verdict).toBe('blocked');
      expect(outcome.exitCode).toBe(1);
      const reasons = outcome.wave.seamFindings.map((f) => `${f.reason}:${f.path}`).sort();
      expect(reasons).toContain('no-route:/tax');
      expect(reasons).toContain('dead-route:/legacy-rebate');
      expect(outcome.wave.flowFindings.map((f) => f.flowId)).toEqual(['rebate-settlement']);
      // The satisfied flow stays quiet.
      expect(outcome.wave.flowFindings.some((f) => f.flowId === 'order-to-invoice')).toBe(false);
    },
    HEAVY,
  );

  it(
    'the SAME estate with the seeds fixed → passed',
    async () => {
      const copy = join(scratch, 'workspace-fixed');
      cpSync(join(FIXTURES, 'workspace'), copy, { recursive: true });
      const pricing = join(copy, 'svc-pricing', 'srv', 'server.js');
      const src = readFileSync(pricing, 'utf8')
        .replace(/app\.get\('\/legacy-rebate'.*\n/, '')
        .replace(
          "app.get('/price', (_req, res) => res.json({ amount: 10 }));",
          "app.get('/price', (_req, res) => res.json({ amount: 10 }));\n" +
            "app.get('/tax', (_req, res) => res.json({ value: 2 }));",
        );
      writeFileSync(pricing, src);
      const outcome = await runWaveCommand(copy, { flowsDir: 'flows', policyPath });
      expect(outcome.verdict).toBe('passed');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.wave.flowFindings).toEqual([]);
    },
    HEAVY,
  );
});
