/**
 * The custom-check seam's POLICY types (`checks[]` + `lint`), split from
 * `policy.ts` at the large-file bar. `policy.ts` re-exports both, so every
 * existing consumer import keeps working — one definition, one home
 * (CLAUDE.md Rule 17 owns the runtime seam; these are its declarations).
 */

/**
 * One user-declared custom check in `.dxkit/policy.json:checks`. dxkit runs it
 * as a first-class gate citizen alongside its own scanners: it executes the
 * command, fingerprints each failure as a `custom-check` finding, and gates on
 * NET-NEW failures (a pre-existing failure is grandfathered) uniformly across
 * pre-push / CI / the loop Stop-gate. dxkit becomes the gate runner for ALL of a
 * repo's invariants, not just its own scanners.
 *
 * SECURITY: the command is executed. It comes ONLY from the repo's own committed
 * policy.json — the same trust boundary as the repo's npm scripts / CI config.
 * dxkit never runs a check from a CLI flag or any untrusted source.
 *
 * Schema example:
 *
 *   {
 *     "checks": [
 *       { "name": "check:seam", "command": "npm run check:seam" },
 *       { "name": "licenses", "command": ["make", "check-licenses"], "blocking": false },
 *       {
 *         "name": "custom-lint",
 *         "command": "npx eslint . -f unix",
 *         "parse": { "regex": "^(?<file>[^:]+):(?<line>\\d+):\\d+:\\s+(?<message>.*?)\\s+\\[(?<rule>[^\\]]+)\\]$" }
 *       }
 *     ]
 *   }
 */
export interface CustomCheckConfig {
  /** Stable label — becomes the finding's durable identity key. `lint:*` is
   *  reserved for pack-declared built-in lint. */
  readonly name: string;
  /** The command: a single string (whitespace-split; no shell — for a pipeline
   *  use a script) or an argv array. */
  readonly command: string | readonly string[];
  /** Net-new failure blocks (default true) or only warns (false). */
  readonly blocking?: boolean;
  /** Exit code meaning "pass" (default 0). */
  readonly expectedExit?: number;
  /** Output→findings extraction. `'exit'` (default): one binary finding per
   *  failure. `{ regex }`: one located finding per matching line, via named
   *  `(?<file>)(?<line>)(?<rule>)(?<message>)` capture groups. */
  readonly parse?: 'exit' | { readonly regex: string };
}

/**
 * `.dxkit/policy.json:lint` — opt-in gating on pack-declared built-in lint
 * (`LanguageSupport.lint`). Off by default: a lint gate is noisy on a repo that
 * hasn't opted in, so it ships dormant. When enabled, dxkit synthesizes a
 * `lint:<pack>` custom check per active language pack, running through the SAME
 * runner as user checks (lint is a consumer of the custom-check seam, not a
 * parallel path).
 */
export interface LintPolicy {
  /** Turn on pack-declared lint gating (default false). */
  readonly enabled?: boolean;
  /** Net-new lint findings block (default false — warn only). */
  readonly blocking?: boolean;
}
