/**
 * .http / .rest request-file reader (VS Code REST Client, JetBrains HTTP
 * client).
 *
 * The format is line-oriented: a request line is `<VERB> <url>` (an
 * optional `HTTP/1.1` suffix tolerated), requests separated by `###`
 * comments, `#`/`//` lines ignored, `{{variable}}` segments collapse to
 * `{var}` in the shared normalizer. The only reader with REAL line
 * numbers — these files are hand-authored, so a broken entry should point
 * at its line.
 *
 * Sides: 'consumed' only — a request file is calls someone makes.
 */

import type { ContractSourceParse, ContractSourceReader, RawConsumedCall } from './index';

const REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(\s+HTTP\/[\d.]+)?\s*$/i;

export const httpFileReader: ContractSourceReader = {
  kind: 'http',
  displayName: '.http request file',
  sides: 'consumed',
  defaultSide: 'consumed',
  sniff: (p) => p.endsWith('.http') || p.endsWith('.rest'),
  parse(content, filePath): ContractSourceParse {
    const consumed: RawConsumedCall[] = [];
    content.split(/\r?\n/).forEach((line, idx) => {
      const m = REQUEST_LINE.exec(line.trim());
      if (m) consumed.push({ method: m[1], url: m[2], file: filePath, line: idx + 1 });
    });
    return { consumed, served: [], errors: [] };
  },
};
