---
name: session
description: Manage AI development sessions — start, checkpoint, commit, push, create PRs. Use when asked about session workflow, checkpoints, or development workflow.
---

# Session Management

## Workflow
1. `make session-start` - Start session (finds last checkpoint, generates prompts)
2. Work on your task using step-by-step development
3. `make session-end` - Create checkpoint document
4. `make session-commit` - Commit with quality checks
5. `make session-push` - Push to remote
6. `make session-pr` - Create PR with auto-generated content

## Key Files
- `.ai/prompts/session-start.md` - Planning prompt template
- `.ai/prompts/session-end.md` - Checkpoint creation guide
- `.ai/prompts/step-by-step.md` - Step-by-step development guide
- `.ai/templates/session-checkpoint-template.md` - Checkpoint structure

## Checkpoints
- Stored in: `.ai/sessions/<developer>/<date>/session-<N>.md`
- Auto-numbered per day
- Include: accomplishments, files, decisions, next steps, AI context

## Checkpoint Quality
A good checkpoint is specific, not vague:
- **Bad:** "worked on the client"
- **Good:** "Implemented PolygonClient with 3 endpoints, added 15 unit tests, all passing"

## Skill Evolution (during session-end)
After creating the checkpoint, review the session for learnings:
- Append gotchas to `.claude/skills/learned/references/gotchas.md`
- Append conventions to `.claude/skills/learned/references/conventions.md`
- Update area-specific gotchas in `.claude/skills/<area>/references/gotchas.md`
- **Create new skills** if a distinct domain/workflow emerged (new `.claude/skills/<name>/SKILL.md`)

**NEVER include secret values in checkpoints or skill files.**

## Tips
- `SKIP_VERIFY=1` on session-commit/push to bypass quality checks for WIP
- `BASE=main` on session-pr to override base branch
