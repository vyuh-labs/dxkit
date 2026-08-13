/**
 * The generated `policy.schema.json` (decision A5) — the second UX rail
 * beside the commented scaffold. Editors that resolve the scaffold's
 * `$schema` stamp get autocomplete, hover docs, and value validation for
 * every knob; the hover text comes from the SAME metadata table that writes
 * the file comments and the guide anchors, so the three can never disagree.
 *
 * Deliberately permissive where it must be honest:
 *   - `additionalProperties` stays true at every level — a policy written
 *     for a NEWER dxkit must never red-squiggle under an older schema
 *     (forward compatibility is part of the policy contract), and unknown
 *     keys are preserved by every dxkit reader;
 *   - `remediate.agent.model` and other open-vocabulary fields carry NO
 *     enum — an enum of concrete model ids would be a hand-maintained
 *     drift list (the README-matrix class).
 *
 * Emitted at build time by `scripts/generate-policy-schema.js` into the
 * package root, which is exactly where the scaffold's local-path stamp
 * (`./node_modules/@vyuhlabs/dxkit/policy.schema.json`) points.
 */
import { POLICY_GUIDE_URL, paramMetaFor } from './policy-metadata';
import { knownTaskIds } from '../remediate/tasks';

type Schema = Record<string, unknown>;

/** Description string for a dotted path: the table's one-liner plus the full
 *  guide URL (editors render it as a link). Falls back to the given text for
 *  structural fields the table does not cover. */
function desc(path: string, fallback?: string): string {
  const meta = paramMetaFor(path);
  if (!meta) return fallback ?? '';
  return `${meta.summary} (${POLICY_GUIDE_URL}#${meta.anchor})`;
}

/** A string property, enum-constrained when the metadata table declares one. */
function stringProp(path: string, fallback?: string): Schema {
  const meta = paramMetaFor(path);
  return {
    type: 'string',
    description: desc(path, fallback),
    ...(meta?.enumValues ? { enum: [...meta.enumValues] } : {}),
  };
}

function boolProp(path: string, fallback?: string): Schema {
  return { type: 'boolean', description: desc(path, fallback) };
}

function obj(properties: Schema, description = ''): Schema {
  return {
    type: 'object',
    description,
    additionalProperties: true,
    properties,
  };
}

/** Build the JSON Schema document for `.dxkit/policy.json`. Pure. */
export function buildPolicySchema(version: string): Schema {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://github.com/vyuh-labs/dxkit/policy.schema.json`,
    title: `dxkit policy (dxkit ${version})`,
    description:
      `Guardrail posture for this repo. The file is JSONC: comments and trailing ` +
      `commas are welcome, and dxkit's own tools preserve them. Per-knob guide: ${POLICY_GUIDE_URL}`,
    type: 'object',
    additionalProperties: true,
    properties: {
      $schema: { type: 'string', description: 'Editor-schema stamp; written by the scaffold.' },
      extends: stringProp('extends'),
      id: {
        type: 'string',
        description:
          'Optional stable policy NAME (e.g. acme.dod.pkg). Carried on every verdict.v1 ' +
          'document alongside the content hash, so verdicts under different policies are ' +
          'distinguishable by name. Declaration-only — never changes what the policy does.',
      },
      version: {
        type: 'string',
        description:
          'Optional policy document version (paired with `id`). Bump when the DoD changes; ' +
          'two versions produce verdicts naming their own version.',
      },
      baseline: obj(
        {
          mode: stringProp('baseline.mode'),
          refreshCadence: stringProp('baseline.refreshCadence'),
          anchor: stringProp('baseline.anchor'),
          ref: { type: 'string', description: 'Ref-based mode: the ref the gate diffs against.' },
        },
        'Baseline capture + guardrail "before" side.',
      ),
      flow: obj(
        {
          mode: stringProp('flow.mode'),
          specs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Served-contract spec files (OpenAPI etc.) joined into the served side.',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: desc('flow.sources'),
          },
          stripUrlPrefixes: {
            type: 'array',
            items: { type: 'string' },
            description: 'URL prefixes stripped before consumed/served binding.',
          },
          blockThreshold: {
            type: 'number',
            description: 'Confidence at or above which a break blocks.',
          },
          onMergeRefresh: {
            type: 'boolean',
            description: 'Refresh the published contract on merge.',
          },
          refreshMode: {
            type: 'string',
            enum: ['pr', 'push'],
            description: 'How a contract refresh lands on the default branch.',
          },
        },
        'UI-to-API integration gate.',
      ),
      schema: obj(
        {
          mode: stringProp('schema.mode'),
          specs: {
            type: 'array',
            items: { type: 'string' },
            description: 'OpenAPI / JSON Schema documents whose models join the drift gate.',
          },
          blockThreshold: {
            type: 'number',
            description: 'Drift score at or above which a change blocks.',
          },
        },
        'Data-model drift gate.',
      ),
      duplication: obj(
        {
          mode: stringProp('duplication.mode'),
          minScore: {
            type: 'number',
            description: 'Similarity score in (0, 1] a block pair must reach to count.',
          },
          minBodyTokens: {
            type: 'number',
            description:
              'Functions with fewer AST tokens never enter seam pairing (default 0 — ' +
              'no floor). Opt-in for binding/adapter layers whose trivial delegating ' +
              'wrappers pair at 1.00 by design.',
          },
          loneSeams: {
            type: 'string',
            enum: ['warn', 'block'],
            description:
              'What a LONE net-new structural duplicate does under mode "block": ' +
              '"warn" (default — the precision floor) or "block" (opt-in: fail the ' +
              'build; allowlist kind code-reimplementation is the typed escape hatch).',
          },
        },
        'Copy-paste seam gate.',
      ),
      lint: obj(
        {
          enabled: boolProp('lint.enabled'),
          blocking: boolProp('lint.blocking'),
        },
        'Pack-declared linter as a gate citizen.',
      ),
      floor: obj(
        {
          required: boolProp('floor.required'),
        },
        'Correctness-floor posture for the gate command family (compile + tests as a ' +
          'verdict requirement).',
      ),
      checks: {
        type: 'array',
        description: desc('checks'),
        items: obj(
          {
            name: { type: 'string', description: 'Stable label; the finding identity key.' },
            command: {
              description: 'Command string (whitespace-split, no shell) or argv array.',
              anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            pattern: {
              type: 'string',
              description:
                'Declarative TEXT RULE: a regex dxkit evaluates per line over the tree itself — ' +
                'no command, no spawn (safe on untrusted trees; works on any language). One ' +
                'located finding per matching line. Declare `pattern` OR `command`, never both.',
            },
            flags: {
              type: 'string',
              description: "Regex flags for `pattern` (e.g. 'i'). g/y are stripped.",
            },
            globs: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Glob scope for `pattern` (`**`, `*`, `?`), matched against repo-relative POSIX ' +
                'paths. Absent scans every non-excluded file.',
            },
            blocking: { type: 'boolean', description: 'Net-new failure blocks (default true).' },
            required: {
              type: 'boolean',
              description:
                'The check must be OBSERVED for a certifiable verdict (default false). A ' +
                'required check that did not run (untrusted tree, missing toolchain, ' +
                'ref-based mode) turns the verdict into CANNOT GATE with the cause and ' +
                'remedy named, instead of a disclosed skip under PASSED.',
            },
            expectedExit: { type: 'number', description: 'Exit code meaning pass (default 0).' },
            parse: {
              description:
                "'exit' (binary pass/fail) or { regex } with named (?<file>)(?<line>)(?<rule>)(?<message>) groups.",
              anyOf: [{ type: 'string', enum: ['exit'] }, obj({ regex: { type: 'string' } })],
            },
          },
          'One user-declared invariant (a command, or a declarative text rule), run as a first-class gate citizen.',
        ),
      },
      pairedChecks: {
        type: 'array',
        description: desc('pairedChecks'),
        items: obj(
          {
            name: { type: 'string', description: 'Rule name; the finding identity.' },
            if: {
              type: 'array',
              items: { type: 'string' },
              description: 'Globs that trigger the rule when the change touches them.',
            },
            ifAdded: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Globs that trigger the rule only when the change ADDED a matching file ' +
                '(created; renames excluded) — for norms about new artifacts, e.g. a new ' +
                'component must ship with a guide. A rule needs `if` and/or `ifAdded`.',
            },
            then: {
              type: 'array',
              items: { type: 'string' },
              description: 'Globs the change must ALSO touch (deletions count).',
            },
            message: { type: 'string', description: 'Shown when the rule fires.' },
            blocking: { type: 'boolean', description: 'Fire as a block (default) or a warning.' },
          },
          'One "changing X requires also changing Y" rule.',
        ),
      },
      licenses: obj(
        {
          prohibited: {
            type: 'array',
            items: { type: 'string' },
            description: desc('licenses.prohibited'),
          },
        },
        'License posture for dependencies.',
      ),
      newAdvisories: obj(
        {
          blockSeverities: {
            type: 'array',
            items: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            description: desc('newAdvisories.blockSeverities'),
          },
          commentCommands: boolProp('newAdvisories.commentCommands'),
        },
        'Posture for advisories published after the baseline was captured.',
      ),
      depBump: obj(
        {
          enabled: boolProp('depBump.enabled'),
          allowMajor: boolProp('depBump.allowMajor'),
          schedule: stringProp('depBump.schedule'),
        },
        'Scheduled deterministic dependency-bump PRs.',
      ),
      expiryNotice: obj(
        {
          enabled: boolProp('expiryNotice.enabled'),
        },
        'One maintained issue naming allowlist suppressions about to lapse.',
      ),
      reports: obj(
        {
          onMerge: boolProp('reports.onMerge'),
        },
        'Report snapshots published on merge.',
      ),
      loop: obj(
        {
          preset: stringProp('loop.preset'),
          testCommand: {
            type: 'string',
            description: 'Postflight test command the Stop-gate runs (defaults per pack).',
          },
        },
        'Autonomous-loop Stop-gate.',
      ),
      remediate: obj(
        {
          enabled: boolProp('remediate.enabled'),
          tasks: {
            type: 'array',
            // Derived from the task registry — never a hand-copied list.
            items: { type: 'string', enum: [...knownTaskIds()] },
            description: desc('remediate.tasks'),
          },
          schedule: stringProp('remediate.schedule'),
          salvage: stringProp('remediate.salvage'),
          agent: obj(
            {
              driver: stringProp('remediate.agent.driver'),
              model: stringProp('remediate.agent.model'),
              budget: obj(
                {
                  maxTurns: {
                    type: 'number',
                    description: desc('remediate.agent.budget.maxTurns'),
                  },
                  maxMinutes: {
                    type: 'number',
                    description: desc('remediate.agent.budget.maxMinutes'),
                  },
                  maxUsd: { type: 'number', description: desc('remediate.agent.budget.maxUsd') },
                },
                "Hard caps, all enforced by the runner (never the agent's self-report).",
              ),
            },
            'Which agent runs, at which capability tier, under which caps.',
          ),
          taskBudgets: {
            type: 'object',
            description:
              'Per-task budget overrides merged over agent.budget (e.g. give fix-build ' +
              'more headroom than fix-lint). Keys are task ids; values are partial ' +
              '{maxTurns, maxMinutes, maxUsd}.',
            additionalProperties: {
              type: 'object',
              properties: {
                maxTurns: { type: 'number' },
                maxMinutes: { type: 'number' },
                maxUsd: { type: 'number' },
              },
            },
          },
          maxSpendPerRun: {
            type: 'number',
            description:
              'Run-level USD ceiling across the per-task matrix (0/absent = none). Tasks ' +
              'beyond it are deferred to the next firing, in order, and disclosed.',
          },
          maxDispatchBudget: {
            type: 'number',
            description:
              'The dispatch spend authority: the most a workflow_dispatch campaign may raise ' +
              'maxUsd to, and the same authority clamps max_turns proportionally (turns govern ' +
              'real spend when the driver cannot enforce cost mid-run). 0/absent = dispatch ' +
              'can lower budgets but never raise them beyond the policy caps.',
          },
          resume: {
            type: 'boolean',
            description:
              'Opt-in: continue a prior budget-bounded or guardrail-blocked attempt from its ' +
              'draft-PR salvage branch instead of starting over (requires the effective ' +
              'per-task salvage to be draft-pr; capped resumes with a durable attempt ' +
              'counter; entry floor stays anchored to the pristine base).',
          },
        },
        'Agentic remediation: a scheduled agent inside the verified frame.',
      ),
      graph: obj(
        {
          refresh: stringProp('graph.refresh'),
        },
        'Code-graph plumbing.',
      ),
    },
  };
}
