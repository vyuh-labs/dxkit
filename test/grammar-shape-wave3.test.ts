/**
 * C# + Ruby + Rust grammar-shape rows, verified against the bundled wasms.
 *
 * C# pins the hand-written third-family row (callee-field calls + FUSED
 * attributes, argument wrappers, generic-name unwrap, interpolated-string
 * prefix strip). Ruby pins the fused-callee factory extensions (symbols,
 * trailing blocks, the hash-rocket pair-key path). Rust pins the two member
 * forms (field_expression + scoped_identifier) and sibling attributes with
 * token-soup arguments. The descriptor-driven ENGINE forms these rows feed
 * are pinned in the wave-3 flow-extract tests; this file pins syntax ACCESS.
 */

import { describe, it, expect } from 'vitest';
import { parseSource, walk, type Node } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { modelShapeForGrammar } from '../src/ast/grammar-model-shape';

const csharp = grammarShape('c_sharp')!;
const ruby = grammarShape('ruby')!;
const rust = grammarShape('rust')!;
const csharpModel = modelShapeForGrammar('c_sharp')!;
const rubyModel = modelShapeForGrammar('ruby')!;
const rustModel = modelShapeForGrammar('rust')!;

async function firstNode(
  src: string,
  grammar: string,
  type: string,
  where?: (n: Node) => boolean,
): Promise<Node | null> {
  const tree = await parseSource(src, grammar);
  let found: Node | null = null;
  walk(tree!.rootNode, (n) => {
    if (!found && n.type === type && (where === undefined || where(n))) found = n;
    return undefined;
  });
  return found;
}

describe('c_sharp grammar shape (hand row: callee-field calls, fused attributes)', () => {
  it('registry has rows for all three wave grammars', () => {
    expect(csharp).not.toBeNull();
    expect(ruby).not.toBeNull();
    expect(rust).not.toBeNull();
  });

  it('resolves member calls, unwrapping generic names', async () => {
    const src = `class C { void M() { client.GetFromJsonAsync<Order>("/orders"); doIt(); } }`;
    const member = await firstNode(src, 'c_sharp', 'invocation_expression', (n) =>
      n.text.startsWith('client'),
    );
    expect(csharp.resolveCall(member!)).toEqual({
      kind: 'member',
      name: 'GetFromJsonAsync',
      receiver: 'client',
    });
    const bare = await firstNode(src, 'c_sharp', 'invocation_expression', (n) => n.text === 'doIt()');
    expect(csharp.resolveCall(bare!)).toEqual({ kind: 'bare', name: 'doIt', receiver: '' });
  });

  it('unwraps argument wrappers; named arguments (name_colon) are not positional', async () => {
    const src = `class C { void M() { app.MapGet("/items/{id}", GetItem); h.Configure(name: "x", GetItem); } }`;
    const call = await firstNode(src, 'c_sharp', 'invocation_expression', (n) =>
      n.text.startsWith('app.MapGet'),
    );
    const args = csharp.positionalArgs(call!);
    expect(args).toHaveLength(2);
    expect(csharp.stringText(args[0])).toBe('"/items/{id}"');
    expect(args[1].text).toBe('GetItem');
    const named = await firstNode(src, 'c_sharp', 'invocation_expression', (n) =>
      n.text.startsWith('h.Configure'),
    );
    // The named argument is skipped; the positional one comes back.
    expect(csharp.firstArg(named!)?.text).toBe('GetItem');
    expect(csharp.optionValue(named!, 'name')?.text).toBe('"x"');
  });

  it('an attribute IS the invocation: called, marker, and qualified forms', async () => {
    const src = `class C {
      [HttpGet("{id}")] Order Get(int id) => null;
      [HttpPost] void Create() {}
      [Microsoft.AspNetCore.Mvc.Route("all")] void All() {}
    }`;
    const called = await firstNode(src, 'c_sharp', 'attribute', (n) => n.text.startsWith('HttpGet'));
    expect(csharp.decoratorCall(called!)).toBe(called);
    expect(csharp.resolveCall(called!)).toEqual({ kind: 'bare', name: 'HttpGet', receiver: '' });
    expect(csharp.stringText(csharp.firstArg(called!)!)).toBe('"{id}"');

    const marker = await firstNode(src, 'c_sharp', 'attribute', (n) => n.text === 'HttpPost');
    expect(csharp.resolveCall(marker!)).toEqual({ kind: 'bare', name: 'HttpPost', receiver: '' });
    expect(csharp.firstArg(marker!)).toBeNull();

    const qualified = await firstNode(src, 'c_sharp', 'attribute', (n) =>
      n.text.startsWith('Microsoft'),
    );
    expect(csharp.resolveCall(qualified!)?.name).toBe('Route');
  });

  it('attribute keyword arguments read via name_equals; positional ones stay positional', async () => {
    const src = `class C { [Route("all", Order = 2)] [HttpGet(Name = "n")] void M() {} }`;
    const route = await firstNode(src, 'c_sharp', 'attribute', (n) => n.text.startsWith('Route'));
    expect(csharp.stringText(csharp.firstArg(route!)!)).toBe('"all"');
    expect(csharp.optionValue(route!, 'Order')?.text).toBe('2');
    const httpGet = await firstNode(src, 'c_sharp', 'attribute', (n) => n.text.startsWith('HttpGet'));
    expect(csharp.firstArg(httpGet!)).toBeNull(); // Name = "n" is named, not positional
    expect(csharp.optionValue(httpGet!, 'Name')?.text).toBe('"n"');
  });

  it('strips $/@ string prefixes so normalization sees the quote first', async () => {
    const src = `class C { void M() { c.Get($"/orders/{id}/items"); c.Get(@"/verbatim/path"); c.Get("/plain"); } }`;
    const tree = await parseSource(src, 'c_sharp');
    const texts: string[] = [];
    walk(tree!.rootNode, (n) => {
      const t = csharp.stringText(n);
      if (t !== null) texts.push(t);
      return undefined;
    });
    expect(texts).toEqual(['"/orders/{id}/items"', '"/verbatim/path"', '"/plain"']);
  });

  it('enclosingTypeName resolves from an attribute node (the [controller] anchor)', async () => {
    const src = `[Route("api/[controller]")] public class OrdersController : ControllerBase { [HttpGet] void All() {} }`;
    const classAttr = await firstNode(src, 'c_sharp', 'attribute', (n) => n.text.startsWith('Route'));
    expect(csharp.enclosingTypeName!(classAttr!)).toBe('OrdersController');
    const methodAttr = await firstNode(src, 'c_sharp', 'attribute', (n) => n.text === 'HttpGet');
    expect(csharp.enclosingTypeName!(methodAttr!)).toBe('OrdersController');
  });
});

describe('c_sharp model shape', () => {
  it('reads properties, nullable types, attributes, and the partial marker', async () => {
    const src = `
      [Table("orders")]
      public partial class Order : EntityBase {
        public int Id { get; set; }
        [Column("user_name")] public string? UserName { get; set; }
      }`;
    const cls = await firstNode(src, 'c_sharp', 'class_declaration');
    expect(csharpModel.className(cls!)).toBe('Order');
    expect(csharpModel.heritage(cls!)).toEqual(['EntityBase']);
    expect(csharpModel.classDecorators(cls!).map((d) => d.text.split('(')[0])).toEqual(['Table']);
    expect(csharpModel.partialMarker!(cls!)).toBe(true);

    const fields = csharpModel.fieldNodes(cls!);
    expect(fields).toHaveLength(2);
    expect(csharpModel.fieldNames(fields[0])).toEqual(['Id']);
    expect(csharpModel.fieldOptionalMarker(fields[0])).toBe(false);
    expect(csharpModel.fieldNames(fields[1])).toEqual(['UserName']);
    expect(csharpModel.fieldTypeText(fields[1])).toBe('string?');
    expect(csharpModel.fieldOptionalMarker(fields[1])).toBe(true);
    expect(csharpModel.fieldDecorators(fields[1])).toHaveLength(1);
  });

  it('a record declares its components as fields; a non-partial class is not partial', async () => {
    const src = `public record UserDto(int Id, string? Email); public class Plain { }`;
    const rec = await firstNode(src, 'c_sharp', 'record_declaration');
    expect(csharpModel.className(rec!)).toBe('UserDto');
    const fields = csharpModel.fieldNodes(rec!);
    expect(fields.map((f) => csharpModel.fieldNames(f)[0])).toEqual(['Id', 'Email']);
    expect(csharpModel.fieldOptionalMarker(fields[1])).toBe(true);
    const plain = await firstNode(src, 'c_sharp', 'class_declaration');
    expect(csharpModel.partialMarker!(plain!)).toBe(false);
  });

  it('DbSet<Order> container properties expose their generic type text', async () => {
    const src = `public class Db : DbContext { public DbSet<Order> Orders { get; set; } }`;
    const cls = await firstNode(src, 'c_sharp', 'class_declaration');
    expect(csharpModel.heritage(cls!)).toEqual(['DbContext']);
    const fields = csharpModel.fieldNodes(cls!);
    expect(csharpModel.fieldTypeText(fields[0])).toBe('DbSet<Order>');
  });
});

describe('ruby grammar shape (fused-callee factory + symbol/block/pair-key extensions)', () => {
  it('resolves bare and member calls (constant and scoped receivers)', async () => {
    const src = `get '/x', to: 'c#a'\nHTTParty.get("/api/items")\nNet::HTTP.get(uri)`;
    const bare = await firstNode(src, 'ruby', 'call', (n) => n.text.startsWith("get '/x'"));
    expect(ruby.resolveCall(bare!)).toEqual({ kind: 'bare', name: 'get', receiver: '' });
    const constant = await firstNode(src, 'ruby', 'call', (n) => n.text.startsWith('HTTParty'));
    expect(ruby.resolveCall(constant!)).toEqual({
      kind: 'member',
      name: 'get',
      receiver: 'HTTParty',
    });
    const scoped = await firstNode(src, 'ruby', 'call', (n) => n.text.startsWith('Net::HTTP'));
    expect(ruby.resolveCall(scoped!)?.receiver).toBe('Net::HTTP');
  });

  it('paren-less arguments are read; pairs are keyword options, not positional', async () => {
    const src = `get '/users/:id', to: 'users#show'`;
    const call = await firstNode(src, 'ruby', 'call');
    expect(ruby.stringText(ruby.firstArg(call!)!)).toBe("'/users/:id'");
    expect(ruby.positionalArgs(call!)).toHaveLength(1);
    const to = ruby.optionValue(call!, 'to');
    expect(ruby.stringText(to!)).toBe("'users#show'");
  });

  it('the hash-rocket route idiom surfaces the pair KEY as the first argument', async () => {
    const src = `get '/health' => 'status#health'`;
    const call = await firstNode(src, 'ruby', 'call');
    expect(ruby.stringText(ruby.firstArg(call!)!)).toBe("'/health'");
  });

  it('symbols read as bare names; symbol arrays via listStrings', async () => {
    const src = `namespace :api do\nend\nmatch '/legacy', via: [:get, :post]`;
    const ns = await firstNode(src, 'ruby', 'call', (n) => n.text.startsWith('namespace'));
    expect(ruby.stringText(ruby.firstArg(ns!)!)).toBe('api');
    const match = await firstNode(src, 'ruby', 'call', (n) => n.text.startsWith('match'));
    const via = ruby.optionValue(match!, 'via');
    expect(ruby.listStrings(via!)).toEqual(['get', 'post']);
  });

  it('hasTrailingLambda answers for do-blocks and their absence', async () => {
    const src = `get '/items' do\n  "items"\nend\nget '/bare'`;
    const withBlock = await firstNode(src, 'ruby', 'call', (n) => n.text.includes('do'));
    expect(ruby.hasTrailingLambda!(withBlock!)).toBe(true);
    const bare = await firstNode(src, 'ruby', 'call', (n) => n.text === "get '/bare'");
    expect(ruby.hasTrailingLambda!(bare!)).toBe(false);
  });

  it('interpolated strings keep their verbatim text (the normalizer erases #{…})', async () => {
    const src = `conn.get("/api/items/#{id}")`;
    const call = await firstNode(src, 'ruby', 'call');
    expect(ruby.stringText(ruby.firstArg(call!)!)).toBe('"/api/items/#{id}"');
  });
});

describe('ruby model shape', () => {
  it('reads class name, heritage (constant and scoped), and attr fields', async () => {
    const src = `class User < ApplicationRecord\n  attr_accessor :nickname, :bio\nend\nclass Legacy < ActiveRecord::Base\nend`;
    const user = await firstNode(src, 'ruby', 'class', (n) => n.text.includes('User'));
    expect(rubyModel.className(user!)).toBe('User');
    expect(rubyModel.heritage(user!)).toEqual(['ApplicationRecord']);
    const fields = rubyModel.fieldNodes(user!);
    expect(fields.map((f) => rubyModel.fieldNames(f)[0])).toEqual(['nickname', 'bio']);
    expect(rubyModel.fieldTypeText(fields[0])).toBeNull();
    expect(rubyModel.fieldOptionalMarker(fields[0])).toBeNull();

    const legacy = await firstNode(src, 'ruby', 'class', (n) => n.text.includes('Legacy'));
    expect(rubyModel.heritage(legacy!)).toEqual(['ActiveRecord::Base']);
  });
});

describe('rust grammar shape (hand row: two member forms, sibling attributes)', () => {
  it('resolves bare, field-expression, and scoped-identifier callees', async () => {
    const src = `fn m() { list(); client.get("/api/items"); reqwest::get("/api/status"); }`;
    const bare = await firstNode(src, 'rust', 'call_expression', (n) => n.text === 'list()');
    expect(rust.resolveCall(bare!)).toEqual({ kind: 'bare', name: 'list', receiver: '' });
    const field = await firstNode(src, 'rust', 'call_expression', (n) =>
      n.text.startsWith('client.get'),
    );
    expect(rust.resolveCall(field!)).toEqual({ kind: 'member', name: 'get', receiver: 'client' });
    const scoped = await firstNode(src, 'rust', 'call_expression', (n) =>
      n.text.startsWith('reqwest::get'),
    );
    expect(rust.resolveCall(scoped!)).toEqual({
      kind: 'member',
      name: 'get',
      receiver: 'reqwest',
    });
  });

  it('an attribute IS the invocation: bare and scoped route attributes', async () => {
    const src = `#[get("/hello/<name>")]\nfn hello() {}\n#[actix_web::post("/orders")]\nasync fn create() {}`;
    const item = await firstNode(src, 'rust', 'attribute_item', (n) => n.text.includes('hello'));
    const inner = rust.decoratorCall(item!);
    expect(inner?.type).toBe('attribute');
    expect(rust.resolveCall(inner!)).toEqual({ kind: 'bare', name: 'get', receiver: '' });
    expect(rust.stringText(rust.firstArg(inner!)!)).toBe('"/hello/<name>"');

    const scoped = await firstNode(src, 'rust', 'attribute_item', (n) => n.text.includes('orders'));
    expect(rust.resolveCall(rust.decoratorCall(scoped!)!)?.name).toBe('post');
  });

  it('token-soup optionValue: #[serde(rename = "x")]', async () => {
    const src = `struct S { #[serde(rename = "created_at")] created: String }`;
    const attr = await firstNode(src, 'rust', 'attribute');
    expect(rust.stringText(rust.optionValue(attr!, 'rename')!)).toBe('"created_at"');
    expect(rust.optionValue(attr!, 'missing')).toBeNull();
  });

  it('raw strings strip their letter prefix; chains expose receiverNode', async () => {
    const src = `fn m() { c.get(r"/raw/path"); Router::new().route("/items", get(h)); }`;
    const raw = await firstNode(src, 'rust', 'call_expression', (n) => n.text.startsWith('c.get'));
    expect(rust.stringText(rust.firstArg(raw!)!)).toBe('"/raw/path"');
    const route = await firstNode(src, 'rust', 'call_expression', (n) =>
      n.text.startsWith('Router::new().route'),
    );
    expect(rust.receiverNode!(route!)?.text).toBe('Router::new()');
  });
});

describe('rust model shape', () => {
  it('derive expansion + serde field attributes + Option optionality', async () => {
    const src = `
#[derive(Serialize, Deserialize)]
pub struct Order {
    pub id: u64,
    #[serde(rename = "created_at")]
    pub created: Option<String>,
}`;
    const s = await firstNode(src, 'rust', 'struct_item');
    expect(rustModel.className(s!)).toBe('Order');
    // derive expands to its identifiers so decoratorName reads Serialize.
    expect(rustModel.classDecorators(s!).map((d) => d.text)).toEqual(['Serialize', 'Deserialize']);

    const fields = rustModel.fieldNodes(s!);
    expect(fields).toHaveLength(2);
    expect(rustModel.fieldNames(fields[0])).toEqual(['id']);
    expect(rustModel.fieldOptionalMarker(fields[0])).toBe(false);
    expect(rustModel.fieldNames(fields[1])).toEqual(['created']);
    expect(rustModel.fieldTypeText(fields[1])).toBe('Option<String>');
    expect(rustModel.fieldOptionalMarker(fields[1])).toBe(true);
    // The rename attribute decorates ONLY its following field.
    expect(rustModel.fieldDecorators(fields[0])).toHaveLength(0);
    expect(rustModel.fieldDecorators(fields[1])).toHaveLength(1);
  });
});
