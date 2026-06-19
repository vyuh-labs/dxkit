/**
 * `vyuh-dxkit demo loop-guardrail` — a no-API, offline demonstration of the
 * Stop-gate.
 *
 * It needs no Claude Code session, no API key, and no scanner binaries: it
 * drives the REAL gate code path (`buildRepairMessage` + the exit-0
 * decision-block contract) over an example net-new finding, so a skeptic can
 * see exactly what the gate feeds an agent when it catches a regression —
 * without setting anything up. The finding is illustrative (a hardcoded
 * secret, which the default `security-only` preset blocks); the rendering is
 * production code, not a mock.
 */
import type { GuardrailJsonPayload } from '../baseline/check-renderers';
import { GUARDRAIL_JSON_SCHEMA } from '../baseline/check-renderers';
import { buildRepairMessage } from './stop-gate';
import * as logger from '../logger';

type DemoPair = GuardrailJsonPayload['pairs'][number];

/** A representative net-new finding for the demo: a hardcoded credential the
 *  agent introduced in a new payments module (blocked by `security-only`). */
const DEMO_FINDING: DemoPair = {
  status: 'added',
  blocks: true,
  warns: false,
  currentId: 'demo000000000001',
  confidence: 1,
  kind: 'secret',
  severity: 'critical',
  file: 'src/payments.js',
  line: 12,
  reasons: [
    { code: 'exact-id', detail: 'hardcoded credential introduced on this branch (gitleaks)' },
  ],
};

/** Build a complete, valid guardrail payload for the demo — `blocked: true`
 *  carries the example finding; `false` is the post-repair clean run. */
function demoPayload(blocked: boolean): GuardrailJsonPayload {
  const pairs = blocked ? [DEMO_FINDING] : [];
  return {
    schema: GUARDRAIL_JSON_SCHEMA,
    verdict: { blocks: blocked, warns: false, exitCode: blocked ? 1 : 0 },
    baseline: {
      name: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
      commitSha: 'demo000',
      branch: 'main',
      findingsCount: 184,
      mode: {
        value: 'committed-full',
        source: 'demo',
        explanation: 'illustrative baseline for the offline demo',
      },
    },
    current: {
      commitSha: 'demo001',
      branch: 'feature/payments',
      findingsCount: blocked ? 185 : 184,
    },
    matcher: { gitAware: true },
    envelopeDrift: {
      toolchainHashChanged: false,
      policyHashChanged: false,
      ignoreHashChanged: false,
      configHashChanged: false,
      dxkitVersionChanged: false,
      toolVersionDiffs: [],
      coverageDrift: [],
    },
    policy: {
      mode: 'brownfield',
      block: [],
      warn: ['uncertain'],
      confidence: { critical: 0.75, high: 0.8, medium: 0.85, low: 0.9 },
      blockRules: {
        newSecret: true,
        newCriticalSecurity: true,
        newHighSecurity: true,
        newCriticalDependencyVulnerability: true,
        newHighReachableDependencyVulnerability: true,
        newUntestedChangedSource: false,
        newSevereQualityIssueInChangedFiles: false,
      },
    },
    summary: {
      pairs: pairs.length,
      blocking: blocked ? 1 : 0,
      suppressed: 0,
      warning: 0,
      persisted: 184,
      resolved: 0,
    },
    pairs,
  };
}

/**
 * Render the demo. Pure of process exit; returns the text blocks so a test can
 * assert on them. The CLI wrapper prints + exits 0.
 */
export function renderLoopGuardrailDemo(): { blockMessage: string; lines: string[] } {
  const blocked = demoPayload(true);
  const blockMessage = buildRepairMessage(blocked);
  const lines: string[] = [];
  lines.push('This is what the dxkit Stop-gate does when a coding loop tries to stop.');
  lines.push('No Claude Code session, no API key, no scanners — just the gate.');
  return { blockMessage, lines };
}

/** CLI entry for `vyuh-dxkit demo loop-guardrail`. */
export async function runLoopGuardrailDemo(): Promise<void> {
  const { blockMessage } = renderLoopGuardrailDemo();

  logger.header('vyuh-dxkit demo: loop guardrail');
  logger.dim(
    'A no-API, offline walkthrough of the Stop-gate blocking a loop and the agent repairing.',
  );
  console.log(''); // slop-ok

  // 1. The loop declares done with a net-new finding.
  logger.info('agent ▸ Done — added the payments module.');
  console.log(''); // slop-ok

  // 2. The gate runs on Stop and BLOCKS, feeding the model the repair message.
  logger.fail('dxkit Stop-gate ▸ BLOCKED — completion withheld');
  console.log(''); // slop-ok
  for (const line of blockMessage.split('\n')) logger.dim('  ' + line);
  console.log(''); // slop-ok
  logger.dim(
    '  (delivered to the model as an exit-0 {"decision":"block","reason":…} — a warm-context repair instruction)',
  );
  console.log(''); // slop-ok

  // 3. The agent repairs and tries to stop again.
  logger.info('agent ▸ Moved the key to an env var and added a test. Done.');
  console.log(''); // slop-ok

  // 4. The gate re-runs and allows the clean stop.
  logger.success('dxkit Stop-gate ▸ CLEAN — loop may stop');
  console.log(''); // slop-ok

  logger.dim(
    'Blocked and repaired inside the same warm loop. Same verdict every time, in seconds, offline.',
  );
  logger.dim(
    'Wire it into your own loop: `vyuh-dxkit init --claude-loop` → `vyuh-dxkit loop doctor`.',
  );
  process.exit(0);
}
