# PHP — raw tool-output fixture harvest

Capture real PHP tool output and commit the bytes here. Unit tests in
`test/languages-php.test.ts` parse these fixtures, NOT hand-crafted
strings. The C# defect (Phase 10h.6.8 — parser passed synthetic-JSON unit
tests for 5 months while returning 0 findings on real `dotnet list package
--vulnerable` output) is the cautionary tale that justifies this discipline.

## Standard fixtures

| File                   | Producer                              | What it validates                           |
| ---------------------- | ------------------------------------- | ------------------------------------------- |
| `lint-output.json`     | PHP_CodeSniffer 4.0.1 `--report=json` | `parsePhpcsJson` correctness                |
| `depvulns-output.json` | osv-scanner 2.4.0 (Packagist)         | shared osv parse with ecosystem `Packagist` |
| `coverage-output.xml`  | PHPUnit `--coverage-clover`           | `parsePhpCloverXml` — **NOT YET HARVESTED** |

## Capture commands

```bash
# lint-output.json — phpcs JSON over a tiny project with deliberate PSR-12
# violations. Run from a NEUTRAL directory (the absolute path keys it emits
# are committed bytes):
mkdir -p /tmp/dxkit-harvest/php-repo/src && cd /tmp/dxkit-harvest/php-repo
#   ...add src/bad_lint.php (brace-on-same-line + uppercase TRUE) and a clean file...
phpcs -q --report=json --extensions=php --standard=PSR12 . \
  > test/fixtures/raw/php/lint-output.json

# depvulns-output.json — osv-scanner >= 2.4.0 over the benchmark fixture's
# known-vulnerable composer.lock (guzzle 7.4.0 → 7 GHSAs, live-verified).
cd test/fixtures/benchmarks/php
osv-scanner scan source --lockfile composer.lock --format json \
  > ../../raw/php/depvulns-output.json

# coverage-output.xml — PENDING a real harvest: needs a PHP with a coverage
# DRIVER (pcov or xdebug; the static-php build used for pack verification
# ships neither). On a driver-equipped machine:
#   cd <a small composer project with phpunit + one test>
#   vendor/bin/phpunit --coverage-clover coverage-clover.xml
#   cp coverage-clover.xml test/fixtures/raw/php/coverage-output.xml
# Until then test/languages-php.test.ts covers the clover parser with a
# format-shape sample (labeled interim in the test).
```

## Why committed

Real-output fixtures stay byte-identical to what the upstream tool emits.
`.prettierignore` excludes `test/fixtures/raw/` so reformatting doesn't
drift the bytes. Re-harvest only when:

- The upstream tool ships a JSON/XML schema change
- The fixture's project was edited (different finding set)
