---
description: Start an AI-assisted development session
---

Starting a new development session.

## Session Info

Determine the developer name from `git config user.name` and today's date. Check `.ai/sessions/` for previous checkpoints from this developer.

## Before Planning

Check Claude Code skills for relevant context:
- Read `.claude/skills/codebase/SKILL.md` if it exists (run `/explore-codebase` if missing)
- Read `.claude/skills/learned/references/gotchas.md` for known project gotchas
- Read `.claude/skills/learned/references/conventions.md` for team conventions

## Plan This Session

Before coding, let's plan:

1. What files will we need to create/modify?
2. What are the key components/functions?
3. What dependencies or external services do we need?
4. What tests should we write?
5. Can we complete this in one session?
6. Does this align with our architecture?
7. Are there relevant gotchas or conventions in `.claude/skills/` to be aware of?

Once we have a solid plan, I'll proceed step by step — explaining WHAT, WHY, and HOW before each change.
