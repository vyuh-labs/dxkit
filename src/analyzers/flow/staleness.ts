/**
 * Flow-contract freshness — how far a committed `served.json` has fallen
 * behind its providers. The committed snapshot is a deliberate lag (the gate
 * is offline and deterministic; refreshes are explicit, reviewed commits), so
 * the honest posture is DISCLOSURE: say when the snapshot was published, which
 * commit each participant's routes were gathered at, and whether that
 * participant's tip has since moved.
 *
 * Two probe tiers, matching where the answer can come from cheaply:
 *   - a participant with a LOCAL checkout → resolve its ref in that checkout
 *     (offline);
 *   - a `repo:`-only participant → one bounded `ls-remote` via the canonical
 *     remote-access module (network; fail-open to `moved: null`).
 *
 * Consumed by DOCTOR (which may probe the network, like its other checks).
 * The per-commit GATE never calls this — it stays offline by design and
 * discloses only what the snapshot itself records (age + provenance).
 */
import * as fs from 'fs';
import * as path from 'path';
import { readServedContract, type ParticipantProvenance } from './contract';
import { readWorkspace } from '../../workspace';
import { resolveRefToSha } from '../../baseline/ref-baseline';
import { remoteTipSha } from '../../baseline/remote-ref';

export interface ParticipantStaleness extends ParticipantProvenance {
  /** The participant's CURRENT tip, when the probe could resolve it. */
  readonly tip: string | null;
  /** true = provider moved since publish; false = snapshot is current;
   *  null = unknown (no recorded sha, or the probe failed / offline). */
  readonly moved: boolean | null;
}

export interface ContractFreshness {
  /** When the committed served.json was published. */
  readonly generatedAt: string;
  /** Commit of THIS repo the snapshot was published at, when recorded. */
  readonly commitSha?: string;
  readonly participants: readonly ParticipantStaleness[];
  /** Any participant confirmed moved — the one-glance staleness verdict. */
  readonly stale: boolean;
}

/**
 * Freshness of the committed served contract, or `null` when the repo commits
 * none (monorepo / not yet published — nothing to disclose). Participants
 * without recorded provenance (a pre-provenance snapshot) yield an empty list;
 * the `generatedAt` age still tells the basic story.
 */
export function contractFreshness(
  cwd: string,
  probeRemote: typeof remoteTipSha = remoteTipSha,
): ContractFreshness | null {
  const contract = readServedContract(cwd);
  if (!contract) return null;

  const byName = new Map((readWorkspace(cwd)?.participants ?? []).map((p) => [p.name, p] as const));

  const participants: ParticipantStaleness[] = (contract.participants ?? []).map((prov) => {
    const ws = byName.get(prov.name);
    let tip: string | null = null;
    if (ws?.path) {
      const abs = path.resolve(cwd, ws.path);
      if (fs.existsSync(abs)) tip = resolveRefToSha(abs, prov.ref ?? ws.ref ?? 'HEAD');
    }
    if (tip === null && ws?.repo) {
      const refArg = prov.ref ?? ws.ref;
      tip = probeRemote({ repo: ws.repo, ...(refArg ? { ref: refArg } : {}) });
    }
    const moved = prov.sha && tip ? prov.sha !== tip : null;
    return { ...prov, tip, moved };
  });

  return {
    generatedAt: contract.generatedAt,
    ...(contract.commitSha ? { commitSha: contract.commitSha } : {}),
    participants,
    stale: participants.some((p) => p.moved === true),
  };
}
