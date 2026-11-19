/**
 * The one parser for API spec documents (OpenAPI 2.0/3.x, JSON Schema) that
 * dxkit reads as declared contracts: `flow.specs`, the `openapi` contract
 * source, and `schema.specs`. Specs are commonly kept as YAML; before this
 * module every reader called `JSON.parse`, so a YAML spec silently
 * contributed nothing (zero routes, zero models) while the docs invited
 * "point flow.specs at an OpenAPI document".
 *
 * The format follows the file extension: `.yaml` / `.yml` parse as YAML,
 * everything else as JSON (the historical behaviour, unchanged). Throws on
 * unparseable input; each caller keeps its own posture (fail-open to `[]`,
 * or an error line naming the file).
 */

import { parse as parseYaml } from 'yaml';

/** True when the path names a YAML document by extension. */
export function isYamlSpecPath(filePath: string): boolean {
  return /\.ya?ml$/i.test(filePath);
}

/** Parse spec text by the file's extension. Throws on invalid input. */
export function parseSpecDocument(content: string, filePath: string): unknown {
  return isYamlSpecPath(filePath) ? parseYaml(content) : JSON.parse(content);
}
