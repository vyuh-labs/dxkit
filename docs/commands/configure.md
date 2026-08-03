# `vyuh-dxkit configure`

Compute a deterministic configuration plan for this repo, and optionally
apply it. Each capability in the command registry declares a pure
`planConfig` probe that derives its recommended settings from observable
repo facts, so the same repo yields the same plan on every run and in
every environment. There is no judgment call: every plan line cites the
evidence that forced it.

## Usage

```bash
vyuh-dxkit configure [path]           # show the plan (nothing written)
vyuh-dxkit configure [path] --apply   # merge the plan into .dxkit/policy.json
vyuh-dxkit configure check [path]     # CI drift detector (exit 1 if un-applied)
```

## Options

| Option    | Effect                                                                  |
| --------- | ----------------------------------------------------------------------- |
| `--apply` | Write the plan into `.dxkit/policy.json` (default is plan-only)         |
| `--json`  | Structured output (`configure.v1` / `configure-apply.v1` / `-check.v1`) |

## Behavior

- **Plan (default).** Shows each recommended section with a summary, the
  reason, and the repo evidence behind it. Nothing is written.
- **`--apply`.** Deep-merges the plan into `.dxkit/policy.json`,
  preserving every existing key (a malformed existing policy is left
  intact and reported, never overwritten). Idempotent: a section that is
  already pinned goes silent in the plan, so re-running is a no-op. After
  a write, any managed workflows the newly enabled knobs gate are
  re-rendered through the same reconciliation `policy set` uses, so a
  knob is never left on with nothing serving it.
- **`configure check`.** Exits non-zero when the plan is non-empty, that
  is, when a capability's recommended config has not been applied (a
  newly shipped capability, or a section someone removed). It verifies
  completeness only: a section deliberately set to a non-computed value
  is treated as a pinned override and respected, not flagged.
- **Registry-driven.** The plan iterates the capability registry, so a
  capability that ships tomorrow with its own `planConfig` joins the plan
  automatically.

The `dxkit-onboard` skill is the conversational driver for this command:
it runs the plan, shows it, gets confirmation, then applies.

## See also

- [`.dxkit/policy.json` reference](../configuration/policy.md), the file
  `--apply` writes into
- [`vyuh-dxkit doctor`](doctor.md), which recommends unused capabilities
- [Admin quickstart](../learn/quickstart-admin.md) for the onboarding flow
