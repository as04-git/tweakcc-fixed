import { describe, it, expect } from 'vitest';
import {
  writeCustomModelCatalog,
  buildCatalogEntry,
} from './customModelCatalog';
import { CustomModelDefinition } from '../types';

// A faithful miniature of the embedded catalog's tail on CC 2.1.220: the last
// models entry closes with `advisor_rank:5}]`, then `aliases:{opus:{default:…}`.
// These are the two anchors the patch injects at, so the fixture must reproduce
// them exactly.
const makeCatalog = () =>
  'var Skl=JSON.parse(`{"schema_version":1,"pricing_tiers":{}}`),REAL={schema_version:1,models:[' +
  '{id:"claude-opus-5",family:"opus",display_name:"Opus 5",provider_ids:{first_party:"claude-opus-5"},context:{window:1e6},max_output_tokens:{default:64000,upper:128000},pricing:"tier_5_25",capabilities:["effort","max_effort","xhigh_effort"],advisor_rank:5}' +
  '],aliases:{opus:{default:"claude-opus-5"},sonnet:{default:"claude-sonnet-5"},haiku:{default:"claude-haiku-4-5"},fable:{default:"claude-fable-5"}},defaults:{}};';

const KIMI: CustomModelDefinition = {
  id: 'kimi-k3-256k',
  display_name: 'Kimi K3 256K',
  description: 'Kimi K3 256K · via gateway',
  family: 'kimi',
  context_window: 262144,
  max_output_tokens: 65536,
  effort: ['low', 'high', 'max'],
  alias: 'k3',
};

const SOL: CustomModelDefinition = {
  id: 'gpt-5.6-sol',
  display_name: 'GPT-5.6 Sol',
  family: 'gpt',
  context_window: 372000,
  max_output_tokens: 128000,
  effort: ['low', 'medium', 'high', 'xhigh'],
  default_effort: 'high',
};

describe('buildCatalogEntry', () => {
  it('emits a parseable object literal with the right shape', () => {
    const entry = buildCatalogEntry(KIMI);

    const obj = new Function(`"use strict";return (${entry});`)() as Record<
      string,
      unknown
    >;
    expect(obj.id).toBe('kimi-k3-256k');
    expect(obj.family).toBe('kimi');
    expect((obj.context as { window: number }).window).toBe(262144);
  });

  it('maps effort rungs onto catalog capabilities', () => {
    const entry = buildCatalogEntry(KIMI); // low, high, max
    expect(entry).toContain('"effort"');
    expect(entry).toContain('"max_effort"');
    expect(entry).toContain('"xhigh_effort"'); // max implies xhigh rung
  });

  it('xhigh without max still adds xhigh_effort but not max_effort', () => {
    const entry = buildCatalogEntry(SOL); // low..xhigh, no max
    expect(entry).toContain('"effort"');
    expect(entry).toContain('"xhigh_effort"');
    expect(entry).not.toContain('"max_effort"');
  });
});

describe('writeCustomModelCatalog', () => {
  it('appends to models[] and aliases{} without disturbing existing keys', () => {
    const out = writeCustomModelCatalog(makeCatalog(), [KIMI, SOL]);
    expect(out).not.toBeNull();

    // Existing aliases intact and first (we insert after `aliases:{`).
    expect(out).toContain('fable:{default:"claude-fable-5"}');
    expect(out).toContain('opus:{default:"claude-opus-5"}');

    // New entries present inside models[] (before the `],aliases` boundary).
    const modelsSection = out!.split('],aliases:')[0];
    expect(modelsSection).toContain('id:"kimi-k3-256k"');
    expect(modelsSection).toContain('id:"gpt-5.6-sol"');

    // New alias key present.
    expect(out).toContain('"k3":{default:"kimi-k3-256k"}');

    // The whole mutated catalog body still parses as JS.
    const bodyStart = out!.indexOf('REAL=') + 'REAL='.length;
    const body = out!.slice(bodyStart, out!.lastIndexOf(';'));

    const parsed = new Function(`"use strict";return (${body});`)() as {
      models: unknown[];
      aliases: Record<string, unknown>;
    };
    expect(parsed.models).toHaveLength(3);
    expect(parsed.aliases['k3']).toEqual({ default: 'kimi-k3-256k' });
  });

  it('is idempotent when all ids are already present', () => {
    const once = writeCustomModelCatalog(makeCatalog(), [KIMI])!;
    const twice = writeCustomModelCatalog(once, [KIMI]);
    expect(twice).toBe(once);
  });

  it('refuses to redefine a built-in family', () => {
    const bad: CustomModelDefinition = { ...KIMI, family: 'opus' };
    expect(writeCustomModelCatalog(makeCatalog(), [bad])).toBeNull();
  });

  it('returns the file unchanged for an empty model list', () => {
    const src = makeCatalog();
    expect(writeCustomModelCatalog(src, [])).toBe(src);
  });

  it('fails closed (null) when the models anchor is absent', () => {
    const broken = 'var x={models:[],aliases:{}};';
    expect(writeCustomModelCatalog(broken, [KIMI])).toBeNull();
  });
});
