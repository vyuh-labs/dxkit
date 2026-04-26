import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig, DetectedStack } from './types';
import { DEFAULT_VERSIONS, DEFAULT_COVERAGE } from './constants';

/**
 * Schema for .project.yaml as written by @vyuhlabs/create-devstack.
 * Kept minimal — only the fields we need to build a ResolvedConfig.
 */
interface ProjectYaml {
  project: {
    name: string;
    description?: string;
  };
  languages?: Record<
    string,
    {
      enabled?: boolean;
      version?: string;
      quality?: {
        coverage?: number;
        lint?: boolean;
        typecheck?: boolean;
        format?: boolean;
      };
    }
  >;
  infrastructure?: Record<
    string,
    {
      enabled?: boolean;
      version?: string;
    }
  >;
  tools?: {
    claude_code?: boolean;
    github_cli?: boolean;
    docker?: boolean;
    precommit?: boolean;
    gcloud?: boolean;
    pulumi?: boolean;
    infisical?: boolean;
  };
}

/** Check if .project.yaml exists in the given directory. */
export function hasProjectYaml(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, '.project.yaml'));
}

/**
 * Read .project.yaml and build a ResolvedConfig from it.
 * This is the primary config source when create-devstack has already
 * written the file — dxkit skips detect() and prompts in this case.
 *
 * Returns null if the file is malformed or missing required fields
 * (project.name). The caller should fall back to detect() + prompts.
 */
export function readProjectYaml(cwd: string): ResolvedConfig | null {
  const filePath = path.join(cwd, '.project.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let yaml: ProjectYaml;
  try {
    yaml = parseSimpleYaml(raw);
  } catch {
    return null;
  }

  // project.name is required
  if (!yaml.project?.name) {
    return null;
  }

  const langs = yaml.languages ?? {};
  const infra = yaml.infrastructure ?? {};
  const tools = yaml.tools ?? {};

  const langEnabled = (name: string): boolean => langs[name]?.enabled ?? false;
  const infraEnabled = (name: string): boolean => infra[name]?.enabled ?? false;

  // Find coverage from first enabled language with quality settings
  let coverage = DEFAULT_COVERAGE;
  for (const lang of Object.values(langs)) {
    if (lang?.enabled && lang.quality?.coverage) {
      coverage = String(lang.quality.coverage);
      break;
    }
  }

  // YAML language keys — kept identical to `DetectedStack['languages']`
  // shape for now. Iteration here just dedupes the prior 6-line
  // langEnabled chain. The deeper refactor (single source of truth
  // across YAML + DetectedStack + DEFAULT_VERSIONS) is item #14 in the
  // LP audit, deferred to 10f.4 because it requires changing the
  // `DetectedStack.languages` interface from a fixed-shape object to
  // `Record<LanguageId, …>` — type-system surgery touching ~8
  // callsites, big enough to warrant its own PR.
  const LANG_KEYS = ['python', 'go', 'node', 'nextjs', 'rust', 'csharp'] as const;
  const VERSION_KEYS = ['python', 'go', 'node', 'rust', 'csharp'] as const;

  const detected: DetectedStack = {
    languages: Object.fromEntries(
      LANG_KEYS.map((k) => [k, langEnabled(k)]),
    ) as DetectedStack['languages'],
    infrastructure: {
      docker: tools.docker ?? true,
      postgres: infraEnabled('postgres'),
      redis: infraEnabled('redis'),
    },
    tools: {
      gcloud: tools.gcloud ?? false,
      pulumi: tools.pulumi ?? false,
      infisical: tools.infisical ?? false,
      ghCli: tools.github_cli ?? true,
    },
    projectName: yaml.project.name,
    projectDescription: yaml.project.description ?? '',
    versions: Object.fromEntries(
      VERSION_KEYS.map((k) => [k, langs[k]?.version ?? DEFAULT_VERSIONS[k]]),
    ) as DetectedStack['versions'],
    requiredTools: [],
  };

  return {
    ...detected,
    coverageThreshold: coverage,
    precommit: tools.precommit ?? true,
    qualityChecks: true,
    aiSessions: true,
    aiPrompts: true,
    claudeCode: tools.claude_code ?? true,
  };
}

/**
 * Minimal YAML parser for .project.yaml.
 * Handles the specific structure we expect — nested objects with scalar values.
 * Avoids adding a `yaml` npm dependency to dxkit (which has zero runtime deps).
 */
function parseSimpleYaml(raw: string): ProjectYaml {
  const lines = raw.split('\n');

  const result: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
    { indent: -1, obj: result },
  ];

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const valueStr = trimmed.slice(colonIdx + 1).trim();

    if (valueStr === '' || valueStr === '{}') {
      // Nested object (or empty object)
      const child: Record<string, unknown> = {};
      parent[key] = child;
      if (valueStr !== '{}') {
        stack.push({ indent, obj: child });
      }
    } else {
      // Scalar value
      parent[key] = parseScalar(valueStr);
    }
  }

  return result as unknown as ProjectYaml;
}

function parseScalar(value: string): string | number | boolean {
  // Remove surrounding quotes
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;
  return value;
}
