/**
 * The in-loop Stop-gate wiring (#305, 4.4.1 WP3).
 *
 * The lane's flagship design is the gate INSIDE the loop: the driver arms
 * `DXKIT_LOOP_ACTIVE=1` so any stop attempt re-runs the guardrail and
 * bounces net-new findings back into the live session. What actually
 * happened on every CI lane run ever: the Stop hook lives in the repo's
 * committed `.claude/settings.json`, a fresh runner checkout is an
 * UNTRUSTED workspace, and the agent CLI ignores project settings there —
 * so the in-loop gate was silently absent and only the post-run frame
 * verification (the backstop, never the primary) gated. Live consequence:
 * an agent installed dependencies carrying twelve known vulnerabilities
 * and burned its whole turn budget; a working Stop-gate would have blocked
 * its first completion attempt in-session with the findings and turns left
 * to repair.
 *
 * Four duties, one module (the fourth added in 4.4.3 — the live class:
 * a repo that never installed the loop pack has no committed Stop hook, so
 * every lane run on it was backstop-only by construction; the gate is the
 * LANE's requirement, so the lane installs it at runner scope itself):
 *
 * 1. PRE-TRUST (`preTrustAgentCheckout`): before spawning, the lane marks
 *    its own checkout trusted in the runner's `~/.claude.json`
 *    (`projects[<abs cwd>].hasTrustDialogAccepted: true`). This is a
 *    deliberate, documented trust decision on the Rule-17 doctrine: the
 *    lane checks out the maintainers' own default branch — the same tree
 *    whose npm scripts and workflows CI already executes — so its
 *    committed `.claude/settings.json` is inside that trust boundary. CI
 *    runs only (`ci: true`): a maintainer's local `~/.claude.json` is
 *    theirs, and dxkit never modifies it uninvited.
 * 2. PROBE (`probeStopGateWiring`): positive evidence, pre-spawn, that the
 *    hook would actually LOAD — the committed settings declare a Stop
 *    hook, the workspace reads as trusted, and (for the standard dxkit
 *    hook body) the CLI it invokes resolves here.
 * 3. DISCLOSE (`armInLoopGate` → `InLoopGateStatus`): the envelope carries
 *    `in-loop-gated` vs `backstop-only` with the reason — a run without
 *    the in-loop gate must never read identically to one with it.
 *
 * Structural limit, disclosed rather than hidden: a `max_turns` kill never
 * reaches a stop attempt, so even a wired Stop-gate cannot fire AT the
 * cap — in-loop gating helps every completion attempt before it, and the
 * post-run frame remains the final word.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDxkitCli } from '../self-invocation';
import { STOP_HOOK_COMMAND, STOP_HOOK_TIMEOUT_SECONDS } from '../loop/scaffold';

/** The envelope disclosure: was the in-loop Stop-gate actually wired? */
export interface InLoopGateStatus {
  readonly mode: 'in-loop-gated' | 'backstop-only';
  /** Why (both modes): what was verified, or the first missing link. */
  readonly reason: string;
}

export interface AgentTrustOptions {
  /** The runner's home dir (injectable for tests). Default: os.homedir(). */
  readonly home?: string;
  /** Injectable for tests: does `vyuh-dxkit` resolve in this checkout?
   *  Default: the ONE Rule-14 resolver (`resolveDxkitCli`). */
  readonly cliResolves?: (cwd: string) => boolean;
}

/**
 * Mark `cwd` trusted in `<home>/.claude.json`, preserving everything else
 * in the file. Returns whether the write applied; a failure is a reason,
 * never a throw (the probe will then honestly report backstop-only).
 */
export function preTrustAgentCheckout(
  cwd: string,
  opts: AgentTrustOptions = {},
): { readonly applied: boolean; readonly reason?: string } {
  const home = opts.home ?? os.homedir();
  const configPath = path.join(home, '.claude.json');
  const projectKey = path.resolve(cwd);
  try {
    let doc: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      doc = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      if (typeof doc !== 'object' || doc === null) doc = {};
    }
    const projects =
      typeof doc.projects === 'object' && doc.projects !== null
        ? (doc.projects as Record<string, unknown>)
        : {};
    const existing =
      typeof projects[projectKey] === 'object' && projects[projectKey] !== null
        ? (projects[projectKey] as Record<string, unknown>)
        : {};
    doc.projects = { ...projects, [projectKey]: { ...existing, hasTrustDialogAccepted: true } };
    fs.writeFileSync(configPath, JSON.stringify(doc, null, 2) + '\n');
    return { applied: true };
  } catch (err) {
    return {
      applied: false,
      reason: `could not write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Does `<home>/.claude.json` mark `cwd` trusted? */
export function checkoutTrusted(cwd: string, opts: AgentTrustOptions = {}): boolean {
  const home = opts.home ?? os.homedir();
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: unknown }>;
    };
    return doc.projects?.[path.resolve(cwd)]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

/** The Stop-hook commands declared in one settings file, or null when the
 *  file/hook is absent or unparseable. */
function stopHookCommandsIn(settingsPath: string): string[] | null {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const doc = JSON.parse(raw) as {
      hooks?: { Stop?: Array<{ hooks?: Array<{ command?: unknown }> }> };
    };
    const commands = (doc.hooks?.Stop ?? [])
      .flatMap((m) => m.hooks ?? [])
      .map((h) => h.command)
      .filter((c): c is string => typeof c === 'string');
    return commands.length > 0 ? commands : null;
  } catch {
    return null;
  }
}

/** Where the agent CLI reads Stop hooks for a spawn in `cwd`: the checkout's
 *  committed settings AND the runner's user-scope settings (both merge at
 *  runtime). Returns the commands plus which scope supplied them. */
function stopHookCommands(
  cwd: string,
  opts: AgentTrustOptions = {},
): { commands: string[]; scope: 'project' | 'runner' | 'both' } | null {
  const home = opts.home ?? os.homedir();
  const project = stopHookCommandsIn(path.join(cwd, '.claude', 'settings.json'));
  const runner = stopHookCommandsIn(path.join(home, '.claude', 'settings.json'));
  if (project && runner) return { commands: [...project, ...runner], scope: 'both' };
  if (project) return { commands: project, scope: 'project' };
  if (runner) return { commands: runner, scope: 'runner' };
  return null;
}

/**
 * The lane-owned arming half (4.4.3): when the CHECKOUT carries no Stop
 * hook, install the standard dxkit Stop-gate into the RUNNER's user-scope
 * `~/.claude/settings.json`. The in-loop gate is the LANE's requirement —
 * the lane is the party spawning an agent that must be gated — so it must
 * not depend on whether the repo opted into the loop pack (the live class:
 * every lane run on a repo without committed loop hooks was silently
 * backstop-only, disclosed but unfixable from the repo side).
 *
 * User scope deliberately, not the checkout: the runner sweeps the agent's
 * uncommitted work into the landing/salvage commit, so a hook injected
 * into the WORKTREE could leak into the landed PR. The runner's own home
 * is ephemeral CI state, invisible to the landed diff, and merges into the
 * spawned agent's settings exactly like a developer's user settings. CI
 * runs only — a maintainer's local `~/.claude/settings.json` is theirs.
 *
 * Merge-preserving and idempotent, same discipline as the scaffold's
 * project-settings writer; the ONE hook body (`STOP_HOOK_COMMAND`, Rule 2).
 */
export function ensureRunnerStopHook(
  cwd: string,
  opts: AgentTrustOptions = {},
): { readonly applied: boolean; readonly reason?: string } {
  const existing = stopHookCommands(cwd, opts);
  if (existing !== null) return { applied: false, reason: 'a Stop hook is already declared' };
  const home = opts.home ?? os.homedir();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  try {
    let doc: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null) doc = parsed as Record<string, unknown>;
    }
    const hooks =
      typeof doc.hooks === 'object' && doc.hooks !== null
        ? (doc.hooks as Record<string, unknown>)
        : {};
    const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
    doc.hooks = {
      ...hooks,
      Stop: [
        ...stop,
        {
          hooks: [
            { type: 'command', command: STOP_HOOK_COMMAND, timeout: STOP_HOOK_TIMEOUT_SECONDS },
          ],
        },
      ],
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(doc, null, 2) + '\n');
    return { applied: true };
  } catch (err) {
    return {
      applied: false,
      reason: `could not write ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Positive-evidence probe: would the Stop-gate actually load for a spawn in
 * `cwd`? Claims `in-loop-gated` only when every verifiable link holds; the
 * first missing link is the reason. Biased toward `backstop-only` — the
 * label this exists to kill is "armed" without evidence.
 */
export function probeStopGateWiring(cwd: string, opts: AgentTrustOptions = {}): InLoopGateStatus {
  const declared = stopHookCommands(cwd, opts);
  if (declared === null) {
    return {
      mode: 'backstop-only',
      reason:
        'no Stop hook in the checkout’s .claude/settings.json or the runner’s user settings — ' +
        'the loop cannot self-verify; post-run verification is the gate',
    };
  }
  const commands = declared.commands;
  if (!checkoutTrusted(cwd, opts)) {
    return {
      mode: 'backstop-only',
      reason:
        'the checkout is not a trusted workspace, so the agent CLI ignores its committed ' +
        '.claude/settings.json and the Stop hook never loads — post-run verification is the gate',
    };
  }
  // For the standard dxkit hook body, verify the CLI it invokes resolves
  // here; a custom command is present-but-not-probed (still armed — the
  // settings + trust links are verified, and inventing a refusal for a
  // command dxkit does not own would be a false backstop label).
  const usesDxkitCli = commands.some((c) => c.includes('vyuh-dxkit'));
  const cliResolves = opts.cliResolves ?? ((dir: string) => resolveDxkitCli(dir).ok);
  if (usesDxkitCli && !cliResolves(cwd)) {
    return {
      mode: 'backstop-only',
      reason:
        'the Stop hook invokes vyuh-dxkit but it does not resolve here (no project-local or ' +
        'global install) — the hook would 404 at fire time; post-run verification is the gate',
    };
  }
  return {
    mode: 'in-loop-gated',
    reason:
      `Stop hook declared (${
        declared.scope === 'project'
          ? 'committed settings'
          : declared.scope === 'runner'
            ? 'installed by the lane at runner scope'
            : 'committed settings + runner scope'
      }), workspace trusted, hook command resolves — ` +
      'stop attempts re-run the guardrail in-session (a max_turns kill still never reaches a ' +
      'stop attempt; the post-run frame remains the final word)',
  };
}

/**
 * The lane's one entry point, called by the runner before the driver
 * spawns: pre-trust the checkout (CI runs only — the #305 trust doctrine),
 * then probe and return the envelope disclosure.
 */
export function armInLoopGate(
  cwd: string,
  opts: AgentTrustOptions & { readonly ci: boolean },
): InLoopGateStatus {
  if (opts.ci) {
    preTrustAgentCheckout(cwd, opts);
    // The gate is the lane's own guarantee (4.4.3): a repo that never
    // installed the loop pack still gets an armed Stop-gate, via the
    // runner's user-scope settings. A failed injection is not fatal here —
    // the probe below then honestly reports backstop-only with the gap.
    ensureRunnerStopHook(cwd, opts);
  }
  return probeStopGateWiring(cwd, opts);
}
