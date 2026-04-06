---
description: Configure DXKit as local-only (gitignore all generated files) + install git hooks
---

Delegate to the **hooks-configurator** agent with stealth mode enabled.

This will:
1. Add all DXKit files to `.gitignore` (`.claude/`, `.ai/`, `CLAUDE.md`, `.vyuh-dxkit.json`)
2. Ask which hooks to enable (quality, test, vulnerability)
3. Generate `.githooks/` directory (committed — all devs get the hooks)
4. Install hooks with `git config core.hooksPath .githooks`

Result: DXKit AI features are local-only, but quality/test/security hooks run for everyone.

**Enable stealth mode: yes**

$ARGUMENTS
