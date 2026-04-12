/**
 * Security finding gatherers — one function per tool, no overlap.
 *
 * Tool boundaries:
 *   gitleaks  → secrets (hardcoded credentials, API keys, private keys in source)
 *   find/git  → private key files on disk (.key, .pem), .env tracked in git
 *   semgrep   → code patterns (eval, exec, TLS, CORS, SQLi, XSS, SSRF, etc.)
 *   npm audit → dependency CVEs
 */
import * as fs from 'fs';
import * as path from 'path';
import { detect } from '../../detect';
import { run, fileExists } from '../tools/runner';
import { findTool, TOOL_DEFS, getSemgrepRulesets } from '../tools/tool-registry';
import { getFindExcludeFlags, getSemgrepExcludeFlags } from '../tools/exclusions';
import { SecurityFinding, DepVulnSummary } from './types';

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

    const findings: SecurityFinding[] = entries
      .filter(
        (e) =>
          !e.File.includes('/node_modules/') &&
          !e.File.includes('/dist/') &&
          !e.File.includes('.min.'),
      )
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
  const EXCLUDE = getFindExcludeFlags(false); // don't exclude source paths for security scanning

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
  const excludes = getSemgrepExcludeFlags();

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

// ─── npm audit: dependency CVEs ─────────────────────────────────────────────

interface NpmAuditV1 {
  metadata?: {
    vulnerabilities?: { critical?: number; high?: number; moderate?: number; low?: number };
  };
}
interface NpmAuditV2 {
  vulnerabilities?: Record<string, { severity: string }>;
}

function parseAuditJson(raw: string): { c: number; h: number; m: number; l: number } | null {
  try {
    const data = JSON.parse(raw) as NpmAuditV1 & NpmAuditV2;
    if (data.metadata?.vulnerabilities) {
      const v = data.metadata.vulnerabilities;
      return { c: v.critical || 0, h: v.high || 0, m: v.moderate || 0, l: v.low || 0 };
    }
    if (data.vulnerabilities) {
      let c = 0,
        h = 0,
        m = 0,
        l = 0;
      for (const v of Object.values(data.vulnerabilities)) {
        if (v.severity === 'critical') c++;
        else if (v.severity === 'high') h++;
        else if (v.severity === 'moderate') m++;
        else if (v.severity === 'low') l++;
      }
      return { c, h, m, l };
    }
    return null;
  } catch {
    return null;
  }
}

export function gatherDepVulns(cwd: string): DepVulnSummary {
  if (!fileExists(cwd, 'package.json'))
    return { critical: 0, high: 0, medium: 0, low: 0, total: 0, tool: null };

  const raw = run('npm audit --json 2>&1', cwd, 60000);
  const result = raw ? parseAuditJson(raw) : null;
  if (!result) return { critical: 0, high: 0, medium: 0, low: 0, total: 0, tool: null };

  return {
    critical: result.c,
    high: result.h,
    medium: result.m,
    low: result.l,
    total: result.c + result.h + result.m + result.l,
    tool: 'npm-audit',
  };
}
