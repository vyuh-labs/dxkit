---
description: List all available project commands and agents
---

List all available commands and agents for this project.

## Available Commands

!`ls .claude/commands/`

## Active Agents

!`ls .claude/agents/ 2>/dev/null`

## Dormant Agents

!`ls .claude/agents-available/ 2>/dev/null`

## How Agents Work

- **Active agents** (`.claude/agents/`) — Claude automatically delegates matching questions to them. No action needed.
- **Dormant agents** (`.claude/agents-available/`) — Must be activated first: `/enable-agent <name>`
- Agents run in an **isolated context** with restricted tools (typically read-only).
- Deactivate an agent by removing it from `.claude/agents/`.

## Quick Start

- **Start a session**: `/session-start`
- **Ask about the codebase**: `/ask How does X work?` (or just ask naturally — knowledge-bot auto-triggers)
- **Run quality checks**: `/quality`
- **Explore architecture**: `/explore-codebase`
- **Generate onboarding guide**: `/onboarding`
- **Enable an agent**: `/enable-agent <name>`
- **End session**: `/session-end`

For each command and agent file listed above, read its `.md` file to get the description from frontmatter, then present everything in a clean, readable format. Strip the `.md` extension when displaying command names.
