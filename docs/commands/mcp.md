# vyuh-dxkit mcp

Serve dxkit's read-only repo tools over the [Model Context Protocol](https://modelcontextprotocol.io), so any MCP-capable coding agent (Claude Code, Cursor, VS Code) can call them natively while working in your repo.

```bash
vyuh-dxkit mcp [path] [--no-names]
```

This is not a command you run by hand. You register it once with your agent, and the agent launches it on demand:

```bash
# Claude Code
claude mcp add dxkit -- npx vyuh-dxkit mcp
```

For other agents, add an entry to their MCP configuration with command `npx` and arguments `vyuh-dxkit mcp` (the repo the agent works in must have dxkit installed as a devDependency, or dxkit installed globally).

## What the agent gets

The same read-only point-query tools the `learn --serve` assistant uses, from the same registry:

| Tool                | Answers                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `function_callers`  | Who calls this function/method (from the committed code graph)              |
| `function_callees`  | What this function/method calls                                             |
| `file_blast_radius` | Symbols in a file + the test files that transitively exercise it            |
| `file_history`      | Recent commits touching a file or line range                                |
| `file_owners`       | Active recency-weighted ownership + bus factor                              |
| `debt_findings`     | Grandfathered findings from the committed baseline, filtered by kind / file |

An agent that asks "why is this safe to change?" gets dxkit's canonical computed answers instead of re-deriving them from file greps. When the code graph is absent, the tools answer with the exact enable command (`vyuh-dxkit describe`) rather than an error.

## Scope and safety

- **Read-only, structurally.** No write path exists on this surface: no tool mutates anything, executes a policy command, or touches configuration. The guardrail's verdicts never consume anything returned here.
- **stdio only.** Newline-delimited JSON-RPC over stdin/stdout — no port, no network listener, nothing reachable from outside the process the agent spawned.
- **Path arguments are guarded** against traversal, absolute paths, and option injection.
- **Contributor names**: the consuming agent already has full git access in your repo, so `file_history` / `file_owners` include author names by default. Pass `--no-names` at registration time to suppress them (counts and dates only).

## v1 boundaries

stdio transport and the tools capability only — no resources, no prompts, no HTTP transport. The tool set grows with the shared registry; `tools/list` always reflects what this dxkit version ships.
