---
description: Capture a learning from this conversation (gotcha, convention, or thing to avoid)
---

Review this conversation and capture any learnings. If the user provided specific input, use that:

$ARGUMENTS

## What to Capture

Look for:
1. **Gotchas** — something surprising, broke unexpectedly, or took time to debug
2. **Conventions** — a pattern or approach that worked well and should be repeated
3. **Deny recommendations** — a dangerous command that should be avoided

## Where to Write

First read the existing files to avoid duplicates. Then append (never overwrite) to the appropriate file:

- **Gotchas** → `.claude/skills/learned/references/gotchas.md`
  ```
  ## YYYY-MM-DD - Category / Title
  **Problem:** What went wrong
  **Resolution:** How it was fixed
  **Prevention:** How to avoid it next time
  ```

- **Conventions** → `.claude/skills/learned/references/conventions.md`
  ```
  ## Category - Convention Name
  **Pattern:** What to do
  **Rationale:** Why this works
  ```

- **Deny recommendations** → `.claude/skills/learned/references/deny-recommendations.md`
  ```
  ## Command / Pattern to Avoid
  **Risk:** What could go wrong
  **Alternative:** Safer approach
  ```

## Rules

- Only capture things that are **non-obvious** and useful for future sessions
- Don't repeat what's already in the files
- Be concise — future sessions will read these
- **NEVER include secrets, tokens, or credentials**
- Tell the user what you captured and where
