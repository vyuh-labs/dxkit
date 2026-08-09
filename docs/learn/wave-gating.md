# Wave gating: judging an estate of trees as one composition

For pipelines that emit or convert **many services in one wave** and need a
verdict on the composition, not just on each member. Every member can pass
its own gate while the estate is still broken: service A calls an endpoint
nobody serves, service B serves an endpoint nobody calls anymore, and the
end-to-end flow the migration was supposed to preserve quietly lost a step.
The wave gate judges exactly that layer.

## Layout

Point `gate --workspace` at a directory whose immediate subdirectories are
the member trees, with an optional flows directory of declared expected
flows:

```
wave-2026-08/
├── svc-orders/          # member tree
├── svc-billing/         # member tree
├── svc-pricing/         # member tree
└── flows/               # declared flows (flow.v1)
    └── order-to-invoice.flow.json
```

```bash
vyuh-dxkit gate ./wave-2026-08 --workspace --flows flows --policy dod.json --json
```

Dot-directories and the flows directory itself are not members. Each member
is analyzed with the same per-tree machinery the single-tree gate uses;
the wave layer then composes the results.

## What the composition checks

The gate builds one **served mesh**: the union of every route every member
serves, resolved with the same catch-all-aware matcher the repo-level flow
gate uses. Against that mesh it evaluates three finding classes:

- **Unresolved call** (`no-route`, blocks): a member calls a method + path
  that no member serves. Absolute URLs are matched by path, so
  `http://pricing.internal/tax` resolves against any member serving
  `GET /tax`. Low-confidence paths (for example a path that starts with a
  variable, leaving nothing to anchor on) warn instead of blocking.
- **Dead route** (`dead-route`, warns): a member serves a route that no
  member call and no declared flow step consumes. In a conversion wave this
  is usually carried-over legacy surface; it warns because unused is a
  cleanup decision, not a defect, and an external caller dxkit cannot see
  may still depend on it.
- **Broken flow** (`broken-flow`, blocks): a declared flow has a step the
  mesh does not serve. This is the estate-level version of the paired
  change rule: the flow file states an intent ("order to invoice still
  works end to end"), and the gate holds the wave to it.

Every finding's locator is member-prefixed (`svc-billing/srv/server.js`),
so a wave verdict tells you which member to open.

## Authoring flows (flow.v1)

A flow file declares an ordered list of steps that must all be served:

```json
{
  "schema": "flow.v1",
  "id": "order-to-invoice",
  "description": "An order placed in orders must price and invoice.",
  "steps": [{ "call": "POST /orders" }, { "call": "GET /tax" }, { "call": "POST /invoices" }]
}
```

Rules of the format:

- `call` is `"<METHOD> <path>"`. Paths go through the same normalizer the
  rest of dxkit uses, so `/orders/{id}` and `/orders/:id` are the same step.
- The flows directory is scanned for `*.flow.json`. Two bare forms are also
  accepted so hand-written files stay short: a bare array of steps, and a
  bare `{ id, steps }` object without the `schema` field. Emit the full
  `flow.v1` form from tooling.
- A malformed step never silently disappears: it is disclosed in the
  verdict as unparseable, because a flow file that stops parsing must not
  read as a flow that passes.
- Flow findings are identified by flow id, so a broken flow blocks once,
  stably, rather than once per missing step per run.

Keep flow files in the repo that owns the wave definition and review
changes to them like contract changes: deleting a flow file is deleting a
guarantee.

## Reading a wave verdict

The `--json` output is `verdict.v1` with `mode: "wave"`. A typical failing
wave reads like this in the human rendering:

```
BLOCKED  wave: 3 members, 2 flows
  ✗ no-route   GET /tax        called by svc-billing/srv/server.js (no member serves it)
  ✗ broken-flow rebate-settlement  step GET /tax unserved
  ⚠ dead-route GET /legacy-rebate  served by svc-pricing, no consumer
```

Fixing the unresolved call (serve `GET /tax` in the member that owns
pricing) clears both blocks; removing the dead route clears the warning.
The wave then exits 0 with the satisfied flows staying quiet.

## Scope

A wave run is **both layers in one verdict**. Each member tree first goes
through the full single-tree gate under the same policy document (secrets,
SAST, dependency vulnerabilities, text rules), with its findings
member-prefixed; then the composition layer adds the mesh, call, and flow
findings on top. One engine, one policy format, one exit code: a wave
passes only when every member passes and the composition holds.
