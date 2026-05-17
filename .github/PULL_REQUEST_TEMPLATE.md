<!--
Thanks for contributing to @vyuhlabs/dxkit! A few quick guidelines:

  - Keep PRs scoped to one logical change. Multiple unrelated changes
    are easier to review (and revert) as separate PRs.
  - Run `npm run build && npm run test:run && npm run lint` before
    pushing. Pre-commit hooks will also fail loudly if anything's off.
  - If your change touches scoring, language packs, exclusions, or
    tool invocation, re-read CLAUDE.md — it captures the architectural
    rules these areas must follow.
-->

## Summary

<!-- One or two sentences describing what changed and why. -->

## Motivation

<!-- What problem does this solve, or what capability does it add?
     Link to any related issue: "Closes #123" / "Fixes #456" -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] New language pack (adds support for an additional language)
- [ ] Scoring change (adjusts dimension scores, thresholds, or caps)
- [ ] Tooling / CI / docs only (no runtime behavior change)

## Verification

<!-- How did you test this change? Include commands run and the
     repos/fixtures used. Reviewers should be able to reproduce. -->

- [ ] `npm run build` passes
- [ ] `npm run test:run` passes (note final tests count)
- [ ] `npm run lint` passes
- [ ] `bash scripts/check-architecture.sh` passes
- [ ] Manually verified on a real repo (if applicable)

## Architectural rules checklist

If your change touches any of the following areas, confirm you read
the relevant section of `CLAUDE.md`:

- [ ] Tool invocation goes through `tool-registry.ts` (Rule 1)
- [ ] No duplicate tool invocation logic (Rule 2)
- [ ] Language facts come from `detect.ts` / per-pack files (Rule 3, 6)
- [ ] Exclusions come from `exclusions.ts` (Rule 4)
- [ ] Established tools preferred over custom parsers (Rule 5)
- [ ] Dimension scoring lives in `src/scoring/dimensions/<id>.ts` (Rule 7)
- [ ] Per-stack shape lives in `LanguageSupport.architecturalShape` (Rule 8)
- [ ] N/A — this PR does not touch any of the above

## Screenshots / sample output

<!-- Optional. Paste before/after CLI output, screenshots of
     dashboards, or fixture diffs that show the change in action. -->

## Breaking changes

<!-- If this is a breaking change, describe the user-visible impact
     and the migration path. -->

## Notes for reviewers

<!-- Anything reviewers should pay extra attention to, or
     deliberate trade-offs you made. -->
