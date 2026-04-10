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
 */
export function readProjectYaml(cwd: string): ResolvedConfig {
  const filePath = path.join(cwd, '.project.yaml');
  const raw = fs.readFileSync(filePath, 'utf-8');

  // Parse YAML manually (simple key-value parsing to avoid adding a yaml dep)
  const yaml = parseSimpleYaml(raw);

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

  const detected: DetectedStack = {
    languages: {
      python: langEnabled('python'),
      go: langEnabled('go'),
      node: langEnabled('node'),
      nextjs: langEnabled('nextjs'),
      rust: langEnabled('rust'),
      csharp: langEnabled('csharp'),
    },
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
    versions: {
      python: langs.python?.version ?? DEFAULT_VERSIONS.python,
      go: langs.go?.version ?? DEFAULT_VERSIONS.go,
      node: langs.node?.version ?? DEFAULT_VERSIONS.node,
      rust: langs.rust?.version ?? DEFAULT_VERSIONS.rust,
      csharp: langs.csharp?.version ?? DEFAULT_VERSIONS.csharp,
    },
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
