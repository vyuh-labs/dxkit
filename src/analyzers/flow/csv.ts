/**
 * CSV renderers over a `FlowModel` — the parity output surface (mirrors the
 * reference tool's `api_data` / `controller_data` / `api_controller_mapping`
 * CSVs). Pure: a model in, CSV text out. CSV is one renderer among several
 * (the graph + the gate consume the same model), so nothing analytical lives
 * here — only serialization.
 */

import type { FlowModel } from './model';

/** Quote every field (CSV-safe: doubles embedded quotes), join a row. */
function row(fields: ReadonlyArray<string | number | null>): string {
  return fields.map((f) => `"${String(f ?? '').replace(/"/g, '""')}"`).join(',');
}

function toCsv(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
): string {
  return [row(header), ...rows.map(row)].join('\n') + '\n';
}

/** Outbound HTTP calls (the consumed side). */
export function callsCsv(model: FlowModel): string {
  return toCsv(
    ['method', 'path', 'raw_url', 'receiver', 'file', 'line'],
    model.calls.map((c) => [c.method, c.path, c.rawUrl, c.receiver, c.file, c.line]),
  );
}

/** Served routes (the served side), from source extraction and/or a spec. */
export function routesCsv(model: FlowModel): string {
  return toCsv(
    ['method', 'path', 'via', 'handler', 'file', 'line'], // arch-shape-ok: CSV column name, not a role label
    model.routes.map((r) => [r.method, r.path, r.via, r.handler, r.file, r.line]),
  );
}

/** The join: each client call mapped to the route it targets (or not). */
export function mappingCsv(model: FlowModel): string {
  return toCsv(
    [
      'call_method',
      'call_path',
      'call_file',
      'call_line',
      'reason',
      'confidence',
      'route_path',
      'route_handler',
      'route_via',
      'route_file',
    ],
    model.bindings.map((b) => [
      b.call.method,
      b.call.path,
      b.call.file,
      b.call.line,
      b.reason,
      b.confidence,
      b.route?.path ?? '',
      b.route?.handler ?? '',
      b.route?.via ?? '',
      b.route?.file ?? '',
    ]),
  );
}

/** The full parity CSV set, keyed by output filename. */
export function flowCsvFiles(model: FlowModel): Record<string, string> {
  return {
    'api_calls.csv': callsCsv(model),
    'routes.csv': routesCsv(model),
    'api_route_mapping.csv': mappingCsv(model),
  };
}
