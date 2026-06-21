/**
 * `vyuh-dxkit issue` — open a pre-filled GitHub Issue against
 * `vyuh-labs/dxkit` in the customer's default browser.
 *
 * The dxkit team triages bugs / false-positive reports / feature
 * requests in GitHub Issues. Sending customers there directly (vs
 * email / a custom form) keeps:
 *
 *   - Triage centralized (labels, assignees, dedup search)
 *   - Status visible to the customer (they can subscribe to their
 *     own issue, see comments, get notified on resolution)
 *   - Zero infra for us to maintain (no SMTP, no webhook, no DB)
 *
 * The CLI builds a URL with pre-filled title + body + labels and
 * opens it via the platform's default browser. Customer reviews
 * the prefill before clicking "Submit new issue" — nothing is
 * sent without their explicit click.
 *
 * Body prefill includes:
 *   - dxkit version (from package.json)
 *   - Node version, platform, arch (so triage can reproduce)
 *   - Issue type + optional fingerprint (when reporting a
 *     false-positive on a specific finding)
 *   - Customer's `--about` text (free-form description) OR a
 *     "TODO: describe..." placeholder
 *
 * # Privacy
 *
 * NOTHING is submitted automatically. The CLI opens a URL with
 * query-string pre-fill; the customer reviews + edits + clicks
 * "Submit." All env data in the prefill is the kind already
 * visible in the dxkit CLI `--version` — no source content, no
 * customer-identifying paths beyond the project name.
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as logger from './logger';

export const ISSUE_TYPES = [
  'false-positive',
  'missing-finding',
  'bug',
  'feature-request',
  'docs',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** Per-type GitHub label that will be pre-applied. The labels
 *  themselves must exist on the repo; dxkit's repo carries these
 *  by convention. */
const LABEL_BY_TYPE: Readonly<Record<IssueType, string>> = Object.freeze({
  'false-positive': 'false-positive',
  'missing-finding': 'missing-finding',
  bug: 'bug',
  'feature-request': 'enhancement',
  docs: 'documentation',
});

/** Per-type title prefix surfaced in the GitHub Issues list. */
const TITLE_PREFIX_BY_TYPE: Readonly<Record<IssueType, string>> = Object.freeze({
  'false-positive': 'False positive',
  'missing-finding': 'Missing finding',
  bug: 'Bug',
  'feature-request': 'Feature request',
  docs: 'Docs',
});

const ISSUES_BASE_URL = 'https://github.com/vyuh-labs/dxkit/issues/new';

export interface IssueSubmitOpts {
  readonly type?: string;
  readonly fingerprint?: string;
  readonly about?: string;
  /** Print the URL to stdout instead of opening a browser. Useful
   *  in CI / SSH sessions without a default browser handler. */
  readonly noBrowser?: boolean;
}

export interface BuildIssueUrlInput {
  readonly type: IssueType;
  readonly about?: string;
  readonly fingerprint?: string;
  readonly dxkitVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
}

/**
 * Pure function: build the GitHub Issues "new issue" URL with
 * pre-filled title / body / labels. Exposed for unit testing —
 * callers without browser-open side effects can verify the URL
 * shape directly.
 */
export function buildIssueUrl(input: BuildIssueUrlInput): string {
  const params = new URLSearchParams();
  params.set('title', buildTitle(input));
  params.set('body', buildBody(input));
  params.set('labels', LABEL_BY_TYPE[input.type]);
  return `${ISSUES_BASE_URL}?${params.toString()}`;
}

export async function runIssueSubmit(cwd: string, opts: IssueSubmitOpts): Promise<void> {
  const type = parseIssueType(opts.type);
  const url = buildIssueUrl({
    type,
    about: opts.about,
    fingerprint: opts.fingerprint?.trim() || undefined,
    dxkitVersion: readDxkitVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  if (opts.noBrowser) {
    // Print URL to stdout so callers in CI / SSH can copy.
    process.stdout.write(url + '\n');
    return;
  }

  logger.info(`Opening pre-filled issue in your browser…`);
  logger.info(`If the browser doesn't open, copy this URL:`);
  logger.info(`  ${url}`);
  void openBrowser(cwd, url);
}

// ─── Internals ────────────────────────────────────────────────────────────

function parseIssueType(raw: string | undefined): IssueType {
  if (!raw) {
    logger.fail(`--type is required. One of: ${ISSUE_TYPES.join(', ')}.`);
    process.exit(1);
  }
  if (!(ISSUE_TYPES as readonly string[]).includes(raw)) {
    logger.fail(
      `--type ${JSON.stringify(raw)} is not a known issue type. ` +
        `One of: ${ISSUE_TYPES.join(', ')}.`,
    );
    process.exit(1);
  }
  return raw as IssueType;
}

function buildTitle(input: BuildIssueUrlInput): string {
  const prefix = TITLE_PREFIX_BY_TYPE[input.type];
  const aboutShort = input.about ? truncate(input.about, 60) : '';
  if (aboutShort) {
    return `[${prefix}] ${aboutShort}`;
  }
  if (input.fingerprint) {
    return `[${prefix}] finding ${input.fingerprint}`;
  }
  return `[${prefix}] `;
}

function buildBody(input: BuildIssueUrlInput): string {
  const lines: string[] = [];
  lines.push(`**Type:** ${input.type}`);
  lines.push(`**dxkit version:** ${input.dxkitVersion}`);
  lines.push(`**Node version:** ${input.nodeVersion}`);
  lines.push(`**Platform:** ${input.platform} / ${input.arch}`);
  if (input.fingerprint) {
    lines.push(`**Finding fingerprint:** \`${input.fingerprint}\``);
  }
  lines.push('');
  lines.push('## What happened');
  lines.push('');
  lines.push(input.about ?? '<!-- Describe what you observed -->');
  lines.push('');
  lines.push('## What you expected');
  lines.push('');
  lines.push('<!-- Describe the behavior you expected -->');
  lines.push('');
  lines.push('## How to reproduce');
  lines.push('');
  lines.push('<!-- Minimal repro steps. Pseudo-code / sample input is fine. -->');
  lines.push('');
  lines.push('## Anything else');
  lines.push('');
  lines.push('<!-- Logs, screenshots, related issues, etc. -->');
  return lines.join('\n');
}

function readDxkitVersion(): string {
  try {
    // Two possible locations: same package as this module (dev / source)
    // and `node_modules/@vyuhlabs/dxkit/package.json` (installed).
    // __dirname points at dist/ or src/ depending on build; resolve
    // upward to find package.json.
    const candidates = [
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, '..', '..', 'package.json'),
    ];
    for (const candidate of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
        if (typeof pkg.version === 'string') return pkg.version;
      } catch {
        continue;
      }
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Open `url` in the customer's default browser. Detached so the CLI
 * exits without waiting for the browser process. Errors are
 * swallowed — the URL is also printed to stdout so the customer can
 * copy it manually if the open fails (corporate workstation, no
 * `xdg-open` configured, etc.).
 */
function openBrowser(cwd: string, url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    // Linux / WSL / *BSD — xdg-open is the freedesktop standard.
    // WSL2 environments without an X server fall through to no-op
    // (the URL was already printed by the caller).
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Silent — the URL is already in the customer's terminal.
  }
}
