/**
 * Slop-score remediation actions.
 *
 * Each action is a pure metric patch: "if the user did X, these metrics would
 * change as follows". rank() runs the scorer against patched metrics and
 * reports score delta — no delta math duplicated here.
 */
import { Evidence } from '../evidence';
import { RemediationAction } from '../remediation';
import { QualityMetrics } from './types';

/** Build the candidate action list for the given metrics. */
export function buildSlopActions(m: QualityMetrics): RemediationAction<QualityMetrics>[] {
  const actions: RemediationAction<QualityMetrics>[] = [];

  // 1. Delete committed stale files (.pyc, .swp, .bak, .orig, .tmp, .log)
  if (m.staleFiles.length > 0) {
    const evidence: Evidence[] = m.staleFiles.map((f) => ({
      file: f,
      rule: 'stale-file',
      tool: 'git',
      message: 'Temp/backup file committed to git',
    }));
    actions.push({
      id: 'slop.delete-stale-files',
      title: `Delete ${m.staleFiles.length} stale file${m.staleFiles.length === 1 ? '' : 's'} from git`,
      rationale:
        'Temp/backup files (.pyc, .swp, .bak, .orig) in git add noise and suggest missing .gitignore rules.',
      evidence,
      patch: (cur) => ({ ...cur, staleFiles: [] }),
    });
  }

  // 2. Remove console statements (down to <=20)
  if (m.consoleLogCount > 20) {
    const target = 20;
    const evidence: Evidence[] = (m.topConsoleFiles || []).map((f) => ({
      file: f.file,
      rule: 'console-log',
      tool: 'grep',
      message: `${f.count} console statements`,
    }));
    actions.push({
      id: 'slop.remove-console-statements',
      title: `Remove console statements (currently ${m.consoleLogCount}, target <=${target})`,
      rationale:
        'Console logging in production code indicates missing structured logging. Use a logger library instead.',
      evidence,
      patch: (cur) => ({ ...cur, consoleLogCount: target }),
    });
  }

  // 3. Triage TODO/FIXME/HACK comments (down to <=20)
  const hygieneTotal = m.todoCount + m.fixmeCount + m.hackCount;
  if (hygieneTotal > 20) {
    const evidence: Evidence[] = (m.topTodoFiles || []).map((f) => ({
      file: f.file,
      rule: 'hygiene-marker',
      tool: 'grep',
      message: `${f.count} TODO/FIXME/HACK markers`,
    }));
    actions.push({
      id: 'slop.triage-todos',
      title: `Triage TODO/FIXME/HACK comments (${hygieneTotal} total — file issues or delete)`,
      rationale:
        'Unresolved markers suggest forgotten work. Convert real work to tracked issues; delete obsolete ones.',
      evidence,
      patch: (cur) => ({
        ...cur,
        todoCount: Math.min(cur.todoCount, 15),
        fixmeCount: 0,
        hackCount: 0,
      }),
    });
  }

  // 4. Split the densest file (god file)
  if (m.maxFunctionsInFile !== null && m.maxFunctionsInFile > 50) {
    const ev: Evidence[] = m.maxFunctionsFilePath
      ? [
          {
            file: m.maxFunctionsFilePath,
            rule: 'god-file',
            tool: 'graphify',
            message: `${m.maxFunctionsInFile} functions in one file`,
          },
        ]
      : [];
    actions.push({
      id: 'slop.split-god-file',
      title: `Split the densest file (${m.maxFunctionsInFile} functions)`,
      rationale:
        'Files with >50 functions are hard to navigate, test, and review. Break into focused modules.',
      evidence: ev,
      patch: (cur) => ({ ...cur, maxFunctionsInFile: 40 }),
    });
  }

  // 5. Remove dead imports
  if (m.deadImportCount !== null && m.deadImportCount > 20) {
    actions.push({
      id: 'slop.remove-dead-imports',
      title: `Remove ${m.deadImportCount} dead imports`,
      rationale: 'Imports never called add cognitive load. Most editors auto-remove them.',
      evidence: [],
      patch: (cur) => ({ ...cur, deadImportCount: 0 }),
    });
  }

  // 6. Address large duplication
  if (m.duplication && m.duplication.percentage > 5) {
    const evidence: Evidence[] =
      m.duplication.topClones?.flatMap((c) => [
        {
          file: c.a.file,
          line: c.a.startLine,
          endLine: c.a.endLine,
          rule: 'duplicate-block',
          tool: 'jscpd',
          message: `${c.lines}-line clone with ${c.b.file}:${c.b.startLine}`,
        },
      ]) ?? [];
    const target = 5;
    actions.push({
      id: 'slop.extract-duplicates',
      title: `Extract shared code (duplication ${m.duplication.percentage}% → target ${target}%)`,
      rationale:
        'Duplicate blocks multiply maintenance cost. Extract into shared helpers/modules starting with the largest clones.',
      evidence,
      patch: (cur) => ({
        ...cur,
        duplication: cur.duplication ? { ...cur.duplication, percentage: target } : null,
      }),
    });
  }

  // 7. Unify JS/TS
  if (m.mixedLanguages) {
    actions.push({
      id: 'slop.unify-js-ts',
      title: 'Convert stray .js files to TypeScript',
      rationale:
        'Mixing .js and .ts in source defeats type-safety gains. Convert or move generated JS to /dist.',
      evidence: [],
      patch: (cur) => ({ ...cur, mixedLanguages: false }),
    });
  }

  // 8. Clear lint errors
  if (m.lintErrors > 10) {
    actions.push({
      id: 'slop.fix-lint-errors',
      title: `Fix ${m.lintErrors} lint errors`,
      rationale: 'Lint errors often indicate real bugs. Most are auto-fixable.',
      evidence: [],
      patch: (cur) => ({ ...cur, lintErrors: 0 }),
    });
  }

  // 9. Reduce comment-heavy files
  if (m.commentRatio !== null && m.commentRatio > 0.4) {
    actions.push({
      id: 'slop.reduce-comment-bloat',
      title: `Reduce comment bloat (ratio ${(m.commentRatio * 100).toFixed(1)}%)`,
      rationale:
        'Very high comment ratios often signal commented-out code (should be deleted) or over-documentation.',
      evidence: [],
      patch: (cur) => ({ ...cur, commentRatio: 0.2 }),
    });
  }

  // 10. Address orphan modules
  if (m.orphanModuleCount !== null && m.orphanModuleCount > 30) {
    actions.push({
      id: 'slop.remove-orphan-modules',
      title: `Review ${m.orphanModuleCount} orphan modules (no inbound imports)`,
      rationale:
        'Modules never imported are dead code or entry points. Delete dead ones; document entry points.',
      evidence: [],
      patch: (cur) => ({ ...cur, orphanModuleCount: 20 }),
    });
  }

  return actions;
}
