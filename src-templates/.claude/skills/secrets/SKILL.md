---
name: secrets
description: Manage secrets via Infisical. Use when asked about secrets, environment variables, API keys, .env configuration, or credential management.
---

# Secrets Management (Infisical)

## Commands
- `make secrets-pull` - Pull secrets from Infisical to `.env`
- `make secrets-show` - Show Infisical configuration (**no secrets displayed**)
- `make setup` - Configure Infisical during initial setup

## How It Works
1. Infisical stores secrets centrally (encrypted, access-controlled)
2. `make secrets-pull` fetches secrets and merges into `.env`
3. `.env` is gitignored — **never commit secrets**

## Configuration
Required in `.env` (set during `make setup`):
- `INFISICAL_TOKEN` - Authentication token
- `INFISICAL_PROJECT_ID` - Project identifier
- `INFISICAL_ENV` - Environment (default: `dev`)

## Checking Configuration
Always use `make secrets-show` — it displays config keys without values:
```
INFISICAL_PROJECT_ID=abc123
INFISICAL_ENV=dev
INFISICAL_TOKEN=***configured***
```

## Security — CRITICAL

1. **NEVER read `.env` directly** — it contains plain-text secrets
2. **NEVER output secret values** in responses, logs, or commit messages
3. **NEVER include secrets** in session checkpoints or skill files
4. **NEVER pass secrets as CLI arguments** — they appear in process lists
5. **NEVER commit** `.env`, `.env.*`, or `.env.secrets`
6. Use `make secrets-show` to verify configuration without exposing values
7. If a secret is accidentally exposed, rotate it immediately

## Troubleshooting
- Token expired → re-authenticate via `make setup`
- Pull fails → check `make secrets-show` for config, verify token permissions
- Missing env var → check if it exists in Infisical project, correct environment
