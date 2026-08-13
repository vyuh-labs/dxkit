/**
 * `vyuh-dxkit init --gate-only` (4.4.0 WP8 / P3-9) — the embed profile.
 *
 * An on-prem image that embeds dxkit as a gate engine needs exactly one
 * committed artifact: the policy document (the DoD the verdict names).
 * Everything else the full init ships — .claude/ context, git hooks, CI
 * workflows, the loop pack, the devcontainer, GitHub integration — is
 * repo-workflow surface a container image neither wants nor should
 * carry (their WS6-style review counts every byte). So this profile
 * writes the policy scaffold and stops, and the managed-surface
 * registries are deliberately NOT consulted: nothing is installed, so
 * nothing needs lifecycle management (`uninstall` has nothing to own).
 *
 * The BOM companion is `tools bom` (registry-rendered); the embed
 * walkthrough lives in the learn docs (WP9).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as logger from './logger';
import { DEFAULT_POLICY_FILENAME } from './baseline/policy';
import { renderPolicyScaffold } from './baseline/policy-template';
import { scaffoldCtxFor } from './policy-sync';
import { VERSION } from './constants';

export async function runGateOnlyInit(cwd: string): Promise<void> {
  logger.header('dxkit gate-only init (embed profile)');
  const policyPath = path.join(cwd, DEFAULT_POLICY_FILENAME);
  if (fs.existsSync(policyPath)) {
    logger.info(`policy already present: ${DEFAULT_POLICY_FILENAME} — left untouched.`);
  } else {
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    const scaffold = renderPolicyScaffold({
      // The embed profile pins its base EXPLICITLY (WP1b §7.2): the written
      // file names the same security-only posture the gate's no-policy
      // fallback applies, so scaffolding never silently changes posture —
      // and a later hand edit starts from a declared base, not the
      // fully-armed-default footgun.
      active: { extends: 'security-only' },
      ctx: scaffoldCtxFor(cwd),
      version: VERSION,
    });
    fs.writeFileSync(policyPath, scaffold);
    logger.success(`wrote ${DEFAULT_POLICY_FILENAME} (the DoD your verdicts will name)`);
  }
  logger.info('gate-only profile installs NOTHING else — no hooks, CI, lanes, or .claude/.');
  logger.info('Next steps:');
  logger.info('  vyuh-dxkit gate <dir> --policy .dxkit/policy.json --json   # one-shot verdict');
  logger.info(
    '  vyuh-dxkit tools bom --json                                # image supply-chain BOM',
  );
  logger.info('  vyuh-dxkit tools install                                   # provision scanners');
}
