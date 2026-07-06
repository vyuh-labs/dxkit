/**
 * exceljs is an OPTIONAL dependency (optional peer + dxkit devDependency) so it
 * — and its vulnerable transitive uuid@8.3.2 — stays out of every consumer's
 * runtime tree. It's loaded lazily via `loadExcelJS` at the `--xlsx` call site.
 * This pins: the loader resolves the module when present (dxkit's own dev tree),
 * and the not-installed path is a typed, message-bearing error the CLI can
 * surface cleanly.
 */
import { describe, it, expect } from 'vitest';
import { loadExcelJS, XlsxUnavailableError } from '../src/analyzers/xlsx/exceljs-loader';

describe('exceljs lazy loader', () => {
  it('resolves the exceljs module (present in dxkit dev deps) with a Workbook constructor', async () => {
    const ExcelJS = await loadExcelJS();
    expect(typeof ExcelJS.Workbook).toBe('function');
    // It actually constructs — the runtime value, not just a type.
    expect(new ExcelJS.Workbook()).toBeTruthy();
  });

  it('XlsxUnavailableError carries an actionable, PM-neutral install hint', () => {
    const err = new XlsxUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('XlsxUnavailableError');
    expect(err.message).toContain('exceljs');
    expect(err.message).toContain('--xlsx');
    // PM-neutral: no npm-only command that would mislead a pnpm/yarn/bun user.
    expect(err.message).not.toMatch(/npm i|npm install/);
  });
});
