# @vyuhlabs/create-dxkit

One-command bootstrap for [`@vyuhlabs/dxkit`](https://github.com/vyuh-labs/dxkit).

## Usage

In any directory (empty or existing repo):

```bash
# Full install: hooks + devcontainer + CI guardrails + baseline-refresh + dxkit-specific agents
npm init @vyuhlabs/dxkit

# Pass-through flags require a leading `--` (npm convention):
npm init @vyuhlabs/dxkit -- --dx-only --yes
npm init @vyuhlabs/dxkit -- --with-hooks --with-ci --yes
```

This collapses what was previously two commands:

```bash
npm install --save-dev @vyuhlabs/dxkit
npx vyuh-dxkit init --full --yes
```

into one. Useful at the first-install moment — the highest-leverage UX touchpoint.

## What it does

1. Refuse to run in a home directory or filesystem root (a project
   directory is required — nothing is written on refusal).
2. If the current directory has no `package.json`, seed a minimal one.
3. Install `@vyuhlabs/dxkit` into `devDependencies` (retries with
   `--legacy-peer-deps` once if the initial install hits an ERESOLVE).
4. Forward your args (or `--full --yes` if none) to `vyuh-dxkit init`.

After this runs, every dxkit subcommand is available via
`./node_modules/.bin/vyuh-dxkit` or `npx vyuh-dxkit`.

## Why this exists

The npm `create-*` convention (matching `create-react-app`,
`create-vite`, `create-nuxt`, etc.) is what customers expect when they
first hear "try out X." Today's two-step dance had UX overhead
(remembering `--save-dev`, finding `./node_modules/.bin/vyuh-dxkit`,
the `--legacy-peer-deps` retry) at exactly the wrong moment.
