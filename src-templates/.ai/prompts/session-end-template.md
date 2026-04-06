# Session End - Create Checkpoint

Please create a comprehensive session checkpoint using your full conversation context.

## Session Information
- **Developer**: {DEVELOPER}
- **Date**: {DATE}
- **Session Number**: {SESSION_NUM}
- **Checkpoint File**: `{CHECKPOINT_FILE}`

## Your Task

You have the complete context of this development session. Create a comprehensive checkpoint.

### Step 1: Gather Information from User

Ask me for any details you need to complete the checkpoint:
- **Session duration**: Estimate from our conversation length, or ask me
- **Blockers**: Any issues or concerns for next session?
- **Completeness**: Did we finish what we planned, or is work in progress?
- **Anything unclear**: Any decisions or context you're unsure about?

### Step 2: Create Checkpoint File

Create the checkpoint at: `{CHECKPOINT_FILE}`

Use the template structure from: `.ai/templates/session-checkpoint-template.md`

Fill out **all sections thoroughly** using:
- ✅ **Our conversation history** - You know everything we discussed and built
- ✅ **Files you touched** - You know every file created/modified
- ✅ **Decisions we made** - You remember the reasoning and trade-offs
- ✅ **Plans we made** - You know what's next

## What to Document

### Accomplished ✅
List **specific** accomplishments (not vague):
- ❌ Bad: "Worked on the client"
- ✅ Good: "Implemented PolygonClient with 3 endpoints (get_quote, get_bars, get_options), added 15 unit tests, all passing"

### Files Created/Modified
Every file with description:
- Created files with purpose
- Modified files with what changed

### Key Decisions
Major decisions with reasoning:
- What we decided
- Why we chose this approach
- Alternatives we considered
- Trade-offs we accepted

### Implementation Details
How things work:
- Architecture/patterns used
- Key technical details
- Where to find important logic

### Testing Status
- Tests added/updated
- Coverage
- Passing status
- Manual testing done

### Next Session
**Clear, actionable steps** for next session:
- Specific enough to start immediately
- Ordered by priority
- With enough context

### Context for AI
Detailed context for next session's AI agent:
- What we just completed
- Current state of the codebase
- What to do next and why
- Key facts to remember

### Blockers / Considerations
- Any blockers needing resolution
- Technical debt taken
- Things to watch
- Dependencies

## Recent Git Activity

{GIT_COMMITS}

{GIT_CHANGES}

---

## Guidelines

- **Be specific**: Include file paths, line counts, exact accomplishments
- **Explain decisions**: Don't just say what, say why
- **Actionable next steps**: Clear enough that anyone can continue
- **Rich context**: Next AI agent should seamlessly pick up where we left off

---

## Skill Evolution

After creating the checkpoint, review this session for learnings worth capturing:

### Gotchas
If you encountered unexpected behaviors, edge cases, or failures:
- Append to `.claude/skills/learned/references/gotchas.md` (general)
- Or to `.claude/skills/<area>/references/gotchas.md` (area-specific: quality, test, deploy, gcloud, etc.)

Format:
```
## {DATE} - {Category} / {Short Title}
{Description of the issue}
**Resolution:** {How it was resolved}
```

### Conventions
If new team conventions or patterns were established:
- Append to `.claude/skills/learned/references/conventions.md`

Format:
```
## {Category} - {Convention Name}
{Description}
**Rationale:** {Why this convention was adopted}
```

### New Skills
If this session introduced a significant new domain, workflow, or integration that doesn't fit any existing skill, create a new skill:

1. Create directory: `.claude/skills/<skill-name>/`
2. Create `SKILL.md` with proper frontmatter:
```
---
name: <skill-name>
description: <what it does and when to use it — max 1024 chars>
---

# <Skill Title>

<Instructions, commands, patterns, gotchas>
```
3. Optionally add `references/gotchas.md` for area-specific gotchas

**When to create a new skill vs. updating an existing one:**
- New skill: the topic is distinct enough that it would clutter an existing skill (e.g., a specific API client, a migration workflow, a caching layer)
- Update existing: the learning fits naturally into an existing skill's domain (e.g., a new Python lint gotcha → quality skill)

**Naming rules** (per Agent Skills spec):
- Lowercase letters, numbers, and hyphens only
- No consecutive hyphens, don't start/end with hyphen
- Directory name must match the `name` field in frontmatter

### Deny Rule Recommendations
If you encountered or nearly executed a dangerous command that should be permanently blocked:
- Append to `.claude/skills/learned/references/deny-recommendations.md`

Format:
```
## {DATE} - Rule
`DenyPattern` — reason this should be blocked
**Context:** what happened that surfaced this need
```

A developer should periodically review this file and promote entries to `.claude/settings.json` deny list. Claude cannot modify settings.json directly (security boundary).

### Guidelines for Skill Evolution
- Only add genuinely useful learnings (not obvious things)
- Be specific: include file paths, error messages, exact symptoms
- Focus on things that would save time if known in advance
- Append-only for gotchas/conventions — never remove or edit existing entries
- **NEVER include secret values, tokens, passwords, or API keys in any skill file**

---

**Action**: Ask me any clarifying questions you need, then create the checkpoint file and update skills.

Make it thorough enough that:
1. Another developer can understand what was built
2. Next session's AI agent can seamlessly continue
3. We can remember context weeks/months from now
