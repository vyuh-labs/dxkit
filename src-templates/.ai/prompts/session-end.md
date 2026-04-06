# Session End Prompt Template

Use this prompt to wrap up an AI-assisted development session and create a checkpoint.

## Prompt Template

```
We're wrapping up this session. Please create a session checkpoint document:

1. Determine the developer name from git config (git config user.name)
2. Convert to lowercase with hyphens (e.g., "John Doe" → "john-doe")
3. Get today's date in YYYY-MM-DD format
4. Check for existing session files in .ai/sessions/{developer-name}/{YYYY-MM-DD}/
5. Create checkpoint file: .ai/sessions/{developer-name}/{YYYY-MM-DD}/session-{N}.md
   - Create the date folder if it doesn't exist
   - {N} is the session number for today (increment if multiple sessions today)

6. Use the template from .ai/templates/session-checkpoint-template.md

6. Fill in the template with:
   - Session goal (what we set out to do)
   - What we accomplished (specific, measurable)
   - All files created/modified (with brief description of changes)
   - Key decisions made (with reasoning)
   - Implementation details (how things work)
   - Testing status (what's tested, what's passing)
   - Next steps (clear, actionable items for next session)
   - Context for AI (detailed context for next session's agent)
   - Any blockers or considerations

Make the checkpoint detailed enough that someone else (or a fresh AI agent) can understand what was done and continue the work.
```

## What Makes a Good Checkpoint?

### Essential Elements

✅ **Clear Goal**
- What we wanted to accomplish
- Why this work matters

✅ **Specific Accomplishments**
- Not "worked on client" but "implemented PolygonClient with quote/bars endpoints, added Pydantic models, wrote 15 unit tests"

✅ **File Changes**
- Every file created or modified
- What changed in each file

✅ **Decision Rationale**
- Why we chose approach A over B
- Trade-offs we accepted

✅ **Technical Details**
- How the implementation works
- Important patterns or techniques used
- Where to find key logic

✅ **Actionable Next Steps**
- Specific, not vague
- Ordered by priority
- With enough context to start

✅ **AI Context Block**
- Detailed prompt for next session's agent
- Key facts to remember
- How to continue

## Example Good vs Bad Checkpoints

### ❌ Bad Checkpoint

```markdown
## Accomplished
- Worked on the client
- Made progress on tools
- Fixed some bugs

## Next Steps
- Continue implementation
- Add more tests
```

**Why bad:** Vague, no specifics, can't continue from this

### ✅ Good Checkpoint

```markdown
## Accomplished
- Implemented PolygonClient class in services/langgraph-service/src/clients/polygon/client.py
  - Added async methods: get_quote(), get_bars(), get_options_chain()
  - Implemented retry logic for rate limits (429 errors)
  - Added authentication via Bearer token
- Created Pydantic models in clients/polygon/models.py (Quote, Bar, OptionContract)
- Added 15 unit tests in tests/clients/test_polygon.py (100% coverage)
- All tests passing (make test)

## Next Steps
1. Integrate PolygonClient into market_data tool
2. Update tool to use client's get_quote() method instead of mock data
3. Add integration test with mocked PolygonClient
4. Update tool registry to include new market data capabilities

## Context for AI
We've implemented the Polygon client infrastructure layer. The client handles all HTTP communication, auth, and retries.

Next, we need to integrate it into the tool layer. The market_data.py tool currently returns mock data - replace the get_stock_quote() function to use polygon_client.get_quote().

Remember to inject PolygonClient as a dependency (don't import directly) to keep tests mockable.
```

**Why good:** Specific files, concrete accomplishments, clear next steps, AI can continue easily

---

## Skill Evolution

After creating the checkpoint, review the session for learnings:

✅ **Gotchas** — Unexpected behaviors, edge cases, or failure modes
→ Append to `.claude/skills/learned/references/gotchas.md` or `.claude/skills/<area>/references/gotchas.md`

✅ **Conventions** — New patterns or team agreements established
→ Append to `.claude/skills/learned/references/conventions.md`

✅ **New Skills** — If a new domain/workflow emerged that deserves its own skill
→ Create `.claude/skills/<name>/SKILL.md` with frontmatter (`name`, `description`)

⚠️ **NEVER include secret values, tokens, or credentials in skill files**

---

**Remember:** A good checkpoint enables seamless continuation. Treat it like documentation for your future self (or the next AI agent).
