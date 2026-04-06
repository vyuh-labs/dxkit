export interface DetectedStack {
  languages: {
    python: boolean;
    go: boolean;
    node: boolean;
    nextjs: boolean;
    rust: boolean;
    csharp: boolean;
  };
  infrastructure: {
    docker: boolean;
    postgres: boolean;
    redis: boolean;
  };
  tools: {
    gcloud: boolean;
    pulumi: boolean;
    infisical: boolean;
    ghCli: boolean;
  };
  projectName: string;
  projectDescription: string;
  versions: {
    python?: string;
    go?: string;
    node?: string;
    rust?: string;
    csharp?: string;
  };
  testRunner?: {
    command: string; // e.g., "npx jest", "npx mocha", "npm test"
    framework: string; // e.g., "jest", "mocha", "vitest", "pytest"
    coverageCommand?: string; // e.g., "npx jest --coverage", "npx c8 npm test"
  };
  framework?: string; // e.g., "loopback", "express", "fastapi", "gin"
}

export interface ResolvedConfig extends DetectedStack {
  coverageThreshold: string;
  precommit: boolean;
  qualityChecks: boolean;
  aiSessions: boolean;
  aiPrompts: boolean;
  claudeCode: boolean;
}

export type GenerationMode = 'dx-only' | 'full';

export interface FileEntry {
  templatePath: string;
  outputPath: string;
  mode: GenerationMode;
  isTemplate: boolean;
  evolving: boolean;
  condition?: string;
  executable?: boolean;
}

export interface ManifestFileEntry {
  hash: string | null;
  evolving: boolean;
}

export interface Manifest {
  version: string;
  mode: GenerationMode;
  generatedAt: string;
  config: ResolvedConfig;
  files: Record<string, ManifestFileEntry>;
}

export interface InitOptions {
  mode: GenerationMode;
  force: boolean;
  yes: boolean;
  detect: boolean;
  name?: string;
}

export type WriteResult = 'created' | 'skipped' | 'overwritten';
