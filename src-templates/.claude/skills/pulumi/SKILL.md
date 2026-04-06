---
name: pulumi
description: Pulumi infrastructure as code — stacks, previews, deployments, config. Use when asked about IaC, Pulumi, cloud resources, infrastructure provisioning, or stack management.
---

# Pulumi (Infrastructure as Code)

## Setup
- **Auth:** `pulumi login` (configured during `make setup`)
- **SDK:** Installed via devcontainer post-create script
- **Path:** `~/.pulumi/bin/pulumi`

## Core Workflow

**ALWAYS preview before applying changes:**

```bash
# 1. Preview changes (safe, read-only)
pulumi preview

# 2. Review the diff carefully

# 3. Apply changes (REQUIRES explicit user confirmation)
pulumi up

# 4. Check outputs
pulumi stack output
```

## Common Commands

### Stack Management
```bash
pulumi stack ls                    # list stacks
pulumi stack select <name>         # switch stack
pulumi stack output                # view outputs
pulumi stack export                # export state
```

### Configuration
```bash
pulumi config                     # view config
pulumi config set key value       # set plain config
pulumi config set --secret key value  # set encrypted secret
pulumi config get key             # get value
```

### State & History
```bash
pulumi stack history              # deployment history
pulumi state                      # inspect state
pulumi refresh                    # sync state with cloud
```

## Security — CRITICAL

1. **ALWAYS `pulumi preview` before `pulumi up`** — review the diff
2. **NEVER run `pulumi destroy` without explicit user confirmation** — it deletes all resources
3. **Use `pulumi config set --secret`** for sensitive values — never plain-text
4. **NEVER output `pulumi config get --secret`** values in responses
5. **State files may contain secrets** — ensure backend is secure (encrypted)
6. Pulumi passphrase (if using local backend) should be in `.env`, never hardcoded

## Integration

- Secrets from Infisical can be used as Pulumi config values
- GCP project from `.env` (`GOOGLE_CLOUD_PROJECT`) can configure Pulumi GCP provider
