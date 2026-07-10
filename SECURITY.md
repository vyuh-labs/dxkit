# Security Policy

Thank you for helping keep `@vyuhlabs/dxkit` and its users secure.

## Supported Versions

We follow [semver](https://semver.org/). Security fixes ship on the
latest minor of the current major. Older minors do not receive
backports — please upgrade.

| Version | Supported        |
| ------- | ---------------- |
| 3.x.y   | ✅ Latest minor  |
| < 3.0   | ❌ Not supported |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub
issues, pull requests, or discussions.**

Instead, please use GitHub's [Private Vulnerability
Reporting](https://github.com/vyuh-labs/dxkit/security/advisories/new)
to send us a private report. This routes directly to the maintainers
and is the fastest, most secure channel.

Include in your report:

- A description of the vulnerability and its impact.
- The version(s) of `@vyuhlabs/dxkit` affected.
- Steps to reproduce, ideally with a minimal example.
- Any known mitigations or workarounds.
- Whether you intend to publicly disclose the issue, and on what timeline.

## What to Expect

- **Acknowledgement** within 3 business days of receipt.
- **Initial assessment** (confirmed / not-a-vuln / need-more-info)
  within 7 business days.
- **Fix or mitigation plan** communicated within 30 days for
  confirmed issues. Complex issues may take longer; we will keep
  you updated.
- **Coordinated disclosure**: once a fix is ready, we publish a
  GitHub Security Advisory, release the patched version on npm,
  and credit the reporter (unless anonymity is requested).

## Scope

In scope:

- The published `@vyuhlabs/dxkit` package on npm.
- The CLI binary `vyuh-dxkit` and its subcommands.
- The `dxkit-graphify` Python helper bundled with the package.
- This repository's CI/CD pipeline and supply-chain configuration.

Out of scope:

- Vulnerabilities in third-party tools dxkit invokes (`gitleaks`,
  `semgrep`, `jscpd`, `cloc`, `npm-audit`, etc.) — please report
  those upstream.
- Vulnerabilities in repos analyzed _by_ dxkit. Analysis reads source
  trees without executing them. The gate features that DO run repo
  commands — the correctness floor (build/test commands), custom
  checks, and the lint gate — execute only commands declared in the
  repo's own committed configuration (`.dxkit/policy.json`, the
  project's build files), the same trust boundary as the repo's npm
  scripts or CI config. A malicious command in a repo you choose to
  run dxkit against is that repo's compromise, not dxkit's; a way to
  make dxkit run a command from anywhere else IS in scope — please
  report it.
- Issues that require physical access to the user's machine or
  a privileged account.

## Bounty

We do not currently offer a paid bounty program, but we will
publicly credit responsible disclosure in the release notes and
the GitHub Security Advisory unless you prefer to remain anonymous.

## PGP

If you require encrypted communication, please mention this in your
initial GitHub report and we will arrange a key exchange.
