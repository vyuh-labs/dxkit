/**
 * `vyuh-dxkit baseline show` — pretty-print + filter the on-disk
 * baseline file.
 *
 * Three render modes share one loaded `BaselineFile`:
 *
 *   - **summary** (`baseline show` or `baseline show --summary`) —
 *     header (commit, branch, creation time, schema, dxkit version,
 *     salt mode) plus per-kind counts. The fast scan a developer
 *     reaches for to answer "what's the shape of this baseline?"
 *
 *   - **kind-filtered** (`baseline show --kind <X>`) — every entry
 *     matching the named kind, with locator + identity prefix. The
 *     drill-down for "show me every dep-vuln in this baseline."
 *
 *   - **JSON** (`baseline show --json [--kind <X>]`) — schema-banner-
 *     wrapped payload. Filter applies if specified. Designed for
 *     agents + CI consumers.
 *
 * Pure module — no I/O. The CLI layer loads the file via
 * `readBaselineFile` and routes the result through these renderers.
 */

import * as logger from '../logger';
import type { BaselineFile } from './baseline-file';
import type { BaselineEntry } from './types';

/**
 * JSON schema banner for the `baseline show --json` envelope.
 * Distinct from the raw `schemaVersion: 'dxkit-baseline/v1'` field
 * on the underlying file: this envelope is a *rendered view* and
 * may carry a filter discriminator the raw file doesn't.
 */
export const BASELINE_SHOW_SCHEMA = 'dxkit.baseline-show.v1' as const;

/**
 * The kinds a user can filter on. Mirror of the `BaselineEntry`
 * discriminant union — keeps the CLI's flag-validation aligned with
 * the storage shape.
 */
export const FILTER_KINDS: ReadonlyArray<BaselineEntry['kind']> = Object.freeze([
  'secret',
  'code',
  'config',
  'dep-vuln',
  'duplication',
  'coverage-gap',
  'test-gap',
  'hygiene',
  'license',
  'test-file-degradation',
  'god-file',
  'stale-file',
  'large-file',
  'secret-hmac',
]);

/** Result of parsing the user's `--kind` value. Returns `null` for
 *  unknown values so the CLI surfaces a helpful error including the
 *  full list of accepted kinds. */
export function parseKindFilter(raw: string): BaselineEntry['kind'] | null {
  return (FILTER_KINDS as ReadonlyArray<string>).includes(raw)
    ? (raw as BaselineEntry['kind'])
    : null;
}

/**
 * Render the summary view: header lines + per-kind counts table.
 * Always reports every kind that appears at least once; absent kinds
 * are omitted to keep the table compact.
 */
export function renderSummary(file: BaselineFile): string {
  const lines: string[] = [];
  lines.push(logger.bold(`Baseline '${file.name}'`));
  lines.push('');
  lines.push(`  Commit:      ${shortSha(file.repo.commitSha)} (${file.repo.branch || 'detached'})`);
  lines.push(`  Captured:    ${file.createdAt}`);
  lines.push(`  Schema:      ${file.schemaVersion}`);
  lines.push(`  dxkit:       ${file.analysis.dxkitVersion}`);
  lines.push(`  Salt:        ${file.saltMode}`);
  const toolNames = Object.keys(file.tools).sort();
  if (toolNames.length > 0) {
    lines.push(`  Tools:       ${toolNames.map((t) => `${t}@${file.tools[t]}`).join(', ')}`);
  }
  lines.push('');

  const counts = countByKind(file.findings);
  const total = file.findings.length;
  lines.push(logger.bold(`Findings: ${total} total`));
  if (total > 0) {
    const entries = Object.entries(counts) as Array<[BaselineEntry['kind'], number]>;
    entries.sort((a, b) => b[1] - a[1]);
    const widestKind = Math.max(...entries.map(([k]) => k.length));
    for (const [kind, count] of entries) {
      lines.push(`  ${kind.padEnd(widestKind)}   ${count.toString().padStart(5)}`);
    }
    lines.push('');
    lines.push(`  Filter to one kind: vyuh-dxkit baseline show --kind <kind>`);
  }
  return lines.join('\n');
}

/**
 * Render every entry matching `kind`. Each line carries the
 * identity prefix (first 12 chars — enough to distinguish entries
 * by eye without bloating the line), the locator info, and any
 * kind-specific discriminator.
 *
 * Returns the header + a notice when no entries match, rather than
 * an empty string, so the user always sees confirmation that the
 * filter ran.
 */
export function renderKind(file: BaselineFile, kind: BaselineEntry['kind']): string {
  const lines: string[] = [];
  const matching = file.findings.filter((e) => e.kind === kind);
  lines.push(logger.bold(`Baseline '${file.name}' — kind: ${kind}`));
  lines.push(`  Commit:      ${shortSha(file.repo.commitSha)}`);
  lines.push('');
  if (matching.length === 0) {
    lines.push(`  (no entries of kind '${kind}')`);
    return lines.join('\n');
  }
  lines.push(
    logger.bold(`${matching.length} ${kind} ${matching.length === 1 ? 'entry' : 'entries'}`),
  );
  lines.push('');
  for (const entry of matching) {
    lines.push(`  ${entry.id.slice(0, 12)}  ${describeEntry(entry)}`);
  }
  return lines.join('\n');
}

/**
 * Render the JSON envelope. Wraps the underlying file (full or
 * kind-filtered) in a top-level `schema` banner so consumers can
 * version-gate before reading. Filter discriminator is included
 * when present so consumers know whether they're seeing the full
 * findings list.
 */
export function renderJson(
  file: BaselineFile,
  options: { readonly kind?: BaselineEntry['kind'] } = {},
): {
  readonly schema: typeof BASELINE_SHOW_SCHEMA;
  readonly filter: { readonly kind: BaselineEntry['kind'] } | null;
  readonly baseline: BaselineFile;
  readonly summary: {
    readonly total: number;
    readonly byKind: Readonly<Partial<Record<BaselineEntry['kind'], number>>>;
  };
} {
  const findings = options.kind
    ? file.findings.filter((e) => e.kind === options.kind)
    : file.findings;
  const view: BaselineFile = { ...file, findings };
  return {
    schema: BASELINE_SHOW_SCHEMA,
    filter: options.kind ? { kind: options.kind } : null,
    baseline: view,
    summary: {
      total: findings.length,
      byKind: countByKind(findings),
    },
  };
}

/** Per-kind occurrence count. Mirror of the matcher's multiset
 *  semantics — duplicate identities count separately. */
function countByKind(
  entries: ReadonlyArray<BaselineEntry>,
): Readonly<Partial<Record<BaselineEntry['kind'], number>>> {
  const out: Partial<Record<BaselineEntry['kind'], number>> = {};
  for (const e of entries) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

/**
 * One-line locator + discriminator string for a baseline entry.
 * Kind-specific fields drive the format so a reader sees the
 * meaningful axis (file:line for source-anchored kinds,
 * package@version+advisory for dep-vulns, etc.).
 */
function describeEntry(entry: BaselineEntry): string {
  switch (entry.kind) {
    case 'secret':
    case 'code':
    case 'config':
      return `${entry.file}:${entry.line}  [${entry.tool}/${entry.rule}]`;
    case 'hygiene':
      return `${entry.file}:${entry.line}  [${entry.marker}]`;
    case 'dep-vuln':
      return `${entry.package}@${entry.installedVersion ?? '?'}  [${entry.advisoryId}]`;
    case 'duplication':
      return `${entry.fileA}:${entry.startLineA} <-> ${entry.fileB}:${entry.startLineB}  (${entry.lines} lines)`;
    case 'coverage-gap':
      return entry.symbol
        ? `${entry.file}:${entry.symbol}`
        : `${entry.file}:${entry.lineRange?.[0] ?? '?'}-${entry.lineRange?.[1] ?? '?'}`;
    case 'test-gap':
      return `${entry.file}  [risk: ${entry.risk}]`;
    case 'license':
      return `${entry.package}@${entry.version}  [${entry.licenseType}]`;
    case 'test-file-degradation':
      return `${entry.file}  [${entry.status}]`;
    case 'god-file':
    case 'large-file':
      return entry.file;
    case 'stale-file':
      return `${entry.file}  [.${entry.suffix}]`;
    case 'secret-hmac':
      return `[${entry.tool}/${entry.rule}]  hmac:${entry.hmac.slice(0, 12)}`;
    case 'stale-allow':
      return `${entry.file}:${entry.line}  [stale dxkit-allow:${entry.category}]`;
  }
}

function shortSha(sha: string): string {
  if (!sha) return '(no-commit)';
  return sha.slice(0, 8);
}
