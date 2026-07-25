# Release policy

dxkit ships frequently, and that is a practice, not an accident. This page
states the policy so the version feed reads as the discipline it is.

## Why the cadence looks the way it does

dxkit is built with the same agentic workflow it exists to make safe. In that
workflow, writing code stops being the bottleneck; verifying it is the
bottleneck. Release frequency therefore tracks verification capacity: a fix
ships when it has passed every gate we can run, not on a calendar.

Two release shapes follow from this:

- **Minor releases (x.Y.0) are batched and deliberate.** A minor collects one
  coherent scope, built and verified as a unit, and lands as a single release.
  It never trickles out as partial features behind the same version line.
- **Patch releases (x.y.Z) are for verified defects, and may ship the same
  day.** When production use surfaces a real defect, the fix is verified,
  regression-tested, and published as soon as it is green. Several past
  patches shipped within hours of a defect being confirmed in a real
  repository. We consider that speed a feature of the policy, not a symptom.
  A patch never carries new scope.

A fast patch cadence with regressions would be churn. A fast patch cadence
where every release passes the full verification bar is responsiveness. The
bar is what makes the difference, so here is the bar.

## What every release passes

Every release, patch or minor, goes through the same pipeline. There are no
exceptions and no manual publishes:

- The full test suite, typechecking of source and tests, lint, and format
  checks.
- The architecture gate: a script that enforces this repository's structural
  rules (single sources of truth, registry-driven dispatch, banned
  duplication patterns) on every commit.
- Cross-ecosystem parity checks, so a fix landed for one language pack cannot
  silently skip the others.
- dxkit's own guardrail. This repository gates itself with the product: the
  same baseline-relative check we ship runs on our CI, and it has blocked our
  own pull requests on real findings. When that happens we fix the finding,
  not the gate.
- Publishing is CI-only. A local `npm publish` is blocked by a guard script,
  and the pipeline publishes with npm provenance after preflighting that the
  tag matches the version, the commit is on the default branch, and CI
  succeeded on that exact commit.

## What version numbers mean

Standard semver, with two clarifications:

- **Behavioral tightenings are declared.** Sometimes a fix makes the gate
  stricter in a way existing users will notice, for example a class of file
  that no longer counts toward a score, or a context in which repo-declared
  commands no longer execute. These are flagged explicitly in the changelog
  with the reasoning, never slipped in silently.
- **Committed artifacts migrate.** Baselines and allowlists carry a scheme
  version. When an upgrade changes how findings are identified,
  `vyuh-dxkit update` migrates committed artifacts automatically rather than
  forcing a re-baseline.

## How to consume releases safely

You do not need to track our cadence. The recommended posture for a gated
repository:

- Pin the dxkit version in your repository (the installer does this).
- Upgrade deliberately with `vyuh-dxkit update`, on your own schedule. It
  refreshes the managed surfaces (workflows, hooks) it owns, migrates your
  baseline when needed, and never touches files you have modified.
- Read the changelog entry for any release marked with a tightening flag
  before upgrading a repository whose gate is a required check.

The `latest` tag is the supported line. If external adoption grows to where a
lagging `stable` tag would protect users, we will add one; until then, that
is a decision we have noted rather than an omission.
