/**
 * Shared minimal `ProducerContext` for the producer registry tests.
 *
 * Deliberately EMPTY of analyzer output: no `securityAggregate`, no test gaps,
 * no checks. That is the interesting state for the Rule 19 contract — it proves
 * every producer still declares its recall contexts when nothing ran, which is
 * exactly when a baseline's "clean" needs to be known-comparable rather than
 * assumed so.
 *
 * Lives in one file because both the contract test and the playbook test need
 * it, and two hand-maintained copies of a 60-field fixture drift the moment one
 * of them gains a field.
 */
import type { ProducerContext } from '../../src/baseline/producers';

export function producerFixtureContext(): ProducerContext {
  return {
    cwd: '/tmp/fixture',
    commitSha: '',
    salt: 'test-salt',
    analysisResult: {
      stack: {
        languages: {
          python: false,
          typescript: false,
          go: false,
          rust: false,
          csharp: false,
          kotlin: false,
          java: false,
          ruby: false,
        },
        infrastructure: { docker: false, postgres: false, redis: false },
        framework: undefined,
        testRunner: undefined,
        projectName: '',
        projectDescription: '',
        versions: {},
        requiredTools: [],
      } as unknown as ProducerContext['analysisResult']['stack'],
      capabilities: {},
      metrics: {
        largestFiles: [],
      } as unknown as ProducerContext['analysisResult']['metrics'],
      commitSha: '',
      branch: '',
      cwd: '/tmp/fixture',
      builtAt: '2026-05-18T00:00:00Z',
      dxkitVersion: '2.5.0',
      schemaVersion: 3,
      ignoreFileMtime: null,
      inputsDigest: null,
      workingTreeDirty: false,
    } as ProducerContext['analysisResult'],
    testGapsReport: {
      repo: '',
      analyzedAt: '',
      commitSha: '',
      branch: '',
      summary: {
        testFiles: 0,
        activeTestFiles: 0,
        commentedOutFiles: 0,
        effectiveCoverage: 0,
        coverageSource: 'filename-match',
        coverageFidelity: 'filename-match',
        sourceFiles: 0,
        untestedCritical: 0,
        untestedHigh: 0,
        untestedMedium: 0,
        untestedLow: 0,
      },
      testFiles: [],
      gaps: [],
      toolsUsed: [],
      toolsUnavailable: [],
    },
    hygiene: {
      staleFiles: [],
      todoCount: 0,
      fixmeCount: 0,
      hackCount: 0,
      consoleLogCount: 0,
      mixedLanguages: false,
    },
    rawSecrets: [],
    inlineAllowlistAnnotations: [],
    customCheckFindings: [],
    customCheckRecall: {},
  };
}
