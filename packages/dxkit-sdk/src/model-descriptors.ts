/**
 * The MODEL-SCHEMA descriptor language — sibling of `descriptors.ts` (the
 * HTTP-flow half of the frozen surface, whose module doc carries the shared
 * design rationale). Split by file only: both halves are one contract,
 * exported together from the barrel and pinned by the same freeze test.
 */

/**
 * Declares WHICH constructs in this pack's source are data models — the
 * mirror of {@link HttpFlowSupport} for the model-schema capability.
 * Framework facts only: HOW to read a class/field/annotation from a grammar
 * lives in `src/ast/grammar-model-shape.ts`, and WHAT a model diff means
 * lives in `src/analyzers/model-schema/` (semantics, grammar-agnostic).
 *
 * Recognition is marker-based, never path-based: a construct is a model when
 * it carries a declared marker (base class, decorator, struct-tag
 * convention). Unmarked types are deliberately invisible to code extraction
 * — the honest answer for those is a spec-declared model (`schema.specs`),
 * exactly as `flow.specs` covers un-extractable routes. Bias every list
 * toward precision: a missed model is a disclosed gap, a false model floods
 * the drift diff.
 */
export interface ModelSchemaSupport {
  /**
   * Heritage markers: a class inheriting one of these is a model. Matched
   * against each heritage expression's verbatim text AND its trailing
   * identifier segment, so `'Model'` matches `models.Model` and
   * `'BaseModel'` matches `pydantic.BaseModel`.
   */
  modelBaseClasses?: string[];
  /**
   * WEAK heritage markers: names too generic to trust alone (SQLAlchemy's
   * conventional `Base` — any codebase can have an unrelated class named
   * `Base`). A weak match marks a model only when corroborated: at least
   * one field resolves through `fieldCallees` (a `Column(...)`-style
   * constructor). Real-repo validation forced this split — a strong
   * `'Base'` marker minted an e-commerce framework's strategy/policy
   * classes as models.
   */
  weakModelBaseClasses?: string[];
  /**
   * Decorator markers: `@Entity()`, `@Table(...)`, `@dataclass`. Matched on
   * the decorator's callee/name trailing segment; bare and called forms both
   * count.
   */
  modelDecorators?: string[];
  /**
   * Struct-tag markers (Go): a struct any of whose fields carries one of
   * these tag keys is a model. The tag's value also supplies the wire field
   * name (first comma-separated token), with `omitempty` read as optional.
   */
  structTagKeys?: string[];
  /**
   * Field-initializer callees that carry the field's type and optionality
   * (ORM column constructors): `models.CharField(max_length=…, null=True)`,
   * `Column(String, nullable=False)`, `db.Column(db.Integer)`. Matched on
   * the callee's trailing segment. `typeFrom` says where the type token
   * lives: `'callee'` (Django — `CharField` IS the type; the default) or
   * `'firstArg'` (SQLAlchemy — `Column(String, …)`); the token is folded
   * through `typeAliases`. `optionalityKeyword` names the keyword argument
   * that carries optionality and `optionalityPolarity` its meaning
   * (`'nullable'`: true ⇒ optional; `'required'`: true ⇒ required).
   *
   * Fluent ORMs put the constructor at the CHAIN HEAD and facts on the
   * links — Exposed's `varchar("name", 50).nullable()`. The engine walks
   * receiver links from the initializer's tail call to find the matching
   * head, and `optionalityChainCallees` names the link(s) that mark the
   * field OPTIONAL (`['nullable']`); when declared and no such link is
   * present, the framework default is required. Additive (SDK minor).
   */
  fieldCallees?: Array<{
    names: string[];
    typeFrom?: 'callee' | 'firstArg';
    optionalityKeyword?: string;
    optionalityPolarity?: 'nullable' | 'required';
    optionalityChainCallees?: string[];
  }>;
  /**
   * What a TYPED field with NO optionality signal at all means in this
   * pack's frameworks. The engine default (`'required'`) matches TS and
   * Pydantic semantics — a plain `name: str` is required. JPA is the
   * opposite: an unannotated column defaults to nullable, and Java's
   * grammar cannot mark optionality, so stamping `required` would fabricate
   * a fact and let the drift gate block on it — such packs declare
   * `'unknown'` (an honest null that never gates; explicit
   * `fieldDecoratorSpecs`/marker/fold signals still win). Additive
   * (SDK minor).
   */
  defaultFieldOptionality?: 'required' | 'unknown';
  /**
   * FIELD-decorator facts: annotations on a field that carry its wire name
   * and/or optionality — JPA's `@Column(name = "wire_name",
   * nullable = false)`. Matched on the decorator name's trailing segment.
   * `optionalityKeyword` names the annotation argument carrying optionality
   * and `optionalityPolarity` its meaning (`'nullable'`: true ⇒ optional;
   * `'required'`: true ⇒ required) — read only when EXPLICITLY present, so
   * an unannotated field keeps the grammar/lexical answer (or an honest
   * `null`, which never gates). `wireNameKeyword` names the argument whose
   * string value replaces the declared field name on the wire.
   * `wireNameFrom: 'firstArg'` reads the wire name from the decorator's
   * FIRST POSITIONAL string argument instead — the C# convention
   * (`[Column("user_name")]`, `[JsonPropertyName("created_at")]`) and
   * kotlinx's `@SerialName("wire")`; a declared `wireNameKeyword` match
   * wins when both are present. Mirror of `fieldCallees` for
   * annotation-carried facts. Additive (SDK minor).
   */
  fieldDecoratorSpecs?: Array<{
    names: string[];
    optionalityKeyword?: string;
    optionalityPolarity?: 'nullable' | 'required';
    wireNameKeyword?: string;
    wireNameFrom?: 'firstArg';
  }>;
  /**
   * SCHEMA-FILE tables: a declared file whose table-definition calls ARE the
   * model source — Rails' `db/schema.rb`, where `create_table "users" do |t|
   * … t.string "email", null: false` is the authoritative field list (the
   * ActiveRecord class body declares none). The engine parses each declared
   * file with the pack's grammar and mints ONE entity per `tableCallees`
   * call: entity name = the call's first string argument (the table name —
   * the wire contract), each MEMBER call in its block with a string first
   * argument contributes a field (name = the argument, type = the member
   * method's name, folded through `typeAliases`). `optionalityKeyword`
   * names the keyword carrying nullability (`null: false` ⇒ required);
   * an ABSENT keyword reads as the framework default (nullable ⇒ optional —
   * a schema-file fact, unlike source classes where absence is unknown).
   * Class markers (`modelBaseClasses`) then serve DISCOVERY only — the
   * engine does not ALSO mint marker classes as empty entities when this
   * field is declared, so one logical model never appears twice under two
   * names. Additive (SDK minor).
   */
  schemaFileTables?: {
    /** Repo-relative schema files to parse (`['db/schema.rb']`). */
    files: string[];
    /** Table-definition callee names (`['create_table']`). */
    tableCallees: string[];
    /** Keyword argument carrying nullability on a column call (`'null'`). */
    optionalityKeyword?: string;
  };
  /**
   * TYPE-REFERENCE model containers: a container class whose PROPERTY TYPE
   * ARGUMENTS mark the referenced classes as models — EF Core's `DbSet<Order>`
   * properties on a `DbContext` subclass (the marker lives on the container,
   * not the entity). The engine collects every referenced type name from
   * classes inheriting a `containerBaseClasses` entry (property types
   * wrapped in a `propertyTypeWrappers` name — `DbSet<Order>` → `Order`)
   * and promotes the so-named classes to models (`via: 'type-ref'`),
   * repo-wide. Additive (SDK minor).
   */
  modelTypeRefContainers?: {
    /** Base classes marking a container (`['DbContext']`). */
    containerBaseClasses: string[];
    /** Generic wrappers whose type argument is a model (`['DbSet']`). */
    propertyTypeWrappers: string[];
  };
  /**
   * Transparent type wrappers folded OUT of annotation text before any
   * other normalization: `Mapped[X]` (SQLAlchemy 2.0) reads as `X`, so the
   * inner `Optional[...]` optionality still folds and a wrapper is never
   * part of the compared type. Matched on the wrapper's trailing segment
   * (`so.Mapped[...]` counts as `Mapped[...]`).
   */
  transparentTypeWrappers?: string[];
  /**
   * Lexical type aliases folded by the shared normalizer (mirror of
   * `methodAliases`; keys MUST be lowercase): `{ charfield: 'string',
   * integerfield: 'int' }`. Values are the pack's chosen canonical token —
   * comparison stays within one language, so cross-language agreement is
   * neither needed nor attempted.
   */
  typeAliases?: Record<string, string>;
  /**
   * Cheap dependency-manifest signals that this language's model surface is
   * present (mirror of `flowSignals`). Drives DISCOVERY only — doctor's
   * "you'd benefit from the schema gate" recommendation and the config
   * planner — never extraction.
   */
  schemaSignals?: Array<{ manifest: string; anyOf: string[] }>;
}
