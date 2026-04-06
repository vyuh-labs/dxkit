# Session Start Prompt Template

Use this prompt to start a new AI-assisted development session.

## Prompt Template

```
I want to {SESSION_GOAL}.

{IF CONTINUING FROM PREVIOUS SESSION:}
I'm continuing from a previous session. Please read the checkpoint:
.ai/sessions/{DEVELOPER_NAME}/{LAST_CHECKPOINT_FILE}

Summarize what was accomplished and what's left to do.
{END IF}

Before we start coding, let's plan this session:

1. What files will we need to create/modify?
2. What are the key components/functions?
3. What dependencies or external services do we need?
4. What tests should we write?
5. Can we complete this in one session (within context window)?
6. Does this align with our architecture? (Check docs/architecture/system-overview.md and docs/developer-guide/key-principles.md)

Once we have a solid plan that fits in one session, I'll ask you to proceed step by step.
```

## Example Usage

### New Feature (No Previous Session)

```
I want to implement the Polygon client for fetching stock quotes and historical bars.

Before we start coding, let's plan this session:

1. What files will we need to create/modify?
2. What are the key components/functions?
3. What dependencies or external services do we need?
4. What tests should we write?
5. Can we complete this in one session (within context window)?
6. Does this align with our architecture?

Once we have a solid plan that fits in one session, I'll ask you to proceed step by step.
```

### Continuing from Previous Session

```
I want to continue implementing the market data integration.

I'm continuing from a previous session. Please read the checkpoint:
.ai/sessions/john-doe/2025-10-05-session-1.md

Summarize what was accomplished and what's left to do.

Before we start coding, let's plan this session...
```

## Before Planning

Check Claude Code skills for relevant context before starting work:
- `.claude/skills/codebase/SKILL.md` — Architecture overview (run `/project:explore-codebase` if missing)
- `.claude/skills/learned/references/gotchas.md` — Known project gotchas (avoid repeating past mistakes)
- `.claude/skills/learned/references/conventions.md` — Team conventions (follow established patterns)
- `.claude/skills/<area>/references/gotchas.md` — Area-specific gotchas (quality, test, deploy, etc.)

## What Good Planning Looks Like

The AI agent should respond with:

### File Plan
- Clear list of files to create/modify
- Rationale for each file
- Estimated size/complexity

### Component Breakdown
- Main classes/functions to implement
- How they fit together
- Dependencies between components

### Testing Plan
- What needs unit tests
- What needs integration tests
- Test coverage strategy

### Feasibility Check
- Honest assessment of scope
- Recommendation to split if too large
- Estimated complexity

## If the Plan Looks Good

```
Great plan! This looks achievable in one session and aligns with our architecture.

Let's proceed step by step. Before implementing each component:
1. Tell me what you're about to do
2. Explain WHY we're doing it this way
3. Explain HOW it fits into the architecture
4. Then implement it

Let's start with {FIRST_COMPONENT}.
```

---

**Remember:** Good planning saves time. Spend 5-10 minutes planning to save hours of refactoring.
