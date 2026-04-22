import { parseArgs } from 'node:util';
import { detect } from './detect';
import { generate } from './generator';
import { promptForConfig } from './prompts';
import { hasProjectYaml, readProjectYaml } from './project-yaml';
import { runUpdate } from './update';
import { runDoctor } from './doctor';
import { VERSION } from './constants';
import * as logger from './logger';
import { GenerationMode } from './types';
import * as fs from 'fs';
import * as path from 'path';

function printUsage(): void {
  console.log(`
  ${logger.bold('vyuh-dxkit')} v${VERSION} — AI-native developer experience toolkit

  ${logger.bold('Usage:')}
    vyuh-dxkit init [options]    Initialize Claude Code DX in this repo
    vyuh-dxkit update [options]  Re-generate (preserves evolved files)
    vyuh-dxkit doctor            Verify setup
    vyuh-dxkit health [path]     Run deterministic health analysis
    vyuh-dxkit vulnerabilities [path]  Run deep security scan
    vyuh-dxkit test-gaps [path]  Analyze test coverage gaps
    vyuh-dxkit quality [path]    Code quality + slop detection
    vyuh-dxkit dev-report [path] Developer activity analysis
    vyuh-dxkit licenses [path]   Dependency license inventory
    vyuh-dxkit to-xlsx <json>    Convert a dxkit JSON report to 15-col XLSX
    vyuh-dxkit tools [path]      Show required analysis tools status
    vyuh-dxkit tools install     Interactively install missing tools

  ${logger.bold('Init options:')}
    --dx-only    Just .claude/ + CLAUDE.md (default)
    --full       Everything: DX + quality + hooks + CI
    --detect     Auto-detect stack, minimal prompts
    --yes        Accept all defaults, no prompts
    --force      Overwrite existing files (except evolved)
    --stealth    Gitignore generated files (local-only, not committed)
    --name <n>   Override project name
    --no-scan    Skip codebase analysis

  ${logger.bold('Update options:')}
    --force      Overwrite modified files (except evolved)
    --rescan     Re-run codebase analysis

  ${logger.bold('Analyzer options (health, vulnerabilities, test-gaps, quality, dev-report, licenses):')}
    --json       Print report as JSON to stdout
    --verbose    Print per-tool timing to stderr
    --no-save    Skip writing the markdown report file
    --detailed   Also write <name>-detailed.md + .json with evidence + ranked actions
    --since      Dev-report: start date (YYYY-MM-DD)

  ${logger.bold('Examples:')}
    npx vyuh-dxkit init                  # Interactive
    npx vyuh-dxkit init --detect         # Auto-detect, just DX
    npx vyuh-dxkit init --full --yes     # Everything, no prompts
    npx vyuh-dxkit init --detect --stealth  # Local-only, not committed
    npx vyuh-dxkit update                # Re-generate from manifest
`);
}

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      'dx-only': { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      detect: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      force: { type: 'boolean', short: 'f', default: false },
      stealth: { type: 'boolean', default: false },
      name: { type: 'string' },
      'no-scan': { type: 'boolean', default: false },
      rescan: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      since: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      'no-save': { type: 'boolean', default: false },
      detailed: { type: 'boolean', default: false },
      output: { type: 'string', short: 'o' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  if (values.version) {
    console.log(VERSION);
    return;
  }

  // Route logger output to stderr in --json mode so stdout stays pure JSON.
  logger.setJsonMode(!!values.json);

  const command = positionals[0] || 'init';
  const cwd = process.cwd();

  /**
   * Resolve a user-supplied repo path to an absolute one. Analyzers
   * propagate this value into child worker processes (Layer 2 parallel
   * cloc/gitleaks/graphify) that run from a different cwd, so a bare
   * "." would resolve against the child's cwd — yielding bogus scans
   * of dxkit's own dist/ output. Always absolutize at the boundary.
   */
  const resolveRepoPath = (raw?: string): string => path.resolve(raw || cwd);

  switch (command) {
    case 'init': {
      logger.header('vyuh-dxkit init');

      let config;
      let finalMode: GenerationMode = values.full ? 'full' : 'dx-only';

      // If .project.yaml exists (written by create-devstack), try using it as config source
      if (hasProjectYaml(cwd)) {
        const yamlConfig = readProjectYaml(cwd);

        if (yamlConfig) {
          logger.info('Found .project.yaml — using as config source.');
          config = yamlConfig;

          const langs = Object.entries(config.languages)
            .filter(([, v]) => v)
            .map(([k]) => k);
          const tools = Object.entries(config.tools)
            .filter(([, v]) => v)
            .map(([k]) => k);

          if (langs.length) logger.success(`Languages: ${langs.join(', ')}`);
          if (tools.length) logger.success(`Tools: ${tools.join(', ')}`);
          console.log('');

          // .project.yaml implies full mode (create-devstack handles the wizard)
          finalMode = values['dx-only'] ? 'dx-only' : 'full';
        } else {
          logger.warn('Found .project.yaml but it is malformed — falling back to detection.');
        }
      }

      if (!config) {
        // No .project.yaml — detect stack and prompt as before
        logger.info('Detecting stack...');
        const detected = detect(cwd);
        const langs = Object.entries(detected.languages)
          .filter(([, v]) => v)
          .map(([k]) => k);
        const tools = Object.entries(detected.tools)
          .filter(([, v]) => v)
          .map(([k]) => k);

        if (langs.length === 0) {
          logger.warn('No languages detected. Generating with minimal config.');
        } else {
          logger.success(`Languages: ${langs.join(', ')}`);
        }
        if (tools.length) logger.success(`Tools: ${tools.join(', ')}`);
        if (detected.framework) logger.success(`Framework: ${detected.framework}`);
        if (detected.testRunner)
          logger.success(
            `Tests: ${detected.testRunner.framework} (${detected.testRunner.command})`,
          );
        console.log('');

        // Resolve config via prompts
        const promptOpts = {
          yes: !!(values.yes || values.detect),
          detect: !!values.detect,
          name: values.name as string | undefined,
        };
        const result = await promptForConfig(detected, promptOpts);
        config = result.config;

        finalMode = values.full ? 'full' : values['dx-only'] ? 'dx-only' : result.mode;
      }
      const result = await generate(cwd, config, finalMode, !!values.force, !!values['no-scan']);

      // Summary
      console.log('');
      logger.header('Summary');
      if (result.created.length) logger.success(`Created: ${result.created.length} files`);
      if (result.skipped.length)
        logger.warn(`Skipped: ${result.skipped.length} files (already exist)`);
      if (result.overwritten.length) logger.info(`Overwritten: ${result.overwritten.length} files`);
      console.log('');
      logger.info('Manifest written to .vyuh-dxkit.json');

      // Stealth mode: gitignore only files we just created
      if (values.stealth) {
        enableStealthMode(cwd, result.created);
      }

      console.log('');
      logger.success('Done! Claude Code now has full project context.');
      console.log('');
      logger.dim('  Run `vyuh-dxkit doctor` to verify setup');
      logger.dim('  Run `vyuh-dxkit update` to re-generate after changes');
      break;
    }

    case 'update': {
      await runUpdate(cwd, !!values.force, !!values.rescan);
      break;
    }

    case 'doctor': {
      await runDoctor(cwd);
      break;
    }

    case 'health': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeHealth, analyzeHealthWithMetrics } = await import('./analyzers/health');
      logger.header('vyuh-dxkit health');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      // Detailed mode needs HealthMetrics for remediation planning; pull both.
      const healthResult = values.detailed
        ? await analyzeHealthWithMetrics(targetPath, { verbose: !!values.verbose })
        : {
            report: await analyzeHealth(targetPath, { verbose: !!values.verbose }),
            metrics: null,
          };
      const report = healthResult.report;
      const healthMetrics = healthResult.metrics;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        // Console output
        console.log('');
        console.log(
          `  ${logger.bold('Overall:')} ${report.summary.overallScore}/100 (Grade: ${report.summary.grade})`,
        );
        console.log('');
        const dims = report.dimensions;
        const order: Array<[string, typeof dims.testing]> = [
          ['Testing', dims.testing],
          ['Code Quality', dims.quality],
          ['Documentation', dims.documentation],
          ['Security', dims.security],
          ['Maintainability', dims.maintainability],
          ['Developer Experience', dims.developerExperience],
        ];
        for (const [name, dim] of order) {
          const bar =
            '█'.repeat(Math.round(dim.score / 5)) + '░'.repeat(20 - Math.round(dim.score / 5));
          console.log(
            `  ${name.padEnd(22)} ${bar} ${dim.score.toString().padStart(3)}/100  ${dim.status}`,
          );
        }
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        if (report.toolsUnavailable.length > 0) {
          logger.dim('Unavailable: ' + report.toolsUnavailable.join(', '));
        }
        logger.dim(`Completed in ${elapsed}s`);

        // Save markdown report (unless --no-save)
        if (!values['no-save']) {
          const reportDir = path.join(targetPath, '.ai', 'reports');
          const date = new Date().toISOString().slice(0, 10);
          const reportPath = path.join(reportDir, `health-audit-${date}.md`);
          fs.mkdirSync(reportDir, { recursive: true });
          fs.writeFileSync(reportPath, formatMarkdownReport(report, elapsed));
          console.log('');
          logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

          if (values.detailed && healthMetrics) {
            const { buildHealthDetailed, formatHealthDetailedMarkdown } =
              await import('./analyzers/health/detailed');
            const detailed = buildHealthDetailed(report, healthMetrics);
            const detailedMdPath = path.join(reportDir, `health-audit-${date}-detailed.md`);
            const detailedJsonPath = path.join(reportDir, `health-audit-${date}-detailed.json`);
            fs.writeFileSync(detailedMdPath, formatHealthDetailedMarkdown(detailed, elapsed));
            fs.writeFileSync(detailedJsonPath, JSON.stringify(detailed, null, 2));
            logger.success(`Detailed report saved to ${path.relative(targetPath, detailedMdPath)}`);
            logger.success(`Detailed JSON saved to ${path.relative(targetPath, detailedJsonPath)}`);
          }
        }

        // Hint about missing tools (exclude project-side config errors)
        const PROJECT_ISSUES = ['config error', 'legacy .eslintrc', 'no eslint config'];
        const trulyMissing = report.toolsUnavailable.filter(
          (t) => !PROJECT_ISSUES.some((p) => t.includes(p)),
        );
        if (trulyMissing.length > 0) {
          console.log('');
          logger.dim(
            '💡 Run `vyuh-dxkit tools install` to install missing tools for more accurate results.',
          );
        }
      }
      break;
    }

    case 'tools': {
      const subCommand = positionals[1];
      const targetPath = resolveRepoPath(positionals[2]);
      const { runToolsCommand } = await import('./tools-cli');
      await runToolsCommand(targetPath, subCommand, !!values.yes);
      break;
    }

    case 'vulnerabilities':
    case 'vuln': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeSecurity, formatSecurityReport } = await import('./analyzers/security');
      logger.header('vyuh-dxkit vulnerabilities');
      logger.info(`Scanning ${targetPath}...`);
      const startTime = Date.now();
      const report = await analyzeSecurity(targetPath, { verbose: !!values.verbose });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const s = report.summary.findings;
        const d = report.summary.dependencies;
        console.log('');
        console.log(`  ${logger.bold('Code findings:')}`);
        console.log(
          `    CRITICAL: ${s.critical}  HIGH: ${s.high}  MEDIUM: ${s.medium}  LOW: ${s.low}  Total: ${s.total}`,
        );
        if (d.tool) {
          console.log(`  ${logger.bold('Dependency vulns:')}`);
          console.log(`    ${d.critical}C ${d.high}H ${d.medium}M ${d.low}L (${d.total} total)`);
        }
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        if (report.toolsUnavailable.length > 0) {
          logger.dim('Unavailable: ' + report.toolsUnavailable.join(', '));
        }
        logger.dim(`Completed in ${elapsed}s`);

        if (!values['no-save']) {
          const reportDir = path.join(targetPath, '.ai', 'reports');
          const date = new Date().toISOString().slice(0, 10);
          const reportPath = path.join(reportDir, `vulnerability-scan-${date}.md`);
          fs.mkdirSync(reportDir, { recursive: true });
          fs.writeFileSync(reportPath, formatSecurityReport(report, elapsed));
          console.log('');
          logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

          if (values.detailed) {
            const { buildSecurityDetailed, formatSecurityDetailedMarkdown } =
              await import('./analyzers/security/detailed');
            const detailed = buildSecurityDetailed(report);
            const detailedMdPath = path.join(reportDir, `vulnerability-scan-${date}-detailed.md`);
            const detailedJsonPath = path.join(
              reportDir,
              `vulnerability-scan-${date}-detailed.json`,
            );
            fs.writeFileSync(detailedMdPath, formatSecurityDetailedMarkdown(detailed, elapsed));
            fs.writeFileSync(detailedJsonPath, JSON.stringify(detailed, null, 2));
            logger.success(`Detailed report saved to ${path.relative(targetPath, detailedMdPath)}`);
            logger.success(`Detailed JSON saved to ${path.relative(targetPath, detailedJsonPath)}`);
          }
        }
      }
      break;
    }

    case 'test-gaps': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeTestGaps, formatTestGapsReport } = await import('./analyzers/tests');
      logger.header('vyuh-dxkit test-gaps');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      const report = await analyzeTestGaps(targetPath, { verbose: !!values.verbose });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const s = report.summary;
        console.log('');
        console.log(`  ${logger.bold('Effective coverage:')} ${s.effectiveCoverage}%`);
        console.log(
          `  Test files: ${s.testFiles} (${s.activeTestFiles} active, ${s.commentedOutFiles} commented-out)`,
        );
        console.log(`  Source files: ${s.sourceFiles}`);
        console.log('');
        console.log(`  ${logger.bold('Untested by risk:')}`);
        console.log(
          `    CRITICAL: ${s.untestedCritical}  HIGH: ${s.untestedHigh}  MEDIUM: ${s.untestedMedium}  LOW: ${s.untestedLow}`,
        );
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        logger.dim(`Completed in ${elapsed}s`);

        if (!values['no-save']) {
          const reportDir = path.join(targetPath, '.ai', 'reports');
          const date = new Date().toISOString().slice(0, 10);
          const reportPath = path.join(reportDir, `test-gaps-${date}.md`);
          fs.mkdirSync(reportDir, { recursive: true });
          fs.writeFileSync(reportPath, formatTestGapsReport(report, elapsed));
          console.log('');
          logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

          if (values.detailed) {
            const { buildTestGapsDetailed, formatTestGapsDetailedMarkdown } =
              await import('./analyzers/tests/detailed');
            const detailed = buildTestGapsDetailed(report);
            const detailedMdPath = path.join(reportDir, `test-gaps-${date}-detailed.md`);
            const detailedJsonPath = path.join(reportDir, `test-gaps-${date}-detailed.json`);
            fs.writeFileSync(detailedMdPath, formatTestGapsDetailedMarkdown(detailed, elapsed));
            fs.writeFileSync(detailedJsonPath, JSON.stringify(detailed, null, 2));
            logger.success(`Detailed report saved to ${path.relative(targetPath, detailedMdPath)}`);
            logger.success(`Detailed JSON saved to ${path.relative(targetPath, detailedJsonPath)}`);
          }
        }
      }
      break;
    }

    case 'quality': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeQuality, formatQualityReport } = await import('./analyzers/quality');
      logger.header('vyuh-dxkit quality');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      const report = await analyzeQuality(targetPath, {
        verbose: !!values.verbose,
        detailed: !!values.detailed,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const m = report.metrics;
        const slopLabel =
          report.slopScore >= 80
            ? 'clean'
            : report.slopScore >= 60
              ? 'fair'
              : report.slopScore >= 40
                ? 'messy'
                : 'sloppy';
        console.log('');
        console.log(`  ${logger.bold('Slop Score:')} ${report.slopScore}/100 (${slopLabel})`);
        console.log('');
        if (m.duplication) {
          console.log(
            `  Duplication:    ${m.duplication.percentage}% (${m.duplication.cloneCount} clones)`,
          );
        }
        if (m.commentRatio !== null) {
          console.log(`  Comment ratio:  ${(m.commentRatio * 100).toFixed(1)}%`);
        }
        console.log(`  Lint:           ${m.lintErrors} errors, ${m.lintWarnings} warnings`);
        console.log(`  TODO/FIXME/HACK: ${m.todoCount}/${m.fixmeCount}/${m.hackCount}`);
        console.log(`  Console stmts:  ${m.consoleLogCount}`);
        if (m.functionCount !== null) {
          console.log(
            `  Functions:      ${m.functionCount} (max ${m.maxFunctionsInFile} in one file)`,
          );
        }
        if (m.deadImportCount !== null) {
          console.log(`  Dead imports:   ${m.deadImportCount}`);
        }
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        if (report.toolsUnavailable.length > 0) {
          logger.dim('Unavailable: ' + report.toolsUnavailable.join(', '));
        }
        logger.dim(`Completed in ${elapsed}s`);

        if (!values['no-save']) {
          const reportDir = path.join(targetPath, '.ai', 'reports');
          const date = new Date().toISOString().slice(0, 10);
          const reportPath = path.join(reportDir, `quality-review-${date}.md`);
          fs.mkdirSync(reportDir, { recursive: true });
          fs.writeFileSync(reportPath, formatQualityReport(report, elapsed));
          console.log('');
          logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

          if (values.detailed) {
            const { buildQualityDetailed, formatQualityDetailedMarkdown } =
              await import('./analyzers/quality/detailed');
            const detailed = buildQualityDetailed(report);
            const detailedMdPath = path.join(reportDir, `quality-review-${date}-detailed.md`);
            const detailedJsonPath = path.join(reportDir, `quality-review-${date}-detailed.json`);
            fs.writeFileSync(detailedMdPath, formatQualityDetailedMarkdown(detailed, elapsed));
            fs.writeFileSync(detailedJsonPath, JSON.stringify(detailed, null, 2));
            logger.success(`Detailed report saved to ${path.relative(targetPath, detailedMdPath)}`);
            logger.success(`Detailed JSON saved to ${path.relative(targetPath, detailedJsonPath)}`);
          }
        }
      }
      break;
    }

    case 'dev-report': {
      const targetPath = resolveRepoPath(positionals[1]);
      const sinceFlag = (values as Record<string, unknown>).since as string | undefined;
      const { analyzeDevActivity, formatDevReport } = await import('./analyzers/developer');
      logger.header('vyuh-dxkit dev-report');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      const report = analyzeDevActivity(targetPath, sinceFlag, { verbose: !!values.verbose });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const s = report.summary;
        console.log('');
        console.log(`  ${logger.bold('Period:')} ${report.period.since} to ${report.period.until}`);
        console.log(
          `  ${logger.bold('Commits:')} ${s.totalCommits} (${s.nonMergeCommits} non-merge, ${s.mergeCommits} merge)`,
        );
        console.log(`  ${logger.bold('Contributors:')} ${s.contributors}`);
        console.log(`  ${logger.bold('Merge ratio:')} ${(s.mergeRatio * 100).toFixed(1)}%`);
        console.log(
          `  ${logger.bold('Conventional commits:')} ${report.commitQuality.conventionalPercent}%`,
        );
        console.log('');
        if (report.hotFiles.length > 0) {
          console.log(`  ${logger.bold('Hot files:')}`);
          for (const f of report.hotFiles.slice(0, 5)) {
            console.log(`    ${f.changes.toString().padStart(3)} changes  ${f.path}`);
          }
        }
        console.log('');
        logger.dim('Tools: ' + report.toolsUsed.join(', '));
        logger.dim(`Completed in ${elapsed}s`);

        if (!values['no-save']) {
          const reportDir = path.join(targetPath, '.ai', 'reports');
          const date = new Date().toISOString().slice(0, 10);
          const reportPath = path.join(reportDir, `developer-report-${date}.md`);
          fs.mkdirSync(reportDir, { recursive: true });
          fs.writeFileSync(reportPath, formatDevReport(report, elapsed));
          console.log('');
          logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

          if (values.detailed) {
            const { buildDevDetailed, formatDevDetailedMarkdown } =
              await import('./analyzers/developer/detailed');
            const { gatherVagueCommitExamples } = await import('./analyzers/developer/gather');
            const sinceDate =
              sinceFlag ||
              new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const vague = gatherVagueCommitExamples(targetPath, sinceDate);
            const detailed = buildDevDetailed(report, vague);
            const detailedMdPath = path.join(reportDir, `developer-report-${date}-detailed.md`);
            const detailedJsonPath = path.join(reportDir, `developer-report-${date}-detailed.json`);
            fs.writeFileSync(detailedMdPath, formatDevDetailedMarkdown(detailed, elapsed));
            fs.writeFileSync(detailedJsonPath, JSON.stringify(detailed, null, 2));
            logger.success(`Detailed report saved to ${path.relative(targetPath, detailedMdPath)}`);
            logger.success(`Detailed JSON saved to ${path.relative(targetPath, detailedJsonPath)}`);
          }
        }
      }
      break;
    }

    case 'licenses': {
      const targetPath = resolveRepoPath(positionals[1]);
      const { analyzeLicenses, formatLicensesReport } = await import('./analyzers/licenses');
      logger.header('vyuh-dxkit licenses');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      const report = await analyzeLicenses(targetPath, { verbose: !!values.verbose });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (values.json) {
        console.log(JSON.stringify(report, null, 2)); // slop-ok
      } else {
        const s = report.summary;
        console.log(''); // slop-ok
        console.log(`  ${logger.bold('Packages:')} ${s.totalPackages}`); // slop-ok
        const licCount = Object.keys(s.byLicense).length;
        console.log(`  ${logger.bold('License types:')} ${licCount} distinct`); // slop-ok
        if (s.unknownCount > 0) {
          console.log(`  ${logger.bold('Unknown license:')} ${s.unknownCount}`); // slop-ok
        }
        const top = Object.entries(s.byLicense)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        if (top.length > 0) {
          console.log(''); // slop-ok
          console.log(`  ${logger.bold('Top licenses:')}`); // slop-ok
          for (const [lic, count] of top) {
            console.log(`    ${count.toString().padStart(4)}  ${lic}`); // slop-ok
          }
        }
        console.log(''); // slop-ok
        logger.dim('Tools: ' + (report.toolsUsed.join(', ') || '(none)'));
        logger.dim(`Completed in ${elapsed}s`);

        if (!values['no-save']) {
          const reportDir = path.join(targetPath, '.ai', 'reports');
          const date = new Date().toISOString().slice(0, 10);
          const reportPath = path.join(reportDir, `licenses-${date}.md`);
          fs.mkdirSync(reportDir, { recursive: true });
          fs.writeFileSync(reportPath, formatLicensesReport(report, elapsed));
          console.log(''); // slop-ok
          logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

          if (values.detailed) {
            const { buildLicensesDetailed, formatLicensesDetailedMarkdown } =
              await import('./analyzers/licenses/detailed');
            const detailed = buildLicensesDetailed(report);
            const detailedMdPath = path.join(reportDir, `licenses-${date}-detailed.md`);
            const detailedJsonPath = path.join(reportDir, `licenses-${date}-detailed.json`);
            fs.writeFileSync(detailedMdPath, formatLicensesDetailedMarkdown(detailed, elapsed));
            fs.writeFileSync(detailedJsonPath, JSON.stringify(detailed, null, 2));
            logger.success(`Detailed report saved to ${path.relative(targetPath, detailedMdPath)}`);
            logger.success(`Detailed JSON saved to ${path.relative(targetPath, detailedJsonPath)}`);
          }
        }
      }
      break;
    }

    case 'to-xlsx': {
      const inputArg = positionals[1];
      if (!inputArg) {
        console.error('Usage: vyuh-dxkit to-xlsx <json-file> [--output <file.xlsx>]'); // slop-ok
        process.exit(1);
      }
      const inputPath = path.resolve(inputArg);
      const outputPath = values.output
        ? path.resolve(values.output as string)
        : inputPath.replace(/\.json$/, '') + '.xlsx';

      logger.header('vyuh-dxkit to-xlsx');
      logger.info(`Reading ${path.relative(cwd, inputPath)}...`);

      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.fail(`Failed to read/parse input: ${msg}`);
        process.exit(1);
      }

      const { detectReportKind, toXlsx } = await import('./analyzers/xlsx');
      const kind = detectReportKind(json);
      if (kind === 'unknown') {
        logger.fail(
          'Unrecognised report shape. Supported inputs: licenses (vyuh-dxkit licenses --detailed produces licenses-<date>-detailed.json).',
        );
        process.exit(1);
      }

      const startTime = Date.now();
      const buf = await toXlsx(json);
      fs.writeFileSync(outputPath, buf);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      logger.success(`Wrote ${path.relative(cwd, outputPath)} (${buf.length} bytes)`);
      logger.dim(`Converted in ${elapsed}s · report kind: ${kind}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function formatMarkdownReport(
  report: import('./analyzers/types').HealthReport,
  elapsed: string,
): string {
  const lines: string[] = [];
  lines.push('# Codebase Health Audit');
  lines.push('');
  lines.push(`**Date:** ${report.analyzedAt.slice(0, 10)}`);
  lines.push(`**Repository:** ${report.repo}`);
  lines.push(`**Branch:** ${report.branch}`);
  lines.push(`**Commit:** ${report.commitSha}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `## Overall Health Score: ${report.summary.overallScore}/100 (Grade: ${report.summary.grade})`,
  );
  lines.push('');
  lines.push('| Dimension | Score | Status |');
  lines.push('|---|---|---|');

  const dimNames: Record<string, string> = {
    testing: 'Tests',
    quality: 'Code Quality',
    documentation: 'Documentation',
    security: 'Security',
    maintainability: 'Maintainability',
    developerExperience: 'Developer Experience (DX)',
  };

  for (const [key, dim] of Object.entries(report.dimensions)) {
    const name = dimNames[key] || key;
    lines.push(
      `| ${name} | ${dim.score}/100 | ${dim.status.charAt(0).toUpperCase() + dim.status.slice(1)} |`,
    );
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // Dimension details
  for (const [key, dim] of Object.entries(report.dimensions)) {
    const name = dimNames[key] || key;
    lines.push(
      `## ${name} (${dim.score}/100) -- ${dim.status.charAt(0).toUpperCase() + dim.status.slice(1)}`,
    );
    lines.push('');
    lines.push(dim.details);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    for (const [mk, mv] of Object.entries(dim.metrics)) {
      if (mv !== null && mv !== undefined) {
        lines.push(`| ${mk} | ${mv} |`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Score calculation table
  lines.push('## Score Calculation');
  lines.push('');
  lines.push('| Dimension | Weight | Score | Weighted |');
  lines.push('|---|---|---|---|');

  const weights: Record<string, number> = {
    testing: 0.25,
    quality: 0.2,
    documentation: 0.1,
    security: 0.2,
    maintainability: 0.1,
    developerExperience: 0.15,
  };

  for (const [key, dim] of Object.entries(report.dimensions)) {
    const name = dimNames[key] || key;
    const w = weights[key] || 0;
    lines.push(
      `| ${name} | ${(w * 100).toFixed(0)}% | ${dim.score} | ${(dim.score * w).toFixed(2)} |`,
    );
  }
  lines.push(`| **Overall** | **100%** | | **${report.summary.overallScore}** |`);
  lines.push('');

  // Footer
  lines.push('---');
  lines.push('');
  if (report.languages.length > 0) {
    lines.push(
      '**Languages:** ' + report.languages.map((l) => `${l.name} (${l.percentage}%)`).join(', '),
    );
    lines.push('');
  }
  lines.push(`**Tools used:** ${report.toolsUsed.join(', ')}`);
  if (report.toolsUnavailable.length > 0) {
    lines.push(`**Tools unavailable:** ${report.toolsUnavailable.join(', ')}`);
  }
  lines.push(`**Analysis time:** ${elapsed}s`);
  lines.push('');
  lines.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');

  return lines.join('\n');
}

const STEALTH_HEADER = '# dxkit (stealth mode — local only, not committed)';

/**
 * Add only files created in this run to .gitignore.
 * Collapses directory files into directory entries.
 */
function enableStealthMode(cwd: string, createdFiles: string[]): void {
  const gitignorePath = path.join(cwd, '.gitignore');

  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
    if (existing.includes(STEALTH_HEADER)) {
      logger.warn('.gitignore already has dxkit stealth entries');
      return;
    }
  }

  // Collapse into top-level directories where possible
  const dirs = new Set<string>();
  const files: string[] = [];

  for (const f of createdFiles) {
    const topDir = f.split('/')[0];
    if (f.includes('/') && topDir.startsWith('.')) {
      dirs.add(topDir + '/');
    } else {
      files.push(f);
    }
  }
  // Always include the manifest
  files.push('.vyuh-dxkit.json');

  // Dedupe against existing .gitignore
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  const newEntries: string[] = [];

  for (const d of dirs) {
    if (!existingLines.has(d)) newEntries.push(d);
  }
  for (const f of files) {
    if (!existingLines.has(f)) newEntries.push(f);
  }

  if (newEntries.length === 0) {
    logger.warn('.gitignore already covers generated files');
    return;
  }

  const block = '\n' + STEALTH_HEADER + '\n' + newEntries.join('\n') + '\n';
  fs.appendFileSync(gitignorePath, block, 'utf-8');
  logger.success(
    `.gitignore updated — ${newEntries.length} generated path${newEntries.length !== 1 ? 's' : ''} added (stealth mode)`,
  );
}
