/**
 * `vyuh-dxkit install classify` / `vyuh-dxkit install comment`: the two
 * internal subcommands the generated workflows call around their rendered
 * dependency-install chain (Rule 16: registered `internal`).
 *
 *   - `classify --log <file> --code <n>` runs at the end of the install
 *     step, on the captured chain log: it writes the install-outcome record
 *     (`INSTALL_OUTCOME_RECORD`) through the ONE classification
 *     (`classifyInstallLog`) and prints a one-line summary. Exit 0 always:
 *     the step's own exit code is the install's, set by the rendered shell.
 *   - `comment` runs in the comment step when no guardrail report exists:
 *     it prints the PR comment body to stdout and the job annotation to
 *     stderr, from the record. Exit 1 when there is no record, so the
 *     workflow falls back to its generic "did not run" text.
 */
import * as fs from 'fs';
import * as path from 'path';
import { installStrategyProviders, LANGUAGES } from '../languages';
import {
  classifyInstallLog,
  readInstallOutcome,
  renderInstallOutcomeComment,
  summarizeInstallOutcome,
  writeInstallOutcome,
} from './outcome';

export interface InstallClassifyOptions {
  readonly log?: string;
  readonly code?: string;
}

export function runInstallClassify(cwd: string, opts: InstallClassifyOptions): number {
  if (!opts.log) {
    process.stderr.write('install classify: --log <file> is required\n');
    return 2;
  }
  const code = Number.parseInt(opts.code ?? '1', 10);
  let log = '';
  try {
    log = fs.readFileSync(path.resolve(cwd, opts.log), 'utf8');
  } catch {
    // A missing log still classifies (as unclassified): the record must
    // exist so the comment step can name the command that ran.
  }
  const providers = installStrategyProviders(LANGUAGES).map((p) => p.provider);
  const record = classifyInstallLog(cwd, providers, log, Number.isNaN(code) ? 1 : code);
  const abs = writeInstallOutcome(cwd, record);
  process.stdout.write(`dxkit: ${summarizeInstallOutcome(record)}\n`);
  process.stdout.write(`dxkit: install outcome recorded at ${path.relative(cwd, abs)}\n`);
  return 0;
}

export function runInstallComment(cwd: string): number {
  const record = readInstallOutcome(cwd);
  if (record === null) return 1;
  const rendered = renderInstallOutcomeComment(record);
  process.stdout.write(rendered.markdown);
  process.stderr.write(`${rendered.annotation}\n`);
  return 0;
}
