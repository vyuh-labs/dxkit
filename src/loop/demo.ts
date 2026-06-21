/**
 * `vyuh-dxkit demo loop-guardrail` — a REAL, offline run of the Stop-gate
 * against a generated sandbox repo.
 *
 * It needs no Claude Code session and no API key. When gitleaks is available
 * it creates a throwaway git repo, runs the REAL `baseline create`, introduces
 * a real hardcoded secret, and runs the REAL `guardrail check` — the same
 * commands a user runs — so a skeptic sees the gate actually block a real
 * net-new finding and then go clean after the fix. Nothing is canned, and the
 * user's own repo is never touched.
 *
 * When gitleaks is absent it falls back to a clearly-labelled illustration
 * built from the same production renderer (`buildRepairMessage`), and tells
 * the user how to run the real sandbox.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import type { GuardrailJsonPayload } from '../baseline/check-renderers';
import { GUARDRAIL_JSON_SCHEMA } from '../baseline/check-renderers';
import { buildRepairMessage } from './stop-gate';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import * as logger from '../logger';

type DemoPair = GuardrailJsonPayload['pairs'][number];

/** A representative net-new finding for the no-gitleaks illustration. The
 *  path is `example/` to make clear it is not a scan of the user's repo. */
const ILLUSTRATIVE_FINDING: DemoPair = {
  status: 'added',
  blocks: true,
  warns: false,
  currentId: 'demo000000000001',
  confidence: 1,
  kind: 'secret',
  severity: 'critical',
  file: 'example/payments.js',
  line: 12,
  reasons: [
    { code: 'exact-id', detail: 'hardcoded credential introduced on this branch (gitleaks)' },
  ],
};

/** Build a complete, valid guardrail payload for the illustration. */
function illustrativePayload(blocked: boolean): GuardrailJsonPayload {
  const pairs = blocked ? [ILLUSTRATIVE_FINDING] : [];
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
        explanation: 'illustrative baseline (gitleaks not installed; nothing was scanned)',
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
 * The illustration's repair message — the real production `buildRepairMessage`
 * over a representative single-secret payload. Pure of process I/O; returned
 * so a test can assert the production text path is exercised.
 */
export function renderLoopGuardrailDemo(): { blockMessage: string; lines: string[] } {
  const blockMessage = buildRepairMessage(illustrativePayload(true));
  return {
    blockMessage,
    lines: [
      'This is what the dxkit Stop-gate feeds an agent when it catches a regression.',
      'Illustration only — gitleaks is not installed, so nothing was scanned.',
    ],
  };
}

/** Assemble a realistic GitHub-PAT-shaped token at runtime, in fragments, so
 *  THIS source file never contains a contiguous secret literal (dxkit's own
 *  self-guardrail scans it). The full literal exists only in the transient
 *  sandbox file, where gitleaks is meant to catch it. */
function sandboxSecretLiteral(): string {
  const body = ['Xk7Qm2Rt9Zp4', 'Lw1Bn6Vc3Hf8', 'Dj5Gs0Yu2Ea0'].join('');
  return ['ghp', body].join('_');
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

/** Run the dxkit CLI itself against `cwd`. Uses the currently-running entry
 *  (`process.argv[1]`) so the demo exercises the exact same code a user runs,
 *  whether invoked via a local build or an installed binary. spawnSync never
 *  throws on a non-zero exit (a block is exit 1), so we always get stdout. */
function runCli(cwd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [process.argv[1], ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

/** The real, blocking secret findings, de-duplicated by location — gitleaks
 *  can match one credential under several rules, and dxkit also mints an
 *  internal cross-file `secret-hmac` identity for it. The demo headlines the
 *  leaked credential itself, so it reads as "one secret" rather than the raw
 *  multi-row scanner output. */
function uniqueSecretPairs(payload: GuardrailJsonPayload): DemoPair[] {
  const seen = new Set<string>();
  const out: DemoPair[] = [];
  for (const p of payload.pairs) {
    if (!p.blocks || p.kind !== 'secret') continue;
    const key = `${p.file}:${p.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** A display payload carrying only the headline secret findings, so the
 *  production `buildRepairMessage` renders a crisp "N net-new secret" block. */
function secretOnlyPayload(
  payload: GuardrailJsonPayload,
  secrets: DemoPair[],
): GuardrailJsonPayload {
  return {
    ...payload,
    verdict: { ...payload.verdict, blocks: true },
    summary: { ...payload.summary, pairs: secrets.length, blocking: secrets.length },
    pairs: secrets,
  };
}

/**
 * Run the real gate against a generated sandbox. Returns true when the full
 * block→clean walkthrough ran; false when it could not (caller falls back to
 * the illustration). Never throws.
 */
async function runRealSandboxDemo(): Promise<boolean> {
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-demo-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo-sandbox', version: '1.0.0', private: true }, null, 2) + '\n',
    );
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'payments.js'),
      'function charge(amount) {\n  return { ok: true, amount };\n}\nmodule.exports = { charge };\n',
    );
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'demo@dxkit.local']);
    git(dir, ['config', 'user.name', 'dxkit demo']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'initial clean state']);

    // Capture the clean baseline. --allow-incomplete because a throwaway
    // sandbox has no project linter toolchain installed; the secret scan
    // (gitleaks) is what this demo exercises and it IS available.
    // committed-full keeps it deterministic + offline (no visibility probe).
    logger.dim('  capturing a clean baseline of the sandbox…');
    const base = runCli(dir, ['baseline', 'create', '--mode=committed-full', '--allow-incomplete']);
    if (base.status !== 0) return false;

    // A coding loop "adds a feature" and leaves a hardcoded credential behind.
    const configPath = path.join(dir, 'src', 'config.js');
    fs.writeFileSync(
      configPath,
      `// added by the loop\nconst GITHUB_TOKEN = "${sandboxSecretLiteral()}";\nmodule.exports = { GITHUB_TOKEN };\n`,
    );
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'add payments config']);

    logger.dim('  running the real gate on the change…');
    const blocked = runCli(dir, ['guardrail', 'check', '--mode=committed-full', '--json']);
    const blockedPayload = JSON.parse(blocked.stdout) as GuardrailJsonPayload;
    const secrets = uniqueSecretPairs(blockedPayload);
    if (!blockedPayload.verdict.blocks || secrets.length === 0) {
      return false; // gitleaks present but didn't flag — fall back rather than confuse
    }
    const blockMessage = buildRepairMessage(secretOnlyPayload(blockedPayload, secrets));
    console.log(''); // slop-ok

    logger.info('a coding loop added a payments feature, then tried to stop:');
    logger.dim('  + src/config.js');
    logger.dim('      const GITHUB_TOKEN = "ghp_…"   // a hardcoded credential');
    console.log(''); // slop-ok
    logger.fail('dxkit Stop-gate ▸ BLOCKED — completion withheld');
    console.log(''); // slop-ok
    for (const line of blockMessage.split('\n')) logger.dim('  ' + line);
    console.log(''); // slop-ok
    logger.dim(
      '  (delivered to the loop as an exit-0 {"decision":"block","reason":…} repair instruction)',
    );
    console.log(''); // slop-ok

    // The fix: move the credential to an environment variable.
    fs.writeFileSync(
      configPath,
      '// added by the loop\nconst GITHUB_TOKEN = process.env.GITHUB_TOKEN;\nmodule.exports = { GITHUB_TOKEN };\n',
    );
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'move credential to env var']);

    logger.dim('  re-running the gate after the fix…');
    const clean = runCli(dir, ['guardrail', 'check', '--mode=committed-full', '--json']);
    const cleanPayload = JSON.parse(clean.stdout) as GuardrailJsonPayload;
    console.log(''); // slop-ok

    logger.info('the secret is moved to an env var, and the loop tries again:');
    logger.dim('  - const GITHUB_TOKEN = "ghp_…"');
    logger.dim('  + const GITHUB_TOKEN = process.env.GITHUB_TOKEN');
    console.log(''); // slop-ok
    if (uniqueSecretPairs(cleanPayload).length > 0) {
      logger.warn('dxkit Stop-gate ▸ still blocking — see findings above');
    } else {
      logger.success('dxkit Stop-gate ▸ CLEAN — loop may stop');
    }
    console.log(''); // slop-ok
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** Print the labelled illustration (no real scan). `reason` distinguishes
 *  "gitleaks missing" from "the sandbox run could not complete". */
function printIllustration(reason: 'no-gitleaks' | 'sandbox-failed'): void {
  const { blockMessage } = renderLoopGuardrailDemo();
  if (reason === 'no-gitleaks') {
    logger.warn('gitleaks not installed — showing an illustration, not a real scan.');
    logger.dim('  Install it (`vyuh-dxkit tools install`) and re-run to scan a real sandbox.');
  } else {
    logger.warn('Could not run the sandbox scan here — showing an illustration instead.');
  }
  console.log(''); // slop-ok
  logger.info('a coding loop added a feature and left a hardcoded credential behind:');
  console.log(''); // slop-ok
  logger.fail('dxkit Stop-gate ▸ BLOCKED — completion withheld');
  console.log(''); // slop-ok
  for (const line of blockMessage.split('\n')) logger.dim('  ' + line);
  console.log(''); // slop-ok
  logger.success('dxkit Stop-gate ▸ CLEAN — after the credential is moved to an env var');
  console.log(''); // slop-ok
}

/** CLI entry for `vyuh-dxkit demo loop-guardrail`. */
export async function runLoopGuardrailDemo(): Promise<void> {
  logger.header('vyuh-dxkit demo: loop guardrail');
  logger.dim('A real, offline run of the Stop-gate. No API key, no Claude Code.');
  console.log(''); // slop-ok

  const hasGitleaks = findTool(TOOL_DEFS.gitleaks, process.cwd()).available;
  const ranReal = hasGitleaks ? await runRealSandboxDemo() : false;

  if (ranReal) {
    logger.dim(
      'Real run against a generated sandbox repo — your repo was not touched, nothing committed to it.',
    );
  } else {
    printIllustration(hasGitleaks ? 'sandbox-failed' : 'no-gitleaks');
  }

  logger.dim('Run the same gate on your repo:');
  logger.dim('  npm init @vyuhlabs/dxkit -- --claude-loop --yes  →  vyuh-dxkit baseline create');
  process.exit(0);
}
