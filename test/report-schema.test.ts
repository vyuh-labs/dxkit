import { describe, it, expect } from 'vitest';
import { REPORT_SCHEMAS, stampSchema } from '../src/report-schema';

describe('REPORT_SCHEMAS', () => {
  it('uses the dxkit.<kind>.v1 banner convention for every report kind', () => {
    for (const [kind, banner] of Object.entries(REPORT_SCHEMAS)) {
      expect(banner, `${kind} banner`).toMatch(/^dxkit\.[a-z-]+\.v\d+$/);
    }
  });

  it('keeps detailed banners distinct from the headline-report banners', () => {
    expect(REPORT_SCHEMAS.health).not.toBe(REPORT_SCHEMAS['health-detailed']);
    expect(REPORT_SCHEMAS.vulnerabilities).not.toBe(REPORT_SCHEMAS['vulnerabilities-detailed']);
    expect(REPORT_SCHEMAS.bom).not.toBe(REPORT_SCHEMAS['bom-detailed']);
  });
});

describe('stampSchema', () => {
  it('prepends a schema field to the report envelope', () => {
    const report = { foo: 1, bar: 'baz' } as const;
    const out = stampSchema(report, 'health');
    expect(out.schema).toBe('dxkit.health-report.v1');
    expect(out.foo).toBe(1);
    expect(out.bar).toBe('baz');
  });

  it('does not mutate the input report', () => {
    const report = { foo: 1 };
    stampSchema(report, 'health');
    expect(report).toEqual({ foo: 1 });
    expect('schema' in report).toBe(false);
  });

  it('orders schema first in JSON serialization (human-readable)', () => {
    const out = stampSchema({ foo: 1 }, 'health');
    const json = JSON.stringify(out, null, 2);
    expect(json.indexOf('"schema"')).toBeLessThan(json.indexOf('"foo"'));
  });
});
