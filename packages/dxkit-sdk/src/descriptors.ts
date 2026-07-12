/**
 * The declarative descriptor language — the frozen core of the extension
 * surface.
 *
 * These are the construct-family tables dxkit's own language packs declare
 * (`LanguageSupport.httpFlow` / `.modelSchema` in the main package) and the
 * same shapes rung-4 plugin dialects contribute. They are SEMANTIC
 * descriptors matched against the tree-sitter AST by one shared extractor;
 * a descriptor says WHICH constructs are HTTP calls / routes / models, and
 * the engine reads them structurally. Repo-path references in the doc
 * comments point into the dxkit monorepo (github.com/vyuh-labs/dxkit),
 * where the consuming engine lives.
 */

/**
 * Per-pack HTTP-flow descriptors: how this language's source expresses
 * outbound HTTP calls (the CONSUMED side) and inbound route declarations
 * (the SERVED side). Declared by each language pack (Rule 6) and consumed
 * through `allHttpFlow` in `src/languages/index.ts`; the cross-cutting flow
 * extractor (`src/analyzers/flow/`) reads the active-pack union and never
 * branches on language id or hardcodes framework literals (`fetch`,
 * `@get`, `router.post`).
 *
 * These are SEMANTIC descriptors matched against the tree-sitter AST — not
 * regexes over text (Rule 5). The extractor finds call expressions /
 * decorators whose callee matches a descriptor, then reads the argument
 * nodes for the method + URL. The descriptors say WHICH constructs are HTTP;
 * the engine reads them structurally.
 *
 * URL normalization (host-helper stripping, `:id`/`{id}`/`${x}` → `{var}`,
 * query stripping) is deliberately NOT here: host helpers are per-APP config
 * (`flow.stripUrlPrefixes`), and param-form canonicalization is uniform
 * across frameworks, so both live in the shared normalizer rather than in a
 * per-language descriptor.
 *
 * These fields are exactly what is needed to extract axios + custom-wrapper
 * client calls from a React frontend and LoopBack `@get`/`@post` + Express
 * `router.<method>` routes — the union that, on a real axios → LoopBack stack,
 * matched-or-beat a hand-tuned regex tool at higher precision.
 *
 * Optional — a pack with no HTTP surface (or none modeled yet) omits it,
 * and the flow extractor sees the empty union for that language.
 */
/**
 * File-convention routing: how a pack's framework serves a route from a file's
 * LOCATION on disk rather than an in-source decorator or router call. Next.js
 * App Router (`app/**` `/route.ts` exporting `GET`/`POST`), SvelteKit
 * (`src/routes/**` `/+server.ts`), and Next.js Pages Router (`pages/api/**`)
 * all fit this shape — the served URL is derived from the directory path and
 * the HTTP verb is an exported symbol's name.
 *
 * The pack declares only what is genuinely framework-specific — the handler
 * filename, the routing base directories, an optional fixed URL prefix, and the
 * verb-named exports. The uniform "file-route path algebra" (route groups,
 * `[param]` / `[[...catch-all]]` dynamics, private `_`-segments, parallel
 * `@`-slots) lives centrally in `src/analyzers/flow/file-routes.ts`, the same
 * Rule 6 boundary the URL normalizer draws — those conventions are shared
 * across every file-route framework, so they are not a per-pack fact.
 */
export interface FileRouteSupport {
  /**
   * Basename (without extension) of a route-handler file — Next.js App Router
   * `'route'`, SvelteKit `'+server'`. Use `'*'` when EVERY file under a base
   * serves a route (Next.js Pages Router `pages/api`, where the filename itself
   * becomes the last path segment and `index` collapses to its directory).
   * Matched against the file's basename with its extension removed.
   */
  handlerFile: string;

  /**
   * Repo-relative directory prefixes under which routing begins; the URL path
   * is derived from the segments AFTER the matched base. The longest (most
   * specific) matching base wins, so `['src/app', 'app']` prefers `src/app`.
   */
  baseDirs: string[];

  /**
   * Fixed URL prefix prepended to every derived path — for a base whose own
   * name is part of the served URL (`pages/api` serves under `/api`). Optional;
   * App Router / SvelteKit omit it because the base directory is not served.
   */
  urlPrefix?: string;

  /**
   * Named exports whose name IS an HTTP verb (`GET`, `POST`, `PUT`, `PATCH`,
   * `DELETE`, `HEAD`, `OPTIONS`). The export's name is the method. Matched
   * against `export function GET`, `export const GET =`, and `export { GET }`.
   */
  methodExports: string[];
}

export interface HttpFlowSupport {
  /**
   * Bare-callee identifiers that initiate an outbound HTTP request with the
   * URL as the first argument. The canonical case is the Fetch API
   * `fetch(url, opts)`. Method comes from the `opts.method` option (default
   * GET). Matched on a `call_expression` whose `function` is an identifier
   * in this list.
   */
  clientCallees?: string[];

  /**
   * Member-method client calls of the form `<base>.<method>(url, ...)`.
   * `methods` are the property names that map to HTTP verbs
   * (`get`/`post`/`put`/`delete`/`patch`); the verb is the method name.
   *
   * `bases` declares TRUSTED receivers — module-level HTTP clients that are
   * HTTP by construction (`requests`, `httpx`). A trusted receiver's call
   * counts even when its URL argument is not a literal (recorded as a
   * DYNAMIC call site — the coverage-honesty channel), because dropping it
   * would silently understate what flow cannot see. Any OTHER receiver
   * still counts when its first argument is a path-like literal — that
   * precision guard is what admits app-specific wrappers
   * (`api.get('/x')`, `agent.Articles.del(...)`) that no fixed allowlist
   * can enumerate while keeping non-HTTP `.get`/`.delete` (lodash, Maps,
   * dict.get) out. `bases` therefore only ever ADDS matches (trust
   * elevation) — it never narrows the wrapper coverage.
   */
  clientMethodCallees?: { methods: string[]; bases?: string[] };

  /**
   * Decorator-style route declarations: `@<name>('/path')` on a handler
   * method (LoopBack `@get`, NestJS `@Post`). `<name>` maps to the HTTP
   * verb; the first string/template argument is the route path. Matched on
   * `decorator` nodes whose call callee is an identifier in this list.
   */
  routeDecorators?: string[];

  /**
   * Router-style route declarations: `<base>.<method>('/path', handler)`
   * (Express `app.get(...)`, `router.post(...)`). `methods` map to verbs;
   * `bases` are the receiver identifiers (`app`, `router`).
   */
  routeRouterCallees?: { methods: string[]; bases: string[] };

  /**
   * MEMBER-callee route decorators: `@<recv>.<method>('/path')` on a handler
   * (FastAPI `@app.get('/x')` / `@router.post('/x')`, Sanic, Flask 2's
   * `@app.get`). The property name maps to the HTTP verb; the first string
   * argument is the route path and MUST begin with `/` once unquoted — these
   * frameworks mandate a leading slash, and requiring it is the precision
   * guard that keeps look-alike member decorators (`@mock.patch('pkg.attr')`)
   * out. `bases`, when present, restricts which receiver identifiers count;
   * omit it for frameworks whose app/router objects are user-named.
   */
  routeMemberDecorators?: { methods: string[]; bases?: string[] };

  /**
   * PATH-first route decorators whose methods ride a keyword argument:
   * Flask's `@app.route('/x', methods=['GET', 'POST'])`, Spring's
   * `@RequestMapping("/x", method = RequestMethod.GET)`. `names` are the
   * decorator callee names (member or bare — `@app.route` and `@route` both
   * match on `route`); the first string argument is the path (leading `/`
   * required, as above — see `decoratorPathKeywords` for keyword-carried
   * paths). `methodsKeyword` names the keyword argument carrying the verb
   * list (a single non-list value is read as a one-verb list; dotted enum
   * refs like `RequestMethod.GET` contribute their trailing segment); when
   * absent the route is emitted once per entry in `defaultMethods` (Flask's
   * default is GET-only). A `defaultMethods` entry of `'ANY'` emits the
   * method-agnostic route instead of a concrete verb — Spring's bare
   * `@RequestMapping("/x")` accepts every method.
   */
  routePathDecorators?: { names: string[]; methodsKeyword: string; defaultMethods: string[] };

  /**
   * Keyword/attribute arguments that may carry a route decorator's PATH when
   * it has no positional string argument: Spring's
   * `@RequestMapping(value = "/x")` / `@GetMapping(path = "/y")`. Read in
   * declaration order via the grammar's keyword-argument shape wherever a
   * decorator form (`routeDecorators`, `routeMemberDecorators`,
   * `routePathDecorators`, `routePrefixDecorators`) finds no positional
   * path. Additive (SDK minor).
   */
  decoratorPathKeywords?: string[];

  /**
   * Ancestor route-PREFIX decorators: an annotation on an ENCLOSING
   * declaration whose path prefixes every route its descendants declare —
   * Spring's class-level `@RequestMapping("/api/users")`, JAX-RS's
   * class-level `@Path("/widgets")`. When a route is extracted from a
   * decorator form, the extractor walks the handler's ancestor declarations
   * (starting ABOVE the handler's own declaration, so a same-declaration
   * annotation is never read as its own prefix) and joins each matching
   * prefix, outermost first. The prefix path is the decorator's first
   * positional string or a `decoratorPathKeywords` keyword; no leading-slash
   * requirement (JAX-RS allows `@Path("widgets")`). Additive (SDK minor).
   */
  routePrefixDecorators?: { names: string[] };

  /**
   * Ancestor route-GROUP calls: a call whose first string argument prefixes
   * every route declared inside its body/lambda — Ktor's
   * `route("/api") { get("/x") { … } }`. On a matched call-declared route,
   * the extractor walks ancestor call nodes (via the grammar shape's
   * `calleeCall` chain for trailing-lambda forms) and joins each matching
   * group's path, outermost first. Additive (SDK minor).
   */
  routeGroupCallees?: { names: string[] };

  /**
   * BARE verb-named route callees: the callee IS the verb and the first
   * argument is the path — Ktor's `get("/x") { … }`, Sinatra's
   * `get '/items' do … end`, Rails' `get '/x', to: 'ctrl#show'`.
   *
   * Precision guards. The first positional argument must be a string
   * literal beginning with `/` — always. Beyond that, the optional guards
   * form a QUALIFIER SET: when one or more are declared, a call must
   * satisfy AT LEAST ONE of them (a bare `get '/x'` in a request spec
   * satisfies none and is kept out):
   *   - `requireTrailingLambda` — the call carries a trailing lambda/block
   *     (grammars whose shape implements `hasTrailingLambda`; Ktor/Sinatra
   *     handler blocks);
   *   - `handlerKeywords` — the call carries one of these keyword
   *     arguments (Rails' `to:` — the argument that names a handler);
   *   - `ancestorCallees` — the call sits (transitively) inside a call to
   *     one of these names (Rails' `draw`/`namespace`/`scope` blocks —
   *     routes.rb is always inside `routes.draw do … end`).
   *
   * `methodsKeyword`, when declared, names a keyword argument carrying an
   * EXPLICIT verb list (Rails' `match '/x', via: [:get, :post]`) — read
   * for a callee whose own name is not a verb (`match`); tokens normalize
   * through `methodAliases` and non-verbs drop out. A non-verb callee with
   * no readable keyword verbs declares nothing.
   *
   * Combine with `routeGroupCallees` for nested prefixes. Additive
   * (SDK minor).
   */
  routeVerbCallees?: {
    methods: string[];
    requireTrailingLambda?: boolean;
    handlerKeywords?: string[];
    ancestorCallees?: string[];
    methodsKeyword?: string;
  };

  /**
   * RESOURCE-expansion route callees: a call whose SYMBOL/string argument
   * expands to the framework's fixed RESTful route set — Rails'
   * `resources :articles` (7 actions / 8 verb+path routes) and its singular
   * `resource :profile`. The expansion table is a documented framework
   * contract, not speculation, and lives in the engine; `only:` / `except:`
   * keyword lists filter it. `singularNames` entries expand WITHOUT the
   * `/{var}` id segment and without an index action (the Rails `resource`
   * semantics). `ancestorCallees` is the same precision guard as
   * `routeVerbCallees`' — when declared, the call must sit inside one.
   * Ancestor `routeGroupCallees` prefixes apply (`namespace :api do`).
   * Additive (SDK minor).
   */
  routeResourceCallees?: {
    names: string[];
    singularNames?: string[];
    ancestorCallees?: string[];
  };

  /**
   * Framework TOKENS inside a route/prefix path that substitute a fact from
   * the ENCLOSING TYPE — ASP.NET's `[Route("api/[controller]")]`, where
   * `[controller]` is the enclosing class name minus its `Controller`
   * suffix, lowercased. Substitution happens BEFORE normalization (the
   * normalizer's `[…]` param rule would otherwise silently turn the token
   * into an over-matching `{var}`). Requires the grammar shape to implement
   * `enclosingTypeName`; when the type cannot be resolved, the path is
   * DROPPED rather than emitted with a placeholder — a wrong prefix
   * corrupts every route under it. Additive (SDK minor).
   */
  routeTokenFromEnclosingType?: Array<{
    /** The literal token as it appears in the raw path (`'[controller]'`). */
    token: string;
    /** Suffix stripped from the type name before substitution (`'Controller'`). */
    stripSuffix?: string;
    /** Lowercase the substituted name (ASP.NET convention). */
    lowercase?: boolean;
  }>;

  /**
   * SPLIT verb/path annotation pairs: one MARKER annotation names the verb
   * and a SIBLING annotation on the same declaration carries the path —
   * JAX-RS `@GET` + `@Path("/x")` on one handler method. `methodMarkers`
   * match only argument-less marker forms (a CALLED `@GET("path")` is a
   * `clientDecorators` fact — Retrofit — and never a pair match; that
   * asymmetry is the disambiguator when one pack declares both). The path
   * comes from the sibling in `pathNames` (first positional or
   * `decoratorPathKeywords`; no leading-slash requirement), or from ancestor
   * `routePrefixDecorators` alone when the handler has no own path (JAX-RS
   * class-level `@Path` + bare method `@GET`). Additive (SDK minor).
   */
  routeAnnotationPairs?: { methodMarkers: string[]; pathNames: string[] };

  /**
   * CLIENT-side call decorators: an annotation on a method declaration that
   * declares an OUTBOUND call — Retrofit's `@GET("users/{id}")` on an
   * interface method. The decorator name maps to the verb (via
   * `methodAliases`); the path is the first positional string argument.
   * Deliberately NO leading-slash guard: these paths are RELATIVE (joined
   * against a configured base URL at runtime), which is also what
   * disambiguates them from `routeAnnotationPairs` markers — only a CALLED
   * decorator with a string argument matches here. Additive (SDK minor).
   */
  clientDecorators?: { names: string[] };

  /**
   * BUILDER-CHAIN clients: the verb and the URL live on DIFFERENT calls of
   * one method chain — Spring WebClient
   * (`webClient.get().uri("/x").retrieve()`), java.net.http
   * (`HttpRequest.newBuilder().uri(URI.create("/x")).GET()`), OkHttp
   * (`new Request.Builder().url("…").get().build()`). On a member call whose
   * name is in `urlCallees` with a string-literal argument, the extractor
   * scans the chain (receiver links via the shape's `receiverNode`, and
   * ancestor links where this call is itself a receiver) for a call named in
   * `verbCallees` (the verb, via `methodAliases`) or `methodArgCallees`
   * (verb as ITS first string argument — `.method("POST")`). Both found →
   * one client call; a URL argument wrapped in an `unwrapArgCallees` call
   * (`URI.create("/x")`) is unwrapped first. A chain with a verb but a
   * runtime-built URL is counted as a dynamic call site (coverage honesty),
   * never silently dropped. Additive (SDK minor).
   */
  clientBuilderChains?: Array<{
    urlCallees: string[];
    verbCallees: string[];
    methodArgCallees?: string[];
    unwrapArgCallees?: string[];
  }>;

  /**
   * Route declarations that bind a path to a handler with NO verb in the
   * callee name: Django's `path('users/<int:pk>/', view)` in `urls.py`, Go's
   * `http.HandleFunc("/x", h)`. The route is emitted with the `ANY` method
   * (see `ANY_METHOD` in `analyzers/flow/normalize.ts`) — method-agnostic at
   * the routing layer, resolving a consumed call with any verb on that path —
   * unless `methodPrefixInPath` extracts a concrete verb (below).
   *
   * - `names` matches BARE callees (`path(...)`). Bare route strings keep
   *   their framework's shape (Django routes carry no leading `/`).
   * - `memberNames` matches MEMBER callees on ANY receiver
   *   (`http.HandleFunc(...)`, `mux.Handle(...)`). Member matches REQUIRE the
   *   route literal to begin with `/` (after any method prefix) — every Go
   *   pattern does, and the guard keeps generic `.Handle('event', fn)`
   *   registrations from minting phantom routes.
   * - `methodPrefixInPath` reads Go 1.22 mux patterns: a first argument of
   *   `"GET /users/{id}"` yields a concrete `GET` route; no prefix → `ANY`.
   * - Common guards: string-literal first argument, a second (handler)
   *   argument present, and `excludeArgCallees` skips declarations whose
   *   arguments include a call to one of these names (Django's `include(...)`
   *   mounts a sub-conf; its first argument is a PREFIX, not a served route).
   */
  routeCallees?: {
    names?: string[];
    memberNames?: string[];
    excludeArgCallees?: string[];
    methodPrefixInPath?: boolean;
  };

  /**
   * Request-CONSTRUCTOR clients whose METHOD is the first argument and URL the
   * second: Go's `http.NewRequest("GET", url, body)` /
   * `http.NewRequestWithContext(ctx, ...)` is the stdlib way to make non-GET
   * requests, and Python's `requests.request("GET", url)` fits the same shape.
   * `names` are the callee names (bare or member); `bases`, when declared,
   * restricts member receivers (`http`) so a same-named constructor elsewhere
   * doesn't count. A literal method + literal URL yields a binding; a literal
   * method with a runtime-built URL (the common case) is COUNTED as a dynamic
   * call site rather than silently dropped — these constructors are HTTP by
   * definition, so invisibility would understate what flow cannot verify.
   */
  clientRequestCallees?: { names: string[]; bases?: string[] };

  /**
   * Canonicalize a matched method token to an uppercase HTTP verb where the
   * token differs from the verb. The motivating alias is LoopBack's `del` →
   * `DELETE`. Tokens absent from the map default to upper-casing
   * (`get` → `GET`). Keys are lowercase method tokens.
   */
  methodAliases?: Record<string, string>;

  /**
   * File-convention routing (Next.js App Router / SvelteKit / Pages Router):
   * routes served by a handler file's LOCATION, not an in-source decorator or
   * router call. The extractor derives the served URL from the file's directory
   * and reads verb-named exports for the methods. See {@link FileRouteSupport}.
   *
   * Optional — a pack whose frameworks route only in-source omits it.
   */
  fileRoutes?: FileRouteSupport;

  /**
   * Cheap dependency-manifest signals that this language's HTTP-flow surface
   * is present in a repo — each entry names a manifest file and the framework
   * tokens to look for in it. Drives DISCOVERY only (doctor's "you'd benefit
   * from flow" recommendation and the config planner's warn-mode seed), never
   * extraction: extraction runs wherever the descriptor matches source. A
   * `package.json` manifest is matched on its dependency KEYS; any other
   * manifest (requirements.txt, pyproject.toml, Gemfile, go.mod) on a
   * word-boundary text search — precise enough for a fail-open
   * recommendation probe. Without this field a pack's repos are simply never
   * proactively recommended flow (extraction still works once configured).
   */
  flowSignals?: Array<{ manifest: string; anyOf: string[] }>;
}

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
   */
  fieldCallees?: Array<{
    names: string[];
    typeFrom?: 'callee' | 'firstArg';
    optionalityKeyword?: string;
    optionalityPolarity?: 'nullable' | 'required';
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
