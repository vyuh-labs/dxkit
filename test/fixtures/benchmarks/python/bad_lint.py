# Deliberate ruff F401 violation (unused-import). Phase 10i.0.2:
# per-language lint fixture pre-staging the cross-ecosystem assertion
# surface for 10i.2 (LintFinding fingerprints) + the 10i.0.5 parity
# gate. Ruff catches this with default config — no rule-set tweaks
# needed in the fixture.
import os  # noqa: I100  (we WANT ruff to flag F401 here; the noqa is for I100)
