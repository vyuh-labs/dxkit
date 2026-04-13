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

  const command = positionals[0] || 'init';
  const cwd = process.cwd();

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
      const targetPath = positionals[1] || cwd;
      const { analyzeHealth } = await import('./analyzers');
      logger.header('vyuh-dxkit health');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      const report = analyzeHealth(targetPath);
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

        // Save markdown report
        const reportDir = path.join(targetPath, '.ai', 'reports');
        const date = new Date().toISOString().slice(0, 10);
        const reportPath = path.join(reportDir, `health-audit-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatMarkdownReport(report, elapsed));
        console.log('');
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);

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
      const targetPath = positionals[2] || cwd;
      const { runToolsCommand } = await import('./tools-cli');
      await runToolsCommand(targetPath, subCommand, !!values.yes);
      break;
    }

    case 'vulnerabilities':
    case 'vuln': {
      const targetPath = positionals[1] || cwd;
      const { analyzeSecurity, formatSecurityReport } = await import('./analyzers/security');
      logger.header('vyuh-dxkit vulnerabilities');
      logger.info(`Scanning ${targetPath}...`);
      const startTime = Date.now();
      const report = analyzeSecurity(targetPath);
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

        const reportDir = path.join(targetPath, '.ai', 'reports');
        const date = new Date().toISOString().slice(0, 10);
        const reportPath = path.join(reportDir, `vulnerability-scan-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatSecurityReport(report, elapsed));
        console.log('');
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);
      }
      break;
    }

    case 'test-gaps': {
      const targetPath = positionals[1] || cwd;
      const { analyzeTestGaps, formatTestGapsReport } = await import('./analyzers/tests');
      logger.header('vyuh-dxkit test-gaps');
      logger.info(`Analyzing ${targetPath}...`);
      const startTime = Date.now();
      const report = analyzeTestGaps(targetPath);
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

        const reportDir = path.join(targetPath, '.ai', 'reports');
        const date = new Date().toISOString().slice(0, 10);
        const reportPath = path.join(reportDir, `test-gaps-${date}.md`);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(reportPath, formatTestGapsReport(report, elapsed));
        console.log('');
        logger.success(`Report saved to ${path.relative(targetPath, reportPath)}`);
      }
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
