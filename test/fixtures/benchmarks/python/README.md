# Python benchmark fixture — `requests==2.20.0`

Pinned vulnerable dep used by `test/integration/cross-ecosystem.test.ts`
to validate the Python pack's pip-audit invocation, severity enrichment,
and Tier-2 `upgradePlan` population (Phase 10h.6.2).

## Expected pip-audit output

`pip-audit -r requirements.txt --format json` should report
`requests` advisories including **CVE-2018-18074** with a non-empty
`fix_versions[]`. The Python pack consumes the first fix version as
`DepVulnFinding.upgradePlan.parentVersion` (parent == package, since
Python's dep graph is flat — see `src/languages/python.ts:310`).

## Regenerating

The only artifact here is `requirements.txt` itself. No lockfile to
regenerate. To re-record expected output, run pip-audit against this
file and update the integration-test snapshot.
