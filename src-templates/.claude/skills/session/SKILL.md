---
name: session
description: Manage AI development sessions — start, checkpoint, commit, push, create PRs. Use when asked about session workflow, checkpoints, or development workflow.
---

# Session Management

## Workflow

1. `/session-start` — review prior checkpoints + plan the session
2. Work on the task
3. `/session-end` — capture a checkpoint
4. Commit + push via git directly

## Checkpoints

- Stored in `.ai/sessions/<developer>/<date>/session-<N>.md` (auto-numbered per day)
- Include: accomplishments (specific, not vague), files changed, decisions, next steps, AI context

A good checkpoint is specific:
- **Bad**: "worked on the client"
- **Good**: "Implemented PolygonClient with 3 endpoints, added 15 unit tests, all passing"

## Skill evolution (during `/session-end`)

Review the session for learnings and append to:
- `.claude/skills/learned/references/gotchas.md` — surprising behaviors, edge cases
- `.claude/skills/learned/references/conventions.md` — patterns the team converged on

Create new skills (`.claude/skills/<name>/SKILL.md`) when a distinct domain/workflow emerges.

**NEVER include secret values in checkpoints or skill files.**
