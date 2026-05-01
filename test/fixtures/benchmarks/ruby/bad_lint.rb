# Per-language badLint fixture, Ruby row.
# Recipe v3 (G4) scaffolded — adjust syntax / linter rules as needed.
# Deliberate RuboCop violations on default config:
#   - Lint/UselessAssignment (unused_var)
#   - Style/RedundantReturn (return at end of method)
def bad_lint
  unused_var = 42
  return 0
end
