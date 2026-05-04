# Ruby — raw tool-output fixture harvest

Real Ruby tool output captured here. Unit tests in
`test/languages-ruby.test.ts` parse these fixtures, NOT hand-crafted
strings. The C# defect lesson (Phase 10h.6.8 — parser passed
synthetic-JSON unit tests for 5 months while returning 0 findings on
real `dotnet list package --vulnerable` output) is the cautionary
tale that justifies this discipline.

## Standard fixtures

| File                   | Producer                          | Capability         | What it validates                   |
| ---------------------- | --------------------------------- | ------------------ | ----------------------------------- |
| `coverage-output.json` | SimpleCov v0.22.0                 | coverage (10k.2.4) | parseSimpleCovResultset correctness |
| `lint-output.json`     | rubocop (planned 10k.2.5)         | lint               | parseRubocopOutput correctness      |
| `depvulns-output.txt`  | bundler-audit (planned 10k.2.6)   | depVulns           | parseBundlerAuditOutput correctness |

## Capture commands

### `coverage-output.json` (SimpleCov, captured 2026-05-04 for Phase 10k.2.4)

A tiny RSpec project at `tmp/ruby-fixture-harvest/` (gitignored) was
built specifically for harvest:

```
tmp/ruby-fixture-harvest/
  Gemfile                   # gem 'rspec' + gem 'simplecov'
  .rspec                    # --require spec_helper
  lib/calculator.rb         # 4 methods: add, subtract, multiply, divide
  spec/spec_helper.rb       # require 'simplecov'; SimpleCov.start
  spec/calculator_spec.rb   # tests add + subtract; multiply + divide deliberately untested
```

The deliberately-uncovered `multiply` and `divide` methods produce
mixed `[int, 0, null, ...]` line arrays — exercising the parser's
ability to distinguish covered (positive int), uncovered (0), and
non-executable (null) lines.

Capture:

```bash
# Toolchain (one-time, OS-level):
sudo apt-get install -y ruby-full

# Gems (via dxkit's tools install — exercises TOOL_DEFS install path):
node dist/index.js tools install simplecov tmp/ruby-fixture-harvest --yes
gem install --user-install rspec   # rspec not yet in TOOL_DEFS

# Run rspec from inside the harvest project (SimpleCov writes coverage/
# relative to the project being measured):
cd tmp/ruby-fixture-harvest
PATH="$HOME/.local/share/gem/ruby/3.2.0/bin:$PATH" rspec

# Captured artifact + path sanitization (see below):
sed 's|/home/[^/]*/projects/dxkit/tmp/ruby-fixture-harvest/|<HARVEST_ROOT>/|g' \
  coverage/.resultset.json \
  > ../../test/fixtures/raw/ruby/coverage-output.json
```

**Path sanitization**: SimpleCov records absolute paths in the
`coverage` map keys. The committed fixture substitutes the
host-specific absolute prefix (`/home/<user>/projects/dxkit/tmp/ruby-fixture-harvest/`)
with the placeholder `<HARVEST_ROOT>/` so the fixture is portable
across contributors. The line-array shape (which IS the schema we
care about) survives byte-identical. Tests pass `cwd = '<HARVEST_ROOT>'`
to the parser so relativization produces stable per-file keys
(`lib/calculator.rb`).

## Why committed

Real-output fixtures stay byte-identical to what the upstream tool
emits. `.prettierignore` excludes `test/fixtures/raw/` so reformatting
doesn't drift the bytes. Re-harvest only when:

- The upstream tool ships a JSON/XML schema change
- The fixture's project was edited (different finding set)
