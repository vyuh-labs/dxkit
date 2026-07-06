/**
 * dxkit's bundled ESLint formatter — reproduces the old core `unix` format.
 *
 * ESLint v9 removed the built-in `unix` (and `compact`, `visualstudio`, …)
 * formatters from core; `eslint --format unix` now prints "The unix formatter
 * is no longer part of core ESLint" and emits nothing parseable. The TS lint
 * gate points `--format` at THIS file (by absolute path derived from dxkit's
 * install dir), so the gate's per-line parse (`TS_ESLINT_UNIX_PARSE`) keeps
 * working on ESLint 8 AND 9 with no extra install.
 *
 * Output line shape (matches TS_ESLINT_UNIX_PARSE):
 *   <repo-relative-file>:<line>:<col>: <message> [<Error|Warning>/<ruleId>]
 *
 * Paths are relativized to the process cwd (the repo root the gate runs in) so
 * the finding's identity is portable across machines — an absolute path would
 * make the fingerprint machine-specific and break baseline matching in CI.
 *
 * CommonJS + `.cjs` because ESLint loads a formatter file via require(); it is
 * a runtime asset, never imported by dxkit's TypeScript.
 */
const path = require('path');

module.exports = (results) => {
  const cwd = process.cwd();
  const out = [];
  for (const result of results) {
    const file = path.relative(cwd, result.filePath) || result.filePath;
    for (const m of result.messages) {
      const severity = m.severity === 2 ? 'Error' : 'Warning';
      const rule = m.ruleId || 'unknown';
      out.push(`${file}:${m.line || 0}:${m.column || 0}: ${m.message} [${severity}/${rule}]`);
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
};
