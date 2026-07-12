/**
 * Redaction for shareable evidence — `evaluate --redact`.
 *
 * The pipeline already guarantees no raw secret VALUES reach the evidence
 * (secret producers store salted HMACs only). What redaction removes is
 * repo-internal STRUCTURE a user may not want in a pasted/shared document:
 * file paths, line numbers, and finding locators. Kinds, severities,
 * verdicts, counts, timings, and coverage stay — the shareable story is
 * "what the gate decided and what it cost", not "where our code lives".
 *
 * Pure and lossy by design: a redacted doc says so in `notes`, and the
 * un-redacted original is never mutated.
 */
import type { GuardrailJsonPayload } from '../baseline/check-renderers';
import type { EvaluateEvidenceDoc, EvaluateRunEvidence } from './evidence';

const REDACTION_NOTE =
  'Redacted for sharing: file paths, line numbers, and locators removed. ' +
  'Kinds, severities, verdicts, and timings are unchanged.';

function redactPayload(payload: GuardrailJsonPayload): GuardrailJsonPayload {
  return {
    ...payload,
    pairs: payload.pairs.map((p) => ({ ...p, file: undefined, line: undefined })),
    flowGate: payload.flowGate && {
      ...payload.flowGate,
      findings: payload.flowGate.findings.map((f) => ({ ...f, file: '', line: 0 })),
      suppressed: payload.flowGate.suppressed.map((f) => ({ ...f, file: '', line: 0 })),
    },
    schemaDriftGate: payload.schemaDriftGate && {
      ...payload.schemaDriftGate,
      findings: payload.schemaDriftGate.findings.map((f) => ({ ...f, file: '', line: 0 })),
      suppressed: payload.schemaDriftGate.suppressed.map((f) => ({ ...f, file: '', line: 0 })),
    },
  };
}

function redactRun(run: EvaluateRunEvidence): EvaluateRunEvidence {
  return {
    ...run,
    blocking: run.blocking.map((b) => ({ kind: b.kind, severity: b.severity })),
    guardrail: run.guardrail && redactPayload(run.guardrail),
  };
}

export function redactEvidence(doc: EvaluateEvidenceDoc): EvaluateEvidenceDoc {
  return {
    ...doc,
    runs: doc.runs.map(redactRun),
    notes: [...doc.notes, REDACTION_NOTE],
  };
}
