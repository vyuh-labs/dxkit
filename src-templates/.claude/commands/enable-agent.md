---
description: Activate an available agent (or list all available agents)
argument-hint: "[agent-name or 'list']"
---

List the contents of `.claude/agents-available/` to show available agents and `.claude/agents/` to show active agents.

If the user provided an agent name, copy it from `agents-available/` to `agents/` to activate it:
- Argument: `$ARGUMENTS`
- If "list" or empty, just list both directories.
- If a valid agent name, run: `cp .claude/agents-available/$ARGUMENTS.md .claude/agents/$ARGUMENTS.md`
- Then confirm activation and briefly describe what the agent does (read the agent file for its description).
