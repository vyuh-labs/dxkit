---
name: gcloud
description: Google Cloud Platform operations — gcloud CLI, Cloud Run, GKE, BigQuery, IAM, GCS. Use when asked about GCP, Google Cloud, gcloud commands, or cloud infrastructure.
---

# Google Cloud (gcloud)

## Setup
- **Auth:** `gcloud auth login` (configured during `make setup`)
- **Project:** Set in `.env` as `GOOGLE_CLOUD_PROJECT`
- **SDK:** Installed via devcontainer post-create script

## Common Commands

### Authentication & Project
```bash
gcloud auth list                              # check auth status
gcloud config get-value project               # current project
gcloud config set project <PROJECT_ID>        # switch project
gcloud projects list                          # list accessible projects
```

### Services & Resources
```bash
gcloud services list --enabled                # enabled APIs
gcloud run services list                      # Cloud Run services
gcloud container clusters list                # GKE clusters
gcloud sql instances list                     # Cloud SQL instances
gcloud storage ls                             # GCS buckets
```

### Logs & Monitoring
```bash
gcloud logging read "resource.type=cloud_run_revision" --limit=50
gcloud logging read "severity>=ERROR" --limit=20 --format=json
```

## Integration with Secrets

GCP project ID is stored in `.env`:
```
GOOGLE_CLOUD_PROJECT=my-project-id
```

Use `make secrets-pull` to fetch GCP-related secrets from Infisical.

## Security — CRITICAL

1. **NEVER output `gcloud auth print-access-token`** — it exposes bearer tokens
2. **NEVER output or log service account JSON keys**
3. **NEVER embed credentials in code** — use Workload Identity or Application Default Credentials
4. Use `gcloud auth application-default login` for local development
5. In production, use Workload Identity Federation (not service account keys)

## Deployment

See the `deploy` skill for GCP deployment patterns (Cloud Run, GKE).

## Gotchas

See [references/gotchas.md](references/gotchas.md) for GCP-specific issues.
