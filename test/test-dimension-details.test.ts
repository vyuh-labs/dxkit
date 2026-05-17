import { describe, expect, it } from 'vitest';
import { scoreTestsDimension } from '../src/analyzers/tests/shallow';
import { withInput, testFrameworkCapability, coverageCapability } from './fixtures/score-input';

describe('scoreTestsDimension — details prose surfaces capability state', () => {
  it('renders "Framework: not detected" when no test-framework capability is present', () => {
    const input = withInput({ metrics: { testFiles: 3, sourceFiles: 10 } });
    const r = scoreTestsDimension(input);
    expect(r.details).toContain('Framework: not detected');
  });

  it('renders the framework name when the capability is populated', () => {
    const input = withInput({
      metrics: { testFiles: 3, sourceFiles: 10 },
      capabilities: { testFramework: testFrameworkCapability('jest') },
    });
    const r = scoreTestsDimension(input);
    expect(r.details).toContain('Framework: jest');
    expect(r.details).not.toContain('not detected');
  });

  it('appends a coverage-actionable hint when tests are detected but neither executed nor measured', () => {
    const input = withInput({
      metrics: { testFiles: 3, sourceFiles: 10, testsPass: null },
    });
    const r = scoreTestsDimension(input);
    expect(r.details).toContain('vyuh-dxkit coverage');
  });

  it('does not append the coverage-actionable hint when coverage data is already present', () => {
    const input = withInput({
      metrics: { testFiles: 3, sourceFiles: 10, testsPass: null },
      capabilities: { coverage: coverageCapability(72) },
    });
    const r = scoreTestsDimension(input);
    expect(r.details).not.toContain('vyuh-dxkit coverage');
    expect(r.details).toContain('Coverage: 72');
  });

  it('does not append the coverage-actionable hint when tests have actually run', () => {
    const input = withInput({
      metrics: { testFiles: 3, sourceFiles: 10, testsPass: true },
    });
    const r = scoreTestsDimension(input);
    expect(r.details).not.toContain('vyuh-dxkit coverage');
  });
});
