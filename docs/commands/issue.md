# `vyuh-dxkit issue`

Open a pre-filled GitHub Issue against `vyuh-labs/dxkit` in your
default browser. Use it when you want to report a false positive,
a missing finding, a dxkit bug, a feature request, or a docs gap.

The dxkit team triages issues in GitHub Issues — this CLI is the
fastest path from "I noticed something" to "the team has a ticket
they can search, dedup, and assign."

## Why this exists

The team needs customer signal to improve dxkit:

- **False positives** tell us a scanner rule is too noisy.
- **Missing findings** tell us a rule is too narrow.
- **Bugs** tell us the install / hook / report pipeline broke.
- **Feature requests** tell us where the product should grow.
- **Docs gaps** tell us where the install/usage story confuses real users.

Sending these to GitHub Issues (rather than email or a web form)
keeps triage centralized — labels, assignees, dedup search,
notifications. You also get a public link to your own issue so you
can subscribe to status updates.

## Usage

```bash
# Interactive — opens browser to the new-issue form pre-filled
# with env info + your description
vyuh-dxkit issue --type=bug --about="vyuh-dxkit doctor crashes on macOS arm64"

# Report a false positive against a specific finding
vyuh-dxkit issue --type=false-positive \
    --fingerprint=a3f9c0e8b7d2e1f4 \
    --about="the scanner flags my intentional test-fixture API key"

# Feature request — no fingerprint needed
vyuh-dxkit issue --type=feature-request \
    --about="add SARIF export to vulnerabilities subcommand"

# Print URL to stdout instead of opening a browser
# (useful in CI / SSH sessions without a browser handler)
vyuh-dxkit issue --type=docs --about="..." --no-browser
```

## Types

| `--type`          | When to use                                              | GitHub label      |
| ----------------- | -------------------------------------------------------- | ----------------- |
| `false-positive`  | Scanner flagged something that isn't actually an issue   | `false-positive`  |
| `missing-finding` | Scanner should have flagged something but didn't         | `missing-finding` |
| `bug`             | dxkit itself is broken (CLI crashes, report wrong, etc.) | `bug`             |
| `feature-request` | New functionality you'd like                             | `enhancement`     |
| `docs`            | Documentation is wrong / missing / unclear               | `documentation`   |

## What gets pre-filled

The CLI builds the GitHub Issues URL with:

- **Title**: `[Type] <truncated about>` or `[Type] finding <fingerprint>`
- **Labels**: per-type from the table above
- **Body**: dxkit version, Node version, platform/arch, your
  `--about` description, and optionally the finding fingerprint —
  plus placeholder sections for "what you expected," "how to
  reproduce," and "anything else"

Example body:

```markdown
**Type:** false-positive
**dxkit version:** 2.6.0
**Node version:** v22.1.0
**Platform:** linux / x64
**Finding fingerprint:** `a3f9c0e8b7d2e1f4`

## What happened

the scanner flags my intentional test-fixture API key

## What you expected

<!-- Describe the behavior you expected -->

...
```

You review the prefill in the browser and edit before clicking
"Submit new issue."

## Privacy

**Nothing is submitted automatically.** The CLI builds a URL with
query-string pre-fill and either opens it in your browser or prints
it to stdout. The submission happens when YOU click "Submit" in the
browser, after reviewing what's pre-filled.

The prefill contains:

- dxkit version (already visible in `npx vyuh-dxkit --version`)
- Node version + platform + arch (standard env info)
- Your `--about` text (whatever you typed)
- The fingerprint if you passed `--fingerprint` (a 16-char hex
  identifier; useful for reproducing the scanner's behavior)

The prefill does NOT contain:

- Source code from your repo
- Your project name or any path that would identify the customer
- Any allowlist reason / addedBy data

If you want to include more context (logs, screenshots), you can
add them in the browser before submitting.

## Flags

```
--type=<type>             Required. One of: false-positive, missing-finding,
                          bug, feature-request, docs.
--about=<text>            Free-form description of the issue. Truncated to
                          60 chars in the title; full text in the body.
--fingerprint=<id>        The 16-char hex fingerprint of a specific finding.
                          Surfaces in the body so triage can reproduce.
--no-browser              Print the URL to stdout instead of opening a browser.
                          Use in CI / SSH sessions.
```

## Related

- [`vyuh-dxkit allowlist add --category=false-positive`](./allowlist.md) — suppress a specific false positive locally while you wait for the upstream fix
- [`vyuh-dxkit doctor`](./doctor.md) — diagnose install issues before reporting a bug
- The [`dxkit-fix` skill](https://github.com/vyuh-labs/dxkit) walks you through doctor-driven repair before you reach for an issue
