import * as fs from 'fs';
import * as path from 'path';
import { Manifest } from './types';
import { detect } from './detect';
import { generate } from './generator';
import * as logger from './logger';

export async function runUpdate(cwd: string, force: boolean, rescan = false): Promise<void> {
  logger.header('vyuh-dxkit update');

  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  if (!fs.existsSync(manifestPath)) {
    logger.fail('.vyuh-dxkit.json not found. Run `vyuh-dxkit init` first.');
    process.exit(1);
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    logger.fail('Failed to parse .vyuh-dxkit.json');
    process.exit(1);
  }

  logger.info(`Previous init: ${manifest.generatedAt} (mode: ${manifest.mode})`);

  // Re-detect stack
  logger.info('Re-detecting stack...');
  const detected = detect(cwd);

  // Merge: new detection overrides, but preserve mode and thresholds from manifest
  const config = {
    ...detected,
    coverageThreshold: manifest.config.coverageThreshold,
    precommit: manifest.config.precommit,
    qualityChecks: manifest.config.qualityChecks,
    aiSessions: manifest.config.aiSessions,
    aiPrompts: manifest.config.aiPrompts,
    claudeCode: manifest.config.claudeCode,
  };

  // Merge languages: keep enabled if previously enabled OR newly detected
  for (const lang of Object.keys(config.languages) as (keyof typeof config.languages)[]) {
    config.languages[lang] = config.languages[lang] || manifest.config.languages[lang];
  }

  // If rescan requested, remove codebase skill so it gets regenerated
  if (rescan) {
    const codebasePath = path.join(cwd, '.claude', 'skills', 'codebase');
    if (fs.existsSync(codebasePath)) {
      fs.rmSync(codebasePath, { recursive: true });
      logger.info('Cleared codebase skill for rescan');
    }
  }

  // Re-generate (noScan=false so codebase gets regenerated if rescan or first time)
  const result = await generate(cwd, config, manifest.mode, force, false);

  // Summary
  console.log('');
  logger.header('Update Summary');
  if (result.created.length) logger.success(`Created: ${result.created.length} new files`);
  if (result.skipped.length) logger.warn(`Skipped: ${result.skipped.length} files (preserved)`);
  if (result.overwritten.length) logger.info(`Updated: ${result.overwritten.length} files`);
  console.log('');
  logger.success('Update complete. Evolved files (gotchas, conventions) preserved.');
}
