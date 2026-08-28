# Lane tokens: how unattended lanes authenticate, and why it matters

Every dxkit lane that writes back to GitHub — remediation PRs, dependency
bumps, baseline anchors, advisory decision PRs, comment-defer commits —
needs a credential, and which credential it uses decides whether the PRs
it opens actually run checks. This guide explains the three tiers, how to
set up the preferred one, and the guarantees the lanes enforce around
credential lifetime and delivery.

## Why the default token is not enough

GitHub never triggers workflow runs for pushes or PRs made with a
workflow's own `GITHUB_TOKEN` (the robot-loop rule). A lane that pushes
with it produces PRs that show **no checks** — unmergeable under branch
protection — and a defer commit pushed with it never re-runs the PR's
validation. It works, but degraded; the lanes disclose this mode loudly
rather than letting it pass silently.

## The three tiers

Every workflow dxkit installs resolves its credential through one chain,
best tier first:

1. **GitHub App** (preferred). The workflow mints a short-lived
   installation token per run. No billed seat, no long-lived secret in
   circulation, PRs attributed to your app's own bot identity, and the
   PAT-expiry failure class cannot exist.
2. **`DXKIT_BOT_TOKEN`** — a PAT with repo scope, usually belonging to a
   machine account. Fully supported; the classic trade-offs apply (a
   billed seat, rotation, a long-lived credential).
3. **The default `GITHUB_TOKEN`** — the degraded tier described above.
   The lane still works and says so in its log ("Disclose token mode")
   and in a workflow notice naming the remedy.

Configuring nothing gives you tier 3; configuring either credential is
picked up automatically with no workflow edits.

## Setting up the App tier (once, about five minutes)

1. Org settings → Developer settings → GitHub Apps → **New GitHub App**.
   Name it what you want lane PRs authored as (`yourorg-dxkit` shows as
   `yourorg-dxkit[bot]`).
2. Webhook: uncheck **Active** — the lanes mint tokens; nothing calls
   back.
3. Repository permissions, exactly two: **Contents: Read and write** and
   **Pull requests: Read and write**.
4. Create, note the numeric **App ID**, and generate a **private key**
   (downloads a `.pem`).
5. Install the App on the org — all repositories is reasonable (the
   minted token is scoped per run to the repo the workflow runs in), or
   selected repositories for tighter control.
6. Org (or repo) Actions settings: variable `DXKIT_APP_ID` = the numeric
   id; secret `DXKIT_APP_PRIVATE_KEY` = the full `.pem` contents. The id
   is a _variable_, not a secret, because workflow `if:` conditions
   cannot read secrets.
7. Delete the local `.pem`.

**The classic pitfall:** if your org scopes secrets/variables to selected
repositories, the repos running lanes must be in both access lists. An
org secret whose access list omits the repo arrives **empty** at runtime
with no error anywhere — the lane then silently degrades a tier. Check
the lane run's "Disclose token mode" step output when in doubt; it names
the tier that actually resolved.

## The one-hour lifetime, and how the lanes handle it

GitHub hard-caps App installation tokens at one hour, with no
longer-lived form. The remediation lane can run for well over an hour
(the agent budget plus a verify tail that scales with repo size), so it
takes three precautions:

- it **re-mints** the token immediately before the agent task, so the
  working credential's hour starts at agent launch rather than at job
  start;
- it **lands in two phases**: the task step performs no pushes and
  instead writes a landing record (the verified head, the assembled PR,
  the order-ledger rows), and a post-task step mints a FRESH token and
  runs `remediate land`, whose credential starts its hour at delivery
  time. The land step refuses a checkout whose HEAD is no longer the
  recorded verified head, so stale or foreign commits are never pushed;
  a salvage draft from a failed task still lands through the same
  record. Because delivery no longer depends on a token minted before
  the task, the agent's wall-clock budget is not clamped to the token
  lifetime (workflows installed before 4.4.7 still land inline and keep
  the 45-minute App-tier clamp until `vyuh-dxkit update` refreshes
  them);
- it treats the credential like any other delivery precondition: the
  workflow installs exactly **one** credential (the checkout persists
  none), asserts that exactly one exists, and **proves it with a live
  `ls-remote` before the agent spawns**. A broken credential fails the
  run at zero agent cost, at setup — never at delivery after the budget
  is spent.

## Verifying what a repo will use

- `vyuh-dxkit doctor` reports the configured tier. (Org-level
  configuration may not be readable from a local machine's token; the
  lane run's own "Disclose token mode" step is always authoritative.)
- Any lane run's log contains `token tier: …` near the top.
- On the App tier, lane PRs are authored by `your-app[bot]` and their
  checks trigger normally — that is the observable win.
