---
name: secrets
description: Manage secrets via Infisical. Use when asked about secrets, environment variables, API keys, .env configuration, or credential management.
paths:
  - '.env'
  - '.env.*'
  - '**/.env'
  - '**/.env.*'
  - '.infisical.json'
  - '**/.infisical.json'
---

# Secrets Management (Infisical)

## How it works

1. Infisical stores secrets centrally (encrypted, access-controlled)
2. `infisical run -- <command>` or `infisical export --format=dotenv > .env` pulls them into the local environment
3. `.env` is gitignored — **never commit secrets**

## Configuration

Authenticate via `infisical login`. Per-project config typically lives in `.infisical.json` (project ID + environment).

Required environment variables (set during initial project bootstrap):
- `INFISICAL_TOKEN` — auth token (for headless/CI usage)
- `INFISICAL_PROJECT_ID` — project identifier
- `INFISICAL_ENV` — environment (default: `dev`)

## Checking configuration

Look at the variable names without their values:

```bash
infisical secrets --plain | cut -d= -f1
```

## Security — CRITICAL

1. **NEVER read `.env` directly** — it contains plain-text secrets
2. **NEVER output secret values** in responses, logs, or commit messages
3. **NEVER include secrets** in session checkpoints or skill files
4. **NEVER pass secrets as CLI arguments** — they appear in process lists
5. **NEVER commit** `.env`, `.env.*`, or `.env.secrets`
6. If a secret is accidentally exposed, rotate it immediately

## Troubleshooting

- Token expired → re-run `infisical login`
- Pull fails → check the project ID and environment, verify token permissions
- Missing variable → confirm it exists in the right Infisical environment
