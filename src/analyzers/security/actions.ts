/**
 * Security remediation actions.
 *
 * Actions group findings by rule/category and describe the fix as a pure
 * SecurityCounts patch so rank() can simulate score deltas.
 */
import { Evidence } from '../evidence';
import { RemediationAction } from '../remediation';
import { SecurityReport, SecurityFinding, Severity } from './types';
import { SecurityCounts } from './scoring';

/** Project a SecurityReport into the counts shape used for scoring. */
export function countsFromReport(report: SecurityReport): SecurityCounts {
  const s = report.summary.findings;
  const d = report.summary.dependencies;
  return {
    critical: s.critical,
    high: s.high,
    medium: s.medium,
    low: s.low,
    depCritical: d.critical,
    depHigh: d.high,
    depMedium: d.medium,
    depLow: d.low,
  };
}

/** Deduct N findings of the given severity from counts, clamped to 0. */
function deductSeverity(
  counts: SecurityCounts,
  severity: Severity,
  n: number,
  depsOnly = false,
): SecurityCounts {
  const key = depsOnly
    ? (('dep' + severity[0].toUpperCase() + severity.slice(1)) as keyof SecurityCounts)
    : (severity as keyof SecurityCounts);
  return { ...counts, [key]: Math.max(0, counts[key] - n) };
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

export function buildSecurityActions(report: SecurityReport): RemediationAction<SecurityCounts>[] {
  const actions: RemediationAction<SecurityCounts>[] = [];
  const groups = groupByRule(report.findings);

  // One action per rule group — fix ALL findings matching that rule.
  for (const [rule, findings] of groups) {
    const topSeverity = findings[0].severity;
    const counts = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
    };

    actions.push({
      id: `security.fix-${rule}`,
      title: `Fix ${findings.length} ${rule} finding${findings.length === 1 ? '' : 's'} (${topSeverity.toUpperCase()})`,
      rationale: `Rule ${rule} (${findings[0].tool}). ${findings[0].cwe || 'No CWE tag'}.`,
      evidence: findings.slice(0, 50).map(findingToEvidence),
      patch: (c) => {
        let next = c;
        next = deductSeverity(next, 'critical', counts.critical);
        next = deductSeverity(next, 'high', counts.high);
        next = deductSeverity(next, 'medium', counts.medium);
        next = deductSeverity(next, 'low', counts.low);
        return next;
      },
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
      patch: (c) => ({
        ...c,
        depCritical: 0,
        depHigh: 0,
        depMedium: 0,
        depLow: 0,
      }),
    });
  }

  return actions;
}
