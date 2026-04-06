# Step-by-Step Development Prompt

Use this prompt during development to ensure AI agent explains before implementing.

## Prompt Template

```
Great plan! Let's proceed step by step.

Before implementing each component:
1. Tell me what you're about to do
2. Explain WHY we're doing it this way (business reason, architectural fit)
3. Explain HOW it will work (technical approach)
4. Then implement it

Let's start with {FIRST_COMPONENT}.
```

## During Development - Validation Checkpoints

After each major component is implemented, validate:

```
Before we continue, let's verify this implementation:

1. Does it follow our architecture patterns?
2. Is error handling consistent with our standards?
3. Are we using dependency injection properly?
4. Is logging structured and informative?
5. Are type hints/types properly used?
6. Is it testable (dependencies can be mocked)?

If everything looks good, let's continue to {NEXT_COMPONENT}.
If not, let's refine before moving on.
```

## Course Correction

If something doesn't align with our patterns:

```
Wait, this doesn't follow our {PATTERN_NAME} pattern.

According to docs/{RELEVANT_DOC}, we should {CORRECT_APPROACH}.

Can you revise this to align with our standards?
```

## Example Flow

### Step 1: Client Implementation

```
Let's start with implementing the PolygonClient class.

Before coding:
1. What are you about to do?
2. Why this approach?
3. How will it work technically?
```

**Agent explains...**

```
That makes sense. Please proceed with the implementation.
```

### Step 2: Testing

```
Finally, let's add tests.

Before coding:
1. What test coverage do we need?
2. How will we mock the external API?
3. What edge cases should we test?
```

## What Good Explanations Look Like

### What to Do
"I'm implementing the PolygonClient class with async methods for fetching quotes and historical bars."

### Why This Way
"We use an async client because we'll make multiple concurrent API calls. This is separated from the tool layer to follow our clean architecture pattern."

### How It Works
"The client will use httpx.AsyncClient for HTTP requests, handle authentication via headers, implement retry logic for rate limits, and parse responses into Pydantic models for type safety."

## Red Flags - When to Stop

❌ "I'll implement the client" → No explanation given
❌ "This is the standard way" → Not specific to our architecture
❌ "Let me write the code" → Skipping the explanation step
❌ Hardcoded values → Should use config
❌ No error handling mentioned → Missing critical aspect
❌ No testability consideration → Will be hard to test

## Session Flow Summary

```
1. Plan session ✓
2. For each component:
   a. Agent explains what/why/how
   b. Developer validates explanation
   c. Agent implements
   d. Developer verifies implementation
3. Create checkpoint ✓
```

---

**Key Principle:** Understand before coding. If you don't understand the "what/why/how", the code won't align with architecture.
