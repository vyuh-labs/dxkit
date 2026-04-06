# AI-Assisted Development Sessions

This directory contains session checkpoints, templates, and prompts for AI-assisted development.

## Directory Structure

```
.ai/
├── README.md                          # This file
├── sessions/                          # Session checkpoints by developer
│   ├── john-doe/
│   │   ├── 2025-10-05/
│   │   │   ├── session-1.md
│   │   │   └── session-2.md
│   │   └── 2025-10-06/
│   │       └── session-1.md
│   └── jane-smith/
│       └── 2025-10-05/
│           └── session-1.md
├── templates/
│   └── session-checkpoint-template.md # Checkpoint template
└── prompts/
    ├── session-start.md               # Starting session prompt
    ├── step-by-step.md                # Development flow prompt
    └── session-end.md                 # Ending session prompt
```

## Quick Start

### Starting a New Session

```bash
make ai-start
```

This will:
- Show your last checkpoint (if exists)
- Display the session start prompt
- Help you plan the session with AI

### During Development

```bash
make ai-step
```

Shows the step-by-step development guide for AI-assisted coding.

### Ending a Session

```bash
make ai-checkpoint
```

This will:
- Show the session end prompt
- Tell AI where to create the checkpoint file
- Provide the template location

### View Session History

```bash
make ai-history
```

Shows recent sessions for you and other developers.

## Session Workflow

1. **Start:** `make ai-start` → Plan with AI
2. **Develop:** Code step-by-step, use `make ai-step` as reference
3. **End:** `make ai-checkpoint` → AI creates checkpoint
4. **Commit:** Include checkpoint in commit message

## Session Naming Convention

```
.ai/sessions/{developer-name}/{YYYY-MM-DD}/session-{N}.md
```

- `developer-name`: From `git config user.name` (lowercase, hyphens)
- `YYYY-MM-DD`: Dated folder for that day's sessions
- `N`: Session number for that day

## What Goes in a Checkpoint?

A good checkpoint includes:

- **Session goal** - What we set out to accomplish
- **Accomplishments** - Specific items completed
- **Files changed** - All created/modified files
- **Key decisions** - Why we chose this approach
- **Implementation details** - How it works
- **Testing status** - What's tested and passing
- **Next steps** - Clear actions for next session
- **AI context** - Detailed context for continuing

See [session-checkpoint-template.md](templates/session-checkpoint-template.md) for full structure.

## Best Practices

✅ **Do:**
- Create checkpoints at end of every session
- Be specific and detailed
- Document key decisions and reasoning
- Provide clear next steps
- Include enough context for AI to continue

❌ **Don't:**
- Skip checkpoint creation
- Be vague ("worked on stuff")
- Forget to list all file changes
- Leave out decision rationale

---

**Remember:** Good checkpoints enable seamless collaboration between developers and AI agents.
