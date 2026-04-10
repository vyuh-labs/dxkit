import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasProjectYaml, readProjectYaml } from '../src/project-yaml';

describe('hasProjectYaml', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-pyaml-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when .project.yaml does not exist', () => {
    expect(hasProjectYaml(tmpDir)).toBe(false);
  });

  it('returns true when .project.yaml exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.project.yaml'), 'project:\n  name: test\n');
    expect(hasProjectYaml(tmpDir)).toBe(true);
  });
});

describe('readProjectYaml', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-pyaml-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string): void {
    fs.writeFileSync(path.join(tmpDir, '.project.yaml'), content);
  }

  it('returns null for empty file', () => {
    writeYaml('');
    expect(readProjectYaml(tmpDir)).toBeNull();
  });

  it('returns null when project.name is missing', () => {
    writeYaml(`
project:
  description: 'no name'
`);
    expect(readProjectYaml(tmpDir)).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    writeYaml('this is not valid yaml: [[[');
    // Should not throw — returns null
    expect(readProjectYaml(tmpDir)).toBeNull();
  });

  it('reads project name and description', () => {
    writeYaml(`
project:
  name: my-app
  description: 'A web API'
languages: {}
infrastructure: {}
tools: {}
`);
    const config = readProjectYaml(tmpDir)!;
    expect(config).not.toBeNull();
    expect(config!.projectName).toBe('my-app');
    expect(config!.projectDescription).toBe('A web API');
  });

  it('maps enabled languages to DetectedStack flags', () => {
    writeYaml(`
project:
  name: test
languages:
  python:
    enabled: true
    version: '3.11'
  go:
    enabled: true
    version: '1.22.0'
  node:
    enabled: false
    version: '20'
`);
    const config = readProjectYaml(tmpDir)!;
    expect(config.languages.python).toBe(true);
    expect(config.languages.go).toBe(true);
    expect(config.languages.node).toBe(false);
    expect(config.languages.rust).toBe(false);
    expect(config.versions.python).toBe('3.11');
    expect(config.versions.go).toBe('1.22.0');
  });

  it('maps infrastructure settings', () => {
    writeYaml(`
project:
  name: test
infrastructure:
  postgres:
    enabled: true
    version: '15'
  redis:
    enabled: false
    version: '7'
`);
    const config = readProjectYaml(tmpDir)!;
    expect(config.infrastructure.postgres).toBe(true);
    expect(config.infrastructure.redis).toBe(false);
  });

  it('maps tool settings', () => {
    writeYaml(`
project:
  name: test
tools:
  claude_code: true
  github_cli: true
  docker: true
  precommit: false
  gcloud: true
  pulumi: false
  infisical: false
`);
    const config = readProjectYaml(tmpDir)!;
    expect(config.claudeCode).toBe(true);
    expect(config.tools.ghCli).toBe(true);
    expect(config.infrastructure.docker).toBe(true);
    expect(config.precommit).toBe(false);
    expect(config.tools.gcloud).toBe(true);
    expect(config.tools.pulumi).toBe(false);
  });

  it('reads coverage from first enabled language quality', () => {
    writeYaml(`
project:
  name: test
languages:
  python:
    enabled: true
    version: '3.12'
    quality:
      coverage: 95
      lint: true
`);
    const config = readProjectYaml(tmpDir)!;
    expect(config.coverageThreshold).toBe('95');
  });

  it('defaults coverage to 80 when no quality settings', () => {
    writeYaml(`
project:
  name: test
languages:
  python:
    enabled: true
    version: '3.12'
`);
    const config = readProjectYaml(tmpDir)!;
    expect(config.coverageThreshold).toBe('80');
  });

  it('handles full config from create-devstack', () => {
    writeYaml(`
project:
  name: inventory-api
  description: 'A web API for managing inventory'
languages:
  python:
    enabled: true
    version: '3.12'
    quality:
      coverage: 85
      lint: true
      typecheck: true
      format: true
  go:
    enabled: true
    version: '1.24.0'
    quality:
      coverage: 80
      lint: true
infrastructure:
  postgres:
    enabled: true
    version: '16'
  redis:
    enabled: true
    version: '7'
tools:
  claude_code: true
  github_cli: true
  docker: true
  precommit: true
  gcloud: false
  pulumi: false
  infisical: false
`);
    const config = readProjectYaml(tmpDir)!;

    // Project
    expect(config.projectName).toBe('inventory-api');
    expect(config.projectDescription).toBe('A web API for managing inventory');

    // Languages
    expect(config.languages.python).toBe(true);
    expect(config.languages.go).toBe(true);
    expect(config.languages.node).toBe(false);
    expect(config.versions.python).toBe('3.12');
    expect(config.versions.go).toBe('1.24.0');

    // Infrastructure
    expect(config.infrastructure.postgres).toBe(true);
    expect(config.infrastructure.redis).toBe(true);
    expect(config.infrastructure.docker).toBe(true);

    // Tools
    expect(config.claudeCode).toBe(true);
    expect(config.precommit).toBe(true);
    expect(config.tools.gcloud).toBe(false);

    // Quality
    expect(config.coverageThreshold).toBe('85');
    expect(config.qualityChecks).toBe(true);
  });
});
