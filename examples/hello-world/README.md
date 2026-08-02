# dxkit hello-world

The smallest possible repo that demonstrates dxkit's full closed loop:
**score → baseline → gate**. Zero dependencies; the whole walkthrough runs
in under a minute.

## 1. Make it a standalone repo

dxkit anchors to a git repository, so copy this directory out and init:

```bash
cp -r examples/hello-world /tmp/hello-world && cd /tmp/hello-world
git init -b main && git add . && git commit -m "hello world"
```

## 2. Install dxkit

```bash
npm init @vyuhlabs/dxkit -- --yes
git add . && git commit -m "add dxkit"
```

## 3. Score it

```bash
npx vyuh-dxkit health
```

Six dimensions, each with structured deductions. A repo this small scores
oddly in places (one file, two tests) — the point is seeing the shape of
the output, not the number.

## 4. Capture the baseline

```bash
npx vyuh-dxkit baseline create --mode=committed-full
git add .dxkit && git commit -m "baseline"
```

This records the repo's current findings as the accepted state. There is
deliberately no pre-captured baseline checked into this example: a
baseline is a **capture of your environment**, not an artifact you copy —
a copied one goes stale against your scanner versions and reads as drift.

## 5. Trip the gate

Introduce a "leak" and watch the guardrail block it (the token is
generated on your machine — this guide deliberately contains no
secret-shaped string itself):

```bash
cat >> src/greet.js <<EOF
const apiKey = 'sk-demo-$(openssl rand -hex 16)';
EOF
npx vyuh-dxkit guardrail check
```

The check exits non-zero and names the net-new finding with its
fingerprint. Revert (`git checkout src/greet.js`) and the same check
passes: nothing net-new against the baseline.

## What you just saw

- `health` — the deterministic score (same repo, same number).
- `baseline create` — today's state becomes the accepted floor.
- `guardrail check` — only **net-new** findings block; the pre-existing
  state never does.

From here, the real setup guide: [docs/getting-started.md](../../docs/getting-started.md).
