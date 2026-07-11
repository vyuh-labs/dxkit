/**
 * Model-schema config + spec bridge — the single policy reader/writer
 * (`.dxkit/policy.json:schema`, Rule 2) and the language-independent
 * spec-declared model source (OpenAPI components/definitions, JSON Schema).
 * The v1 config keys (specs/mode/blockThreshold) are a FROZEN contract —
 * renaming one breaks committed policy files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  existingSchemaMode,
  readSchemaConfig,
  writeSchemaPolicy,
  SCHEMA_CONFIG_SCHEMA_VERSION,
} from '../src/analyzers/model-schema/config';
import { loadSpecModels, modelsFromSpec } from '../src/analyzers/model-schema/spec-source';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-schema-config-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writePolicy(obj: unknown): void {
  fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.dxkit', 'policy.json'), JSON.stringify(obj));
}

describe('schema config — reader', () => {
  it('defaults to OFF with no policy (opt-in capability, fail-open)', () => {
    expect(readSchemaConfig(tmp)).toEqual({ specs: [], mode: 'off', blockThreshold: 1 });
    expect(existingSchemaMode(tmp)).toBeUndefined();
  });

  it('reads the frozen v1 keys', () => {
    writePolicy({
      schema: { specs: ['api/openapi.json'], mode: 'block', blockThreshold: 0.8 },
    });
    expect(readSchemaConfig(tmp)).toEqual({
      specs: ['api/openapi.json'],
      mode: 'block',
      blockThreshold: 0.8,
    });
    expect(existingSchemaMode(tmp)).toBe('block');
  });

  it('malformed values degrade field-wise to defaults, never throw', () => {
    writePolicy({ schema: { specs: 'nope', mode: 'loud', blockThreshold: -3 } });
    expect(readSchemaConfig(tmp)).toEqual({ specs: [], mode: 'off', blockThreshold: 1 });
    writePolicy({ schema: 42 });
    expect(readSchemaConfig(tmp).mode).toBe('off');
  });
});

describe('schema config — writer', () => {
  it('merge-writes, stamps schemaVersion, preserves sibling sections', () => {
    writePolicy({ loop: { preset: 'security-only' }, flow: { mode: 'block' } });
    expect(writeSchemaPolicy(tmp, { mode: 'warn' })).toBe(true);
    const on = JSON.parse(fs.readFileSync(path.join(tmp, '.dxkit', 'policy.json'), 'utf8'));
    expect(on.schema.mode).toBe('warn');
    expect(on.schema.schemaVersion).toBe(SCHEMA_CONFIG_SCHEMA_VERSION);
    expect(on.loop.preset).toBe('security-only');
    expect(on.flow.mode).toBe('block');
    // Idempotent: same patch again changes nothing.
    expect(writeSchemaPolicy(tmp, { mode: 'warn' })).toBe(false);
  });
});

describe('spec-declared models', () => {
  const OPENAPI3 = {
    openapi: '3.0.0',
    components: {
      schemas: {
        User: {
          type: 'object',
          required: ['id', 'email'],
          properties: {
            id: { type: 'integer' },
            email: { type: 'string' },
            nick: { type: 'string' },
            address: { $ref: '#/components/schemas/Address' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        Address: { type: 'object', properties: { city: { type: 'string' } } },
        Color: { type: 'string', enum: ['red'] }, // no properties → not field-diffable
      },
    },
  };

  it('reads OpenAPI 3.x components.schemas with required/$ref/arrays', () => {
    const models = modelsFromSpec(OPENAPI3, 'openapi.json');
    expect(models.map((m) => m.name)).toEqual(['User', 'Address']);
    const user = models[0];
    expect(user.via).toBe('spec');
    expect(user.fields).toEqual([
      { name: 'id', type: 'integer', required: true },
      { name: 'email', type: 'string', required: true },
      { name: 'nick', type: 'string', required: false },
      { name: 'address', type: 'Address', required: false },
      { name: 'tags', type: 'string[]', required: false },
    ]);
  });

  it('reads Swagger 2.0 definitions and JSON Schema $defs', () => {
    expect(
      modelsFromSpec(
        { definitions: { Pet: { properties: { name: { type: 'string' } } } } },
        's.json',
      ).map((m) => m.name),
    ).toEqual(['Pet']);
    expect(
      modelsFromSpec(
        { $defs: { Leg: { properties: { len: { type: 'number' } } } } },
        's.json',
      ).map((m) => m.name),
    ).toEqual(['Leg']);
  });

  it('reads a bare titled JSON Schema as one root model', () => {
    const models = modelsFromSpec(
      { title: 'Config', properties: { debug: { type: 'boolean' } }, required: ['debug'] },
      'config.schema.json',
    );
    expect(models).toEqual([
      {
        name: 'Config',
        via: 'spec',
        file: 'config.schema.json',
        line: 0,
        fields: [{ name: 'debug', type: 'boolean', required: true }],
      },
    ]);
  });

  it('loadSpecModels is fail-open on unreadable/non-schema files', () => {
    expect(loadSpecModels(path.join(tmp, 'missing.json'))).toEqual([]);
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, 'not json');
    expect(loadSpecModels(bad)).toEqual([]);
    const notSchema = path.join(tmp, 'plain.json');
    fs.writeFileSync(notSchema, JSON.stringify({ hello: 'world' }));
    expect(loadSpecModels(notSchema)).toEqual([]);
  });
});
