/**
 * Security finding gatherers — one function per tool, no overlap.
 *
 * Tool boundaries:
 *   gitleaks   → secrets (hardcoded credentials, API keys, private keys in source)
 *   find/git   → private key files on disk (.key, .pem), .env tracked in git
 *   semgrep    → code patterns (eval, exec, TLS, CORS, SQLi, XSS, SSRF, etc.)
 *   dispatcher → dependency CVEs across every active language pack
 *                (Phase 10e.B.1 — was hardcoded to npm-audit only)
 */
import { detect } from '../../detect';
import { run } from '../tools/runner';
import { findTool, TOOL_DEFS, getSemgrepRulesets } from '../tools/tool-registry';
import { getFindExcludeFlags, getSemgrepExcludeFlags, isExcludedPath } from '../tools/exclusions';
import { SecurityFinding, DepVulnSummary } from './types';
import { defaultDispatcher } from '../dispatcher';
import { detectActiveLanguages } from '../../languages';
import { DEP_VULNS } from '../../languages/capabilities/descriptors';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { DepVulnResult } from '../../languages/capabilities/types';

// ─── gitleaks: secrets ───────────────────────────────────────────────────────

interface GitleaksEntry {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
}

export function gatherSecrets(cwd: string): {
  findings: SecurityFinding[];
  toolUsed: string | null;
} {
  const status = findTool(TOOL_DEFS.gitleaks, cwd);
  if (!status.available || !status.path) return { findings: [], toolUsed: null };

  const reportPath = `/tmp/dxkit-gitleaks-${Date.now()}.json`;
  run(
    `${status.path} detect --source '${cwd}' --report-format json --report-path '${reportPath}' --no-git --exit-code 0 2>/dev/null`,
    cwd,
    120000,
  );
  const raw = run(`cat '${reportPath}' 2>/dev/null`, cwd);
  run(`rm -f '${reportPath}'`, cwd);

  if (!raw) return { findings: [], toolUsed: 'gitleaks' };

  try {
    const entries = JSON.parse(raw) as GitleaksEntry[];
    if (!Array.isArray(entries)) return { findings: [], toolUsed: 'gitleaks' };

    // Post-filter via the centralized exclusions predicate so we never drift
    // between tools on what counts as "ignored".
    const findings: SecurityFinding[] = entries
      .filter((e) => {
        const relPath = e.File.replace(cwd + '/', '').replace(cwd, '');
        return !isExcludedPath(cwd, relPath);
      })
      .map((e) => ({
        severity: e.RuleID === 'private-key' ? ('critical' as const) : ('high' as const),
        category: 'secret' as const,
        cwe: 'CWE-798',
        rule: e.RuleID,
        title: e.Description,
        file: e.File.replace(cwd + '/', '').replace(cwd, ''),
        line: e.StartLine,
        tool: 'gitleaks',
      }));

    return { findings, toolUsed: 'gitleaks' };
  } catch {
    return { findings: [], toolUsed: 'gitleaks' };
  }
}

// ─── find/git: private key files, .env in git ───────────────────────────────

export function gatherFileFindings(cwd: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const EXCLUDE = getFindExcludeFlags(cwd, false); // don't exclude source paths for security scanning

  // Private key / cert files on disk
  const keyFiles = run(`find . \\( -name "*.key" -o -name "*.pem" \\) ${EXCLUDE} 2>/dev/null`, cwd);
  if (keyFiles) {
    for (const f of keyFiles.split('\n').filter((l) => l.trim())) {
      findings.push({
        severity: 'critical',
        category: 'secret',
        cwe: 'CWE-798',
        rule: 'private-key-file',
        title: `Private key or certificate file: ${f.replace('./', '')}`,
        file: f.replace('./', ''),
        line: 0,
        tool: 'find',
      });
    }
  }

  // .env tracked in git
  const envFiles = run('git ls-files .env .env.* 2>/dev/null', cwd);
  if (envFiles) {
    for (const f of envFiles.split('\n').filter((l) => l.trim())) {
      findings.push({
        severity: 'high',
        category: 'config',
        cwe: 'CWE-798',
        rule: 'env-in-git',
        title: `.env file tracked in git: ${f}`,
        file: f,
        line: 0,
        tool: 'git',
      });
    }
  }

  return findings;
}

// ─── semgrep: code patterns ─────────────────────────────────────────────────

interface SemgrepResult {
  results: Array<{
    check_id: string;
    path: string;
    start: { line: number };
    extra: {
      message: string;
      severity: string;
      metadata?: {
        cwe?: string[];
        confidence?: string;
        impact?: string;
      };
    };
  }>;
}

function mapSeverity(sgSeverity: string, impact?: string): SecurityFinding['severity'] {
  // Primary: use semgrep's impact field (most meaningful)
  const imp = (impact || '').toUpperCase();
  if (imp === 'HIGH') return sgSeverity === 'ERROR' ? 'critical' : 'high';
  if (imp === 'MEDIUM') return 'medium';
  if (imp === 'LOW') return 'low';
  // Fallback: semgrep severity
  if (sgSeverity === 'ERROR') return 'high';
  if (sgSeverity === 'WARNING') return 'medium';
  return 'low';
}

export function gatherCodePatterns(cwd: string): {
  findings: SecurityFinding[];
  toolUsed: string | null;
} {
  const status = findTool(TOOL_DEFS.semgrep ?? ({} as never), cwd);
  if (!status.available || !status.path) return { findings: [], toolUsed: null };

  // Derive rulesets from detected stack — not hardcoded
  const stack = detect(cwd);
  const rulesets = getSemgrepRulesets(stack.languages);
  const configs = rulesets.map((r) => `--config ${r}`).join(' ');
  const excludes = getSemgrepExcludeFlags(cwd);

  const reportPath = `/tmp/dxkit-semgrep-${Date.now()}.json`;
  run(
    `${status.path} scan ${configs} --json --quiet --output '${reportPath}' ${excludes} '${cwd}' 2>/dev/null`,
    cwd,
    300000,
  );
  const raw = run(`cat '${reportPath}' 2>/dev/null`, cwd);
  run(`rm -f '${reportPath}'`, cwd);

  if (!raw) return { findings: [], toolUsed: 'semgrep' };

  try {
    const data = JSON.parse(raw) as SemgrepResult;
    if (!Array.isArray(data.results)) return { findings: [], toolUsed: 'semgrep' };

    const findings: SecurityFinding[] = data.results
      .filter((r) => {
        // Skip LOW confidence to cut false positives
        const conf = (r.extra.metadata?.confidence || '').toUpperCase();
        return conf !== 'LOW';
      })
      .map((r) => ({
        severity: mapSeverity(r.extra.severity, r.extra.metadata?.impact),
        category: 'code' as const,
        cwe: r.extra.metadata?.cwe?.[0]?.split(':')[0] || '',
        rule: r.check_id.split('.').slice(-1)[0],
        title: r.extra.message.split('\n')[0].slice(0, 200),
        file: r.path.replace(cwd + '/', '').replace(cwd, ''),
        line: r.start.line,
        tool: 'semgrep',
      }));

    return { findings, toolUsed: 'semgrep' };
  } catch {
    return { findings: [], toolUsed: 'semgrep' };
  }
}

// ─── dependency CVEs via the capabilities dispatcher ────────────────────────

const EMPTY_DEP_VULNS: DepVulnSummary = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  total: 0,
  tool: null,
};

/**
 * Aggregates dependency vulnerabilities across every active language pack
 * via the capability dispatcher. Replaces the prior hardcoded `npm audit`
 * implementation that silently ignored Python/Go/Rust/C# deps.
 *
 * Returns `EMPTY_DEP_VULNS` when no active pack exposes a depVulns
 * provider, or when every provider returned null (no tool installed
 * / nothing to audit).
 */
export async function gatherDepVulns(cwd: string): Promise<DepVulnSummary> {
  const providers: CapabilityProvider<DepVulnResult>[] = [];
  for (const lang of detectActiveLanguages(cwd)) {
    if (lang.capabilities?.depVulns) providers.push(lang.capabilities.depVulns);
  }
  if (providers.length === 0) return EMPTY_DEP_VULNS;

  const envelope = await defaultDispatcher.gather(cwd, DEP_VULNS, providers);
  if (!envelope) return EMPTY_DEP_VULNS;

  const { critical, high, medium, low } = envelope.counts;
  return {
    critical,
    high,
    medium,
    low,
    total: critical + high + medium + low,
    tool: envelope.tool,
  };
}
