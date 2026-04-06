---
description: Investigate and fix a GitHub issue
argument-hint: "[issue-number]"
---

Investigate and fix GitHub issue #$ARGUMENTS.

1. Fetch the issue: run `gh issue view $ARGUMENTS` (if `gh` is not installed, ask the user to describe it)
2. Delegate root cause analysis to the **debugger** agent
3. Fix the issue — make the minimal change needed
4. Write tests for the fix
5. Run `/quality` and `/test` before considering it done
