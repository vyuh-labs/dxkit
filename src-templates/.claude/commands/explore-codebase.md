---
description: Deep-explore the codebase and generate architecture documentation
---

Delegate this to the **codebase-explorer** agent. It will deeply analyze the codebase and generate:

1. `.claude/skills/codebase/SKILL.md` — Concise architecture and navigation guide
2. `.claude/skills/codebase/references/architecture.md` — Detailed reference

Focus on non-obvious things — gotchas, conventions, and architectural decisions that aren't apparent from file names alone.

**NEVER include secret values, tokens, or credentials in the output.**
