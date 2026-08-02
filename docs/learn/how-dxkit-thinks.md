# How dxkit thinks

One page. If you read nothing else, read this.

## The one-sentence model

dxkit proves that a **change** introduced no new problems, without requiring
the repository to be clean first.

That sentence drives everything else. dxkit is not a linter that shouts about
everything wrong in your repo. It is a gate that answers one question per
change: "did THIS change make things worse?"

## The four pieces

```
baseline  ->  gate  ->  allowlist  ->  lanes
(what is)    (what's   (what we      (what keeps
              new)      accept)       it current)
```

### 1. Baseline: a snapshot of what already exists

`vyuh-dxkit baseline create` scans the repo and records a durable identity
(a fingerprint) for every finding that already exists: secrets, vulnerable
dependencies, static-analysis findings, coverage gaps, lint errors, and more.

Existing findings are **grandfathered**. They do not block anyone. They are
debt you already had, and dxkit never blames the next person to open a PR
for it.

### 2. The gate: only net-new blocks

`vyuh-dxkit guardrail check` re-scans and diffs against the baseline using
those fingerprints. A finding that moved lines, or lives in a renamed file,
still matches its baseline entry. Only findings that are genuinely **new in
this change** can block, and which kinds block is policy
(`.dxkit/policy.json`), not hardcode.

The verdicts:

- **PASSED**: no net-new findings in any blocking category.
- **PASSED with warnings**: net-new findings exist in warn-only categories
  (for example test gaps under the default posture). Read them; nothing
  blocks.
- **BLOCKED** (exit 1): the change introduced at least one finding in a
  blocking category. The output names each finding and the remedy paths.
- **CANNOT GATE** (exit 1): dxkit could not honestly attribute the delta to
  your change, and it refuses to guess in either direction. This is not an
  error in your code. The output names exactly what broke the comparison
  (for example a baseline captured with a different tool version, or a
  baseline older than your merge-base) and the remedy.

CANNOT GATE is the most important verdict to understand: dxkit would rather
refuse to certify than certify something it cannot verify. A tool upgrade
that reports new findings is never blamed on the developer who happened to
open the next PR.

### 3. Allowlist: accepted, on the record

Not every finding should be fixed right now, and some are false positives.
The allowlist is the typed escape hatch:

- `vyuh-dxkit allowlist add` suppresses one finding with a required
  **category** (false-positive, test-fixture, mitigated-externally,
  accepted-risk, deferred) and a required **reason**. Every entry is
  auditable.
- `vyuh-dxkit allowlist defer` is the time-boxed form: the finding stops
  blocking until the expiry date, then **re-blocks**. Deferral is a loan,
  not a write-off.
- `vyuh-dxkit allowlist audit` surfaces expired, soon-to-expire, and
  reason-less entries.

### 4. Lanes: scheduled work that keeps the system honest

Lanes are scheduled GitHub Actions workflows dxkit can install:

- **Baseline refresh** re-captures on a schedule. Newly published dependency
  advisories are held OUT of the baseline and raised as a decision PR:
  merging it defers the advisory for a time-boxed window; fixing means
  upgrading the dependency instead.
- **Dependency bump** proposes dependency upgrades as a PR.
- **Remediation** runs budget-bounded agent tasks (fix the build, improve
  tests, write docs). Anything an agent produces lands **only via a PR that
  passes the same gate as a human change**. The PR discloses who dispatched
  it, the exact prompt, the model, and the spend.

No lane bypasses the gate. That is the point of the design: one gate, every
producer of change goes through it, human or machine.

## The honesty rules underneath

Two disciplines explain most of dxkit's behavior when something looks odd:

1. **A net-new claim requires ruling out every other cause.** A delta can
   come from your change, from a tool upgrade, from a scanner that did not
   run, or from dxkit itself changing what it can see. Only the first may
   block. The others become disclosed warnings or a CANNOT GATE refusal,
   never a silent pass and never a false block.
2. **Unobserved never reads as clean.** If a scanner could not run, dxkit
   says so in the output. "We did not look" and "we looked and found
   nothing" are different statements, and dxkit never lets one masquerade
   as the other.

## Where to go next

- The gate blocked your PR: `docs/learn/quickstart-developer.md`
- You review PRs here: `docs/learn/quickstart-reviewer.md`
- You are setting dxkit up: `docs/learn/quickstart-admin.md`
- Every command: `vyuh-dxkit --help --all` or `vyuh-dxkit capabilities`
