# Deny Rule Recommendations

<!--
  This file tracks commands/actions that SHOULD be added to .claude/settings.json deny list.
  Claude cannot modify settings.json directly (security boundary).
  A developer should periodically review this file and promote entries to settings.json.

  Format:
  ## YYYY-MM-DD - Rule
  `DenyPattern` — reason this should be blocked
  **Context:** what happened that surfaced this need
-->

<!-- Example:
## 2025-12-15 - Block database drop
`Bash(dropdb:*)` — accidentally dropped staging database during cleanup
**Context:** Claude ran dropdb instead of truncating tables during test cleanup
-->
