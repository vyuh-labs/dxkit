---
description: End session and create checkpoint with skill evolution
---

Ending the current development session.

## Session Info

Determine the developer name from `git config user.name` and today's date. Create the session directory at `.ai/sessions/<developer>/<date>/` if it doesn't exist. Find the next session number by checking existing `session-*.md` files. Also check recent git commits and uncommitted changes.

## Create Checkpoint

Create a comprehensive checkpoint at `.ai/sessions/<developer>/<date>/session-<N>.md`. Include:

### Required Sections
- **Session Goal** — What we set out to do
- **Accomplished** — Specific items completed (not vague — include file paths, counts)
- **Files Created/Modified** — Every file with description
- **Key Decisions** — What we decided, why, alternatives considered
- **Implementation Details** — How things work, patterns used
- **Testing Status** — Tests added, coverage, passing status
- **Next Session** — Clear, actionable steps for next session
- **Context for AI** — Detailed context for the next session's agent
- **Blockers / Considerations** — Issues, tech debt, dependencies

## Skill Evolution

After creating the checkpoint, review this session for learnings:

1. **Gotchas** — Append to `.claude/skills/learned/references/gotchas.md`
   Format: `## YYYY-MM-DD - Category / Title` + description + resolution

2. **Conventions** — Append to `.claude/skills/learned/references/conventions.md`
   Format: `## Category - Convention Name` + description + rationale

3. **Deny recommendations** — If a dangerous command was nearly executed, append to `.claude/skills/learned/references/deny-recommendations.md`

4. **New skills** — If a distinct new domain emerged, create `.claude/skills/<name>/SKILL.md`

**NEVER include secret values, tokens, or credentials in checkpoints or skill files.**
