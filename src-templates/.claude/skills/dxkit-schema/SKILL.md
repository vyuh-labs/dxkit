---
name: dxkit-schema
description: Configure, read, and act on the dxkit model-schema drift gate — list the data-model inventory, preview drift before pushing, explain why the guardrail blocked a model change, and ship a deliberate breaking change the safe way (migration + expiring accepted-risk allowlist entry). Use when the user says "set up the schema gate", "what models does this repo declare", "the guardrail says I broke a model", "why is removing this field blocked", "we're intentionally changing this schema", or anything about data-model / schema drift gating.
---

# dxkit-schema

This skill owns the **model-schema drift gate**: dxkit statically extracts every declared data model (ORM entities, tagged structs, spec schemas) and fails a PR that changes one in a breaking way — a removed field, a changed type, an optional field made required, a removed model. Additive changes surface as warnings or information, never blocks.

It is **thin orchestration over the deterministic CLI.** It never re-implements extraction or diffing: it runs `schema` / `schema diff` / `guardrail check`, reads their structured output, and supplies judgment + code edits. The determinism stays in the CLI; the agent supplies the reasoning.

**Language coverage.** Recognition is marker-based per language pack — precision over recall. TypeScript/JavaScript: decorator-marked entity classes (TypeORM/MikroORM `@Entity`, sequelize-typescript `@Table`, NestJS-mongoose `@Schema`, type-graphql `@ObjectType`/`@InputType`) plus `BaseEntity` heritage; field facts from the type annotations. Python: Django `models.Model`, SQLAlchemy `Base`/`DeclarativeBase`, pydantic `BaseModel`, SQLModel, and `@dataclass`; Django/SQLAlchemy field constructors supply types and `null=`/`nullable=` optionality. Go: a struct tagged `json:`/`gorm:`/`db:`/`bson:` IS a wire contract; the tag supplies the wire name, `omitempty` and pointer types read as optional. Java: JPA `@Entity`/`@Table`/`@Embeddable`/`@MappedSuperclass` classes; `@Column(nullable = …)` supplies optionality and `name = …` the wire name — an unannotated column is an honest unknown (JPA defaults to nullable; dxkit never fabricates `required`). Kotlin: JPA annotations, kotlinx `@Serializable` data classes (incl. positional `@SerialName("wire")` names), and Exposed `Table` objects (fluent column chains — `varchar("x", 50).nullable()` reads type + optionality); `String?` nullability is read from the grammar, `@Column` overrides it. C#: `[Table]`/`[Keyless]`/`[Owned]` entities AND classes referenced by a `DbContext`'s `DbSet<T>` properties; partial-class declarations assemble into one entity (codegen splits are never drift); `string?` NRT annotations supply optionality, positional `[Column("x")]`/`[JsonPropertyName("x")]` the wire names. Ruby (Rails): `db/schema.rb` is the model source — one entity per `create_table`, named by the TABLE (the wire contract), `null: false` ⇒ required and absence ⇒ nullable (the Rails default); the ActiveRecord class marker is discovery-only while a schema file exists. Rust: `#[derive(Serialize/Deserialize)]` structs; `Option<T>` optionality is precise, `#[serde(rename = "x")]` supplies wire names (`rename_all`/`default` container attributes are not read). **Any other language — and unmarked DTOs in covered languages — participate via a spec**: point `.dxkit/policy.json:schema.specs` at an OpenAPI (`components.schemas`) or JSON Schema document and its models are gated identically, no pack extraction needed.

**What the gate does not see** (tell the user honestly when relevant): unmarked plain interfaces/classes; dynamically-built schemas (disclosed in the inventory's dynamic list, not diffable); constraint-level changes (max length, enum members, validation rules, defaults); a type alias whose underlying type changed (comparison is lexical — resolving aliases would need a type-checker); serialization renames outside Go tags; migration files / raw SQL; whether anything actually consumes a removed field.

## Modes

### setup — turn the gate on

Setup is folded into `configure` / policy; **there is no `schema init` command.**

- `npx vyuh-dxkit configure --plan` detects a data-model framework and plans `schema.mode: warn` — show the plan, then `configure --apply`.
- Or edit `.dxkit/policy.json` directly:
  - `schema.mode`: `off` (default — the gate is opt-in) / `warn` (surface drift, never fail) / `block` (breaking drift fails the check, confidence-gated).
  - `schema.specs`: OpenAPI / JSON Schema files whose models union with code extraction — the language-independent bridge.
- Adoption path: `warn` first; move to `block` once `vyuh-dxkit schema` reads clean.

### inventory — what models does this repo declare?

```
npx vyuh-dxkit schema [--json]
```

Lists every extracted model with fields, types, optionality, and provenance (`base-class` / `decorator` / `struct-tag` / `spec`), plus the dynamic-model disclosure list. An `<unreadable>` type is an honest unknown — unknowns never block, so no need to chase them unless the user wants tighter gating.

### preview — will my change pass?

```
npx vyuh-dxkit schema diff [--ref <base>] [--json]
```

Runs the SAME evaluation the guardrail gate runs (same diff, same verdicts, same default base ref — the remote default branch), so the preview never tells a different story than CI. Groups: breaking (would block), warnings, informational.

### fix ⭐ — the guardrail blocked a model change

Read the guardrail output (`--json`: the `schemaDriftGate` block). For each finding decide with the user:

1. **Accidental break** (typo'd rename, unintended removal): fix the model. A rename reads as `field-removed` + `field-added` — restoring the old name (or reverting) clears it.
2. **Deliberate breaking change**: the safe shipping shape is migration + expiring allowlist entry:
   ```
   npx vyuh-dxkit allowlist add --fingerprint=<id> --kind=model-schema-drift \
     --category=accepted-risk --expires=<date> --reason="<migration link / why>"
   ```
   The fingerprint is location-free — it survives the model moving files or lines while the PR evolves. The entry shows up in the PR comment's suppressed section, so the decision stays reviewable.
3. **Misread declaration** (the extractor got a field wrong): allowlist with `--category=false-positive` and report it (`vyuh-dxkit issue`).

**Safety rule: repair or explicitly accept, never bypass.** Do not flip `schema.mode` to `off`/`warn` to clear one finding, and do not edit the base ref. The per-finding allowlist entry (with expiry) is the ONLY escape hatch — it is visible, reviewable, and time-boxed.

## What lives where

| Artifact | Role |
| --- | --- |
| `.dxkit/policy.json:schema` | mode / blockThreshold / specs — the single config source |
| `vyuh-dxkit schema` | inventory (code + spec models, dynamic disclosure) |
| `vyuh-dxkit schema diff` | pre-push drift preview (gate-identical) |
| `guardrail check` → `schemaDriftGate` | the gate verdict folded into the PR check |
| allowlist `--kind=model-schema-drift` | the per-finding escape hatch (accepted-risk + expiry) |

## Boundaries

- Posture / policy edits beyond `schema.*` → **dxkit-config**.
- Deciding fix-vs-suppress for other finding kinds → **dxkit-action**; allowlist lifecycle (audit, prune, stale) → **dxkit-allowlist**.
- The UI→API integration gate (routes and calls, not models) → **dxkit-flow**.
- Unattended-loop posture (the Stop-gate demotes schema blocks to warns under `security-only`) → **dxkit-loop**.
