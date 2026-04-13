/**
 * Rust tool runner — clippy, cargo-audit.
 * Layer 1: language-specific tools for Rust projects.
 */
import { HealthMetrics } from '../types';
import { run, fileExists } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';

interface CargoMessage {
  reason: string;
  message?: {
    level: string; // 'warning' | 'error'
    message: string;
  };
}

interface CargoAuditResult {
  vulnerabilities?: {
    found: number;
    count: number;
    list?: Array<{ advisory?: { severity?: string } }>;
  };
}

/** Gather Rust-specific metrics. */
export function gatherRustMetrics(cwd: string): Partial<HealthMetrics> {
  const metrics: Partial<HealthMetrics> = {
    toolsUsed: [],
    toolsUnavailable: [],
  };

  // clippy
  const clippy = findTool(TOOL_DEFS.clippy, cwd);
  if (clippy.available) {
    const raw = run('cargo clippy --message-format json 2>/dev/null', cwd, 120000);
    if (raw) {
      let errors = 0;
      let warnings = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as CargoMessage;
          if (msg.reason === 'compiler-message' && msg.message) {
            if (msg.message.level === 'error') errors++;
            else if (msg.message.level === 'warning') warnings++;
          }
        } catch {
          /* skip non-JSON lines */
        }
      }
      metrics.lintErrors = errors;
      metrics.lintWarnings = warnings;
      metrics.lintTool = 'clippy';
      metrics.toolsUsed!.push('clippy');
    }
  } else {
    metrics.toolsUnavailable!.push('clippy');
  }

  // cargo-audit
  const audit = findTool(TOOL_DEFS['cargo-audit'], cwd);
  if (audit.available && audit.path) {
    const raw = run(`${audit.path} audit --json 2>/dev/null`, cwd, 60000);
    if (raw) {
      try {
        const data = JSON.parse(raw) as CargoAuditResult;
        if (data.vulnerabilities) {
          let critical = 0,
            high = 0,
            medium = 0,
            low = 0;
          for (const v of data.vulnerabilities.list || []) {
            const sev = v.advisory?.severity?.toLowerCase();
            if (sev === 'critical') critical++;
            else if (sev === 'high') high++;
            else if (sev === 'medium') medium++;
            else low++;
          }
          metrics.depVulnCritical = critical;
          metrics.depVulnHigh = high;
          metrics.depVulnMedium = medium;
          metrics.depVulnLow = low;
          metrics.depAuditTool = 'cargo-audit';
          metrics.toolsUsed!.push('cargo-audit');
        }
      } catch {
        metrics.toolsUnavailable!.push('cargo-audit (parse error)');
      }
    }
  } else {
    metrics.toolsUnavailable!.push('cargo-audit');
  }

  // Test framework detection
  if (fileExists(cwd, 'Cargo.toml')) {
    metrics.testFramework = 'cargo-test';
  }

  return metrics;
}
