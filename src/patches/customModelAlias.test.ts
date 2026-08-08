import { describe, it, expect } from 'vitest';
import { writeCustomModelAlias } from './customModelAlias';
import { CustomModelDefinition } from '../types';

// Faithful to CC 2.1.220's vi(): trim -> lowercase -> [1m]-strip -> RI switch.
const VI =
  'function vi(e){let t=e.trim(),r=t.toLowerCase(),n=Wb(r),o=n?Qs(r).trim():r;' +
  'if(RI(o))switch(o){case"fable":return yL("fable");case"opus":return yL(EE());' +
  'case"best":return sRc();default:}if(n)return yL(t+"[1m]");return yL(t)}';

const MODELS: CustomModelDefinition[] = [
  {
    id: 'kimi-k3',
    display_name: 'Kimi K3',
    family: 'kimi',
    context_window: 1048576,
    alias: 'k3',
  },
  {
    id: 'gpt-5.6-sol',
    display_name: 'GPT-5.6 Sol',
    family: 'gpt',
    context_window: 372000,
    alias: 'sol',
  },
  {
    id: 'kimi-k3-256k',
    display_name: 'Kimi K3 256K',
    family: 'kimi',
    context_window: 262144,
  },
];

describe('writeCustomModelAlias', () => {
  it('injects an alias map ahead of the built-in switch', () => {
    const out = writeCustomModelAlias(VI, MODELS);
    expect(out).not.toBeNull();
    expect(out).toContain('"k3":"kimi-k3"');
    expect(out).toContain('"sol":"gpt-5.6-sol"');
    // alias lookup sits between the `o` declaration and the RI switch
    const mapIdx = out!.indexOf('let am=');
    const switchIdx = out!.indexOf('if(RI(o))switch(o){');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(mapIdx);
    expect(() => new Function('"use strict";' + out!)).not.toThrow();
  });

  it('makes the resolver actually resolve (functional check)', () => {
    const out = writeCustomModelAlias(VI, MODELS)!;
    const vi = new Function(
      '"use strict";const Wb=()=>false,Qs=s=>s,RI=()=>false,yL=s=>s,EE=()=>"opus-id",sRc=()=>"best-id";' +
        `return (${out.slice(out.indexOf('function vi'))});`
    )() as (s: string) => string;
    expect(vi('k3')).toBe('kimi-k3');
    expect(vi('K3')).toBe('kimi-k3'); // case-insensitive via lowercased local
    expect(vi('sol')).toBe('gpt-5.6-sol');
    expect(vi('sonnet')).toBe('sonnet'); // unknown ids pass through
  });

  it('is idempotent', () => {
    const once = writeCustomModelAlias(VI, MODELS)!;
    expect(writeCustomModelAlias(once, MODELS)).toBe(once);
  });

  it('refuses a changed alias map on an already-injected file', () => {
    const once = writeCustomModelAlias(VI, MODELS)!;
    const changed = MODELS.map(m =>
      m.alias === 'sol' ? { ...m, alias: 'sol2' } : m
    );
    expect(writeCustomModelAlias(once, changed)).toBeNull();
  });

  it('refuses aliases that shadow built-in resolver words', () => {
    const bad = [{ ...MODELS[0], alias: 'opus' }];
    expect(writeCustomModelAlias(VI, bad)).toBeNull();
  });

  it('refuses duplicate aliases and id collisions', () => {
    const dup = [
      { ...MODELS[0], alias: 'x' },
      { ...MODELS[1], alias: 'x' },
    ];
    expect(writeCustomModelAlias(VI, dup)).toBeNull();
    const clash = MODELS.map(m =>
      m.id === 'kimi-k3' ? { ...m, alias: 'kimi-k3-256k' } : m
    );
    expect(writeCustomModelAlias(VI, clash)).toBeNull();
  });

  it('no-ops when no aliases are configured', () => {
    const bare = MODELS.map(m => ({ ...m, alias: undefined }));
    expect(writeCustomModelAlias(VI, bare)).toBe(VI);
  });

  it('fails loudly when the resolver shape is gone', () => {
    expect(writeCustomModelAlias('function other(){}', MODELS)).toBeNull();
  });
});
