import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Manifest } from './types';
import * as logger from './logger';

function check(label: string, condition: boolean): boolean {
  if (condition) {
    logger.success(label);
  } else {
    logger.fail(label);
  }
  return condition;
}

function commandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(cwd: string): Promise<void> {
  logger.header('vyuh-dxkit doctor');

  let pass = 0;
  let fail = 0;

  function track(ok: boolean) {
    if (ok) pass++;
    else fail++;
  }

  // 1. Manifest
  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  const hasManifest = fs.existsSync(manifestPath);
  track(check('.vyuh-dxkit.json exists', hasManifest));

  let manifest: Manifest | null = null;
  if (hasManifest) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      track(check('.vyuh-dxkit.json is valid JSON', true));
    } catch {
      track(check('.vyuh-dxkit.json is valid JSON', false));
    }
  }

  // 2. Core files
  console.log('');
  logger.info('Core files:');
  track(check('CLAUDE.md', fs.existsSync(path.join(cwd, 'CLAUDE.md'))));
  track(check('.claude/settings.json', fs.existsSync(path.join(cwd, '.claude', 'settings.json'))));
  track(check('.claude/skills/', fs.existsSync(path.join(cwd, '.claude', 'skills'))));
  track(check('.claude/commands/', fs.existsSync(path.join(cwd, '.claude', 'commands'))));
  track(check('.claude/rules/', fs.existsSync(path.join(cwd, '.claude', 'rules'))));
  track(check('.claude/agents-available/', fs.existsSync(path.join(cwd, '.claude', 'agents-available'))));

  // 3. Settings.json validity
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      track(check('settings.json is valid JSON', true));
    } catch {
      track(check('settings.json is valid JSON', false));
    }
  }

  // 4. Evolved files
  console.log('');
  logger.info('Evolving files:');
  track(check('learned/gotchas.md', fs.existsSync(path.join(cwd, '.claude', 'skills', 'learned', 'references', 'gotchas.md'))));
  track(check('learned/conventions.md', fs.existsSync(path.join(cwd, '.claude', 'skills', 'learned', 'references', 'conventions.md'))));
  track(check('deny-recommendations.md', fs.existsSync(path.join(cwd, '.claude', 'skills', 'learned', 'references', 'deny-recommendations.md'))));

  // 5. Full mode checks
  if (manifest?.mode === 'full') {
    console.log('');
    logger.info('Full mode infrastructure:');
    track(check('.project.yaml', fs.existsSync(path.join(cwd, '.project.yaml'))));
    track(check('.project/ directory', fs.existsSync(path.join(cwd, '.project'))));
    track(check('Makefile', fs.existsSync(path.join(cwd, 'Makefile'))));
    track(check('.ai/ directory', fs.existsSync(path.join(cwd, '.ai'))));

    // Toolchain checks
    console.log('');
    logger.info('Toolchains:');
    if (manifest.config.languages.python) {
      track(check('python3', commandAvailable('python3')));
      track(check('ruff', commandAvailable('ruff')));
    }
    if (manifest.config.languages.go) {
      track(check('go', commandAvailable('go')));
      track(check('golangci-lint', commandAvailable('golangci-lint')));
    }
    if (manifest.config.languages.node || manifest.config.languages.nextjs) {
      track(check('node', commandAvailable('node')));
      track(check('npm', commandAvailable('npm')));
    }
    if (manifest.config.languages.rust) {
      track(check('rustc', commandAvailable('rustc')));
      track(check('cargo', commandAvailable('cargo')));
    }
    if (manifest.config.tools.gcloud) {
      track(check('gcloud', commandAvailable('gcloud')));
    }
    if (manifest.config.tools.infisical) {
      track(check('infisical', commandAvailable('infisical')));
    }
  }

  // Summary
  console.log('');
  logger.header('Results');
  logger.success(`Pass: ${pass}`);
  if (fail > 0) {
    logger.fail(`Fail: ${fail}`);
    console.log('');
    logger.dim('Run `vyuh-dxkit init` or `vyuh-dxkit update` to fix missing files');
  } else {
    logger.success('All checks passed!');
  }
  console.log('');
}
