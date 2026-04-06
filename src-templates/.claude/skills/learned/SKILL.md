---
name: learned
description: Project-specific learnings, gotchas, and conventions discovered during development. Check this before starting any task for accumulated team knowledge.
---

# Learned Patterns & Gotchas

This skill accumulates project-specific knowledge over time.
It is updated during session-end checkpoints.

## How This Works

1. During `make session-end`, the checkpoint process reviews the session
2. Any new gotchas, patterns, or conventions are appended to the reference files
3. Over time, this becomes the most valuable skill — real failure points and patterns

## Files

- [references/gotchas.md](references/gotchas.md) - Accumulated gotchas and edge cases (append-only)
- [references/conventions.md](references/conventions.md) - Team conventions discovered during development
- [references/deny-recommendations.md](references/deny-recommendations.md) - Commands that should be added to `.claude/settings.json` deny list (requires human review)

## When to Update

Update these files when you encounter:
- Unexpected behaviors or edge cases
- Workarounds for tool/framework bugs
- Team conventions or patterns that aren't obvious from the code
- Configuration pitfalls
- Deployment or environment-specific issues

## When to Create a New Skill

If a learning is significant enough to warrant its own skill (e.g., a specific API integration, a migration workflow, a caching pattern), create a new directory under `.claude/skills/<name>/` with a `SKILL.md` instead of appending here. This skill (`learned`) is for general cross-cutting knowledge; domain-specific knowledge deserves its own skill.

## Format

### Gotchas
```markdown
## YYYY-MM-DD - Category / Short Title
Description of the issue.
**Resolution:** How it was resolved.
```

### Conventions
```markdown
## Category - Convention Name
Description of the convention.
**Rationale:** Why this convention was adopted.
```

## Security

**NEVER include secret values, tokens, passwords, or API keys in any file under this skill.**
If a gotcha involves credentials, describe the issue generically without exposing actual values.
