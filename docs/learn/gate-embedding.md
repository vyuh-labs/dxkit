# Embedding the gate: one-shot verdicts on trees you did not init

For teams that want dxkit as a **verdict engine** inside their own product:
a code-generation pipeline that must judge every package it emits, a
conversion factory that ships a definition-of-done, an on-prem image whose
every byte is reviewed. No git history required, no repo onboarding, no
hooks or CI installed. One call in, one machine-readable verdict out.

## The model: subject, prior, policy

Every dxkit gate answers the same question through the same engine:

> Given a **subject** (the tree being judged), a **prior** (what was already
> known or accepted), and a **policy** (the definition of done), is anything
> here net-new and blocking?

The `guardrail` command is that engine pointed at a git repo with a
committed baseline. The `gate` command is the same engine pointed at a bare
directory, with two priors to choose from:

- **Fresh** (the default): there is no prior, so everything found is
  net-new by construction. This is the right prior for a freshly generated
  or converted package: nothing in it is grandfathered, because nothing in
  it existed before.
- **Tree baseline** (`--baseline <dir>`): the prior is another directory,
  typically the generated original before a human or an agent edited it.
  The gate diffs the two trees with the same finding-identity machinery the
  repo guardrail uses, so a pre-existing finding in the original never
  blocks the edit that did not introduce it.

The verdicts, fingerprints, and classification are identical to the repo
guardrail's. That is a tested invariant, not a goal: the parity suite runs
both commands over shared fixtures and asserts the verdicts and the
per-finding fingerprints match.

## Quickstart

```bash
npm install -D vyuh-dxkit
npx vyuh-dxkit tools install          # provision scanners (gitleaks, semgrep, osv-scanner...)
npx vyuh-dxkit init --gate-only       # writes ONLY .dxkit/policy.json, nothing else
npx vyuh-dxkit gate ./the-package --policy .dxkit/policy.json --json
```

Exit codes are the contract:

| exit | status        | meaning                                                |
| ---- | ------------- | ------------------------------------------------------ |
| 0    | `passed`      | nothing net-new and blocking under this policy         |
| 1    | `blocked`     | at least one net-new blocking finding (each one named) |
| 2    | `cannot_gate` | dxkit refuses to certify (and says exactly why)        |

`cannot_gate` is deliberate: when dxkit cannot rule out every non-developer
cause of a delta, it refuses rather than guessing. A refusal always carries
the reason and the remedy in the output.

## The policy document is the definition of done

`--policy` names a policy file, and the verdict names it back: `verdict.v1`
carries the policy `id`, `version`, and a content hash, so a verdict is
never separable from the rules it was judged under. Version the policy file
in whatever repo owns your pipeline and treat changes to it like changes to
a CI workflow.

A conversion-package policy usually combines three layers:

1. **A posture preset** for the scanner findings (`security-only` blocks
   net-new secrets, critical/high SAST, and reachable dependency
   vulnerabilities).
2. **Text rules**: declarative pattern checks that run in-process with no
   command execution, so they are safe on untrusted trees.

   ```jsonc
   {
     "checks": [
       {
         "name": "no_placeholder",
         "pattern": "\\b(TODO|FIXME|XXX)\\b",
         "globs": ["src/**", "tests/**"],
         "blocking": true,
       },
     ],
   }
   ```

3. **Command checks and the correctness floor** (compile + tests), which
   execute code from the tree and therefore require trust (next section).

## Trust is explicit

By default the gate treats the subject tree as **untrusted**: it scans the
bytes but never executes anything from the tree. Command checks and the
correctness floor are skipped with a disclosed `skipped-untrusted` cause in
the output, never silently.

Pass `--trusted` only when you are prepared to execute the tree's own code
(its test suite, its build). If your pipeline judges trees from sources you
do not control, keep the gate untrusted and use the external-wrap pattern
instead: your sandbox owns execution, the gate owns judgment.

```bash
docker run --network=none -v "$PKG:/work" your-sandbox-image \
  sh -c "cd /work && npm ci && npm test"           # execution, isolated by YOU
vyuh-dxkit gate "$PKG" --policy dod.json --json     # judgment, no execution
```

dxkit deliberately does not ship its own sandbox. Isolation guarantees
belong to the layer that already owns your threat model (containers, VMs,
your CI runner), and a bundled half-sandbox would be a false promise. The
gate's contribution is that it never _needs_ to execute untrusted code to
produce the scan verdict, and that every execution-dependent check it
skipped is named in the verdict rather than silently absent.

## Air-gapped and on-prem operation

Three pieces make the gate reproducible offline:

- **`vyuh-dxkit tools bom --json`** renders the full tool bill of
  materials from the registry: every scanner, its pinned version, its
  download sha256, and how it is installed. Feed it to your image review.
- **`vyuh-dxkit tools install`** provisions those scanners with
  checksum-verified downloads (fail-closed on mismatch). Run it at image
  build time so the runtime image needs no network.
- **`--advisory-db <dir>`** points the dependency audit at an offline OSV
  advisory snapshot instead of the live feed. The snapshot directory
  carries a `VERSION` file, and that version is part of the verdict's
  recall context: two verdicts from different snapshots are never silently
  compared as if they saw the same advisories.

A minimal embed image:

```dockerfile
FROM node:22-slim
RUN npm install -g vyuh-dxkit && vyuh-dxkit tools install
COPY advisory-db /opt/advisory-db          # your mirrored OSV snapshot
COPY dod-policy.json /opt/dod-policy.json
ENTRYPOINT ["vyuh-dxkit", "gate", "/work", \
  "--policy", "/opt/dod-policy.json", \
  "--advisory-db", "/opt/advisory-db", "--json"]
```

## Reading verdict.v1

The `--json` output is the `verdict.v1` wire schema (frozen in the
extension SDK, additive-only): status and exit code, the policy identity,
every finding with its stable fingerprint, every check that ran or was
skipped **with the skip's cause**, the correctness-floor result, any
refusals, and a receipt block your pipeline can store as evidence. Parse
the schema, not the human text; the human rendering may improve between
versions, the wire schema only grows.

## Judging many trees as one estate

When the subject is not one package but a workspace of services that must
compose (calls resolve, declared end-to-end flows hold), use
`gate --workspace`. That is its own guide: see **Wave gating**.
