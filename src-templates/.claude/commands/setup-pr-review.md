---
description: Set up automated PR review with Claude Code
---

Set up a GitHub Action that automatically reviews pull requests using Claude Code.

## What to Create

Create `.github/workflows/pr-review.yml` with this content:

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Review PR
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # Get the diff
          git diff origin/${{ github.base_ref }}...HEAD > /tmp/pr-diff.txt

          # Run Claude Code in non-interactive mode
          claude -p "Review this pull request diff for bugs, security issues, and code quality problems. Focus on:
          1. Logic errors and edge cases
          2. Security vulnerabilities (hardcoded secrets, injection, auth gaps)
          3. Error handling gaps
          4. Breaking changes

          Be specific: reference file:line numbers. Rate each issue as critical/warning/suggestion.
          Only flag real issues — not style (linters handle that).

          The diff:
          $(cat /tmp/pr-diff.txt)" > /tmp/review.md

      - name: Post Review Comment
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const review = fs.readFileSync('/tmp/review.md', 'utf8');
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `## 🤖 Claude Code Review\n\n${review}\n\n---\n*Automated review by Claude Code*`
            });
```

## After Creating

Tell the user:
1. Add `ANTHROPIC_API_KEY` to the repo's GitHub Secrets (Settings → Secrets → Actions)
2. The workflow will run automatically on every PR
3. Reviews appear as PR comments
