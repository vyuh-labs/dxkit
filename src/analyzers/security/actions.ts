/**
 * Security remediation actions.
 *
 * Actions group findings by rule and describe the fix as a pure
 * `SecurityScoreInput` patch so `rank()` can simulate score deltas
 * against the canonical unified scorer.
 */
import { Evidence } from '../evidence';
import { RemediationAction } from '../remediation';
import { SecurityReport, SecurityFinding, Severity } from './types';
import { SecurityScoreInput } from './scoring';

/**
 * Project a SecurityReport into the canonical scoring input shape.
 *
 * Partitions findings by rule + category so each one contributes to
 * exactly one field — no double-counting. Rule strings are stable
 * contracts owned by the gather code (`gather.ts`); changes there
 * must keep these names in sync.
 */
export function countsFromReport(report: SecurityReport): SecurityScoreInput {
  let secretFindings = 0;
  let privateKeyFiles = 0;
  let envFilesInGit = 0;
  const codeFindings = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const f of report.findings) {
    if (f.rule === 'private-key-file') {
      privateKeyFiles++;
    } else if (f.rule === 'env-in-git') {
      envFilesInGit++;
    } else if (f.category === 'secret') {
      secretFindings++;
    } else if (f.category === 'code') {
      codeFindings[f.severity]++;
    }
    // Other categories are intentionally ignored by the scorer; the
    // partition above covers every category the gather code emits today
    // ('secret', 'code', 'config' — config is private-key-file/env-in-git
    // which are named above). Adding a new category requires a scoring
    // decision; silently bucketing into "other" would be the wrong default.
  }

  const d = report.summary.dependencies;
  return {
    secretFindings,
    privateKeyFiles,
    envFilesInGit,
    codeFindings,
    depVulns: {
      critical: d.critical,
      high: d.high,
      medium: d.medium,
      low: d.low,
    },
  };
}

/** Convert a finding into generic evidence. */
function findingToEvidence(f: SecurityFinding): Evidence {
  return {
    file: f.file,
    line: f.line,
    rule: f.rule,
    tool: f.tool,
    message: `${f.severity.toUpperCase()}: ${f.title}${f.cwe ? ` (${f.cwe})` : ''}`,
  };
}

/** Group findings by rule id; sorted within-group by severity then file. */
function groupByRule(findings: SecurityFinding[]): Map<string, SecurityFinding[]> {
  const groups = new Map<string, SecurityFinding[]>();
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  for (const f of findings) {
    const arr = groups.get(f.rule) || [];
    arr.push(f);
    groups.set(f.rule, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));
  }
  return groups;
}

/**
 * Build a patch that reduces the appropriate `SecurityScoreInput` field
 * for a group of findings sharing one rule. The unified scorer fields
 * map back to the gather-code categories:
 *   - rule === 'private-key-file'   → privateKeyFiles
 *   - rule === 'env-in-git'         → envFilesInGit
 *   - category === 'secret'         → secretFindings
 *   - category === 'code'           → codeFindings[severity]
 */
function patchForRuleGroup(
  rule: string,
  findings: SecurityFinding[],
): (cur: SecurityScoreInput) => SecurityScoreInput {
  if (rule === 'private-key-file') {
    return (cur) => ({ ...cur, privateKeyFiles: 0 });
  }
  if (rule === 'env-in-git') {
    return (cur) => ({ ...cur, envFilesInGit: 0 });
  }

  const category = findings[0]?.category;
  if (category === 'secret') {
    const n = findings.length;
    return (cur) => ({ ...cur, secretFindings: Math.max(0, cur.secretFindings - n) });
  }

  // Code findings: partition the group by severity, deduct each bucket.
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  return (cur) => ({
    ...cur,
    codeFindings: {
      critical: Math.max(0, cur.codeFindings.critical - bySeverity.critical),
      high: Math.max(0, cur.codeFindings.high - bySeverity.high),
      medium: Math.max(0, cur.codeFindings.medium - bySeverity.medium),
      low: Math.max(0, cur.codeFindings.low - bySeverity.low),
    },
  });
}

export function buildSecurityActions(
  report: SecurityReport,
): RemediationAction<SecurityScoreInput>[] {
  const actions: RemediationAction<SecurityScoreInput>[] = [];
  const groups = groupByRule(report.findings);

  // One action per rule group — fix ALL findings matching that rule.
  for (const [rule, findings] of groups) {
    const topSeverity = findings[0].severity;
    actions.push({
      id: `security.fix-${rule}`,
      title: `Fix ${findings.length} ${rule} finding${findings.length === 1 ? '' : 's'} (${topSeverity.toUpperCase()})`,
      rationale: `Rule ${rule} (${findings[0].tool}). ${findings[0].cwe || 'No CWE tag'}.`,
      evidence: findings.slice(0, 50).map(findingToEvidence),
      patch: patchForRuleGroup(rule, findings),
    });
  }

  // Dependency updates — one action covering all dep vulns.
  const d = report.summary.dependencies;
  if (d.total > 0 && d.tool) {
    actions.push({
      id: 'security.update-vulnerable-deps',
      title: `Update ${d.total} vulnerable dependenc${d.total === 1 ? 'y' : 'ies'} (${d.critical}C ${d.high}H ${d.medium}M ${d.low}L)`,
      rationale: `Run \`${d.tool} fix\` or bump affected packages. Most CVEs are fixed in newer minor versions.`,
      evidence: [
        {
          file: d.tool === 'npm-audit' ? 'package-lock.json' : 'requirements.txt',
          rule: 'dep-vuln',
          tool: d.tool,
          message: `${d.total} vulnerable dependencies`,
        },
      ],
      patch: (cur) => ({
        ...cur,
        depVulns: { critical: 0, high: 0, medium: 0, low: 0 },
      }),
    });
  }

  return actions;
}
