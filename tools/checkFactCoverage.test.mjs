// Locks the fact-coverage gate against the failure it was built for: an agent
// verifier that samples, disagrees with itself between rounds, and reports stale
// audit-record citations as if they were missing prompt text. Regression targets
// are the real CC 2.1.237 managed-agents shapes.

import { describe, it, expect } from 'vitest';
import { factsOf, uncoveredFacts, reconstruct, stripFrontmatter } from './checkFactCoverage.mjs';

describe('checkFactCoverage: what counts as a fact', () => {
  it('takes a whole inline span that is nothing but an identifier or path', () => {
    const f = factsOf('call `client.beta.agents.create` against `/v1/skills/{id}`');
    expect(f.has('client.beta.agents.create')).toBe(true);
    expect(f.has('/v1/skills/{id}')).toBe(true);
  });

  it('takes object keys out of a fenced sample', () => {
    const f = factsOf('```ts\nconst x = {\n  blockMs: null,\n  reclaimOlderThanMs: 2000,\n}\n```');
    expect(f.has('blockMs')).toBe(true);
    expect(f.has('reclaimOlderThanMs')).toBe(true);
  });

  it('takes keys out of a LONG inline span, not just fences', () => {
    // The 2.1.237 miss: the poller signature is a single 240-char inline span,
    // so a fences-only key pass reported blockMs as covered when it was gone.
    const span =
      '`client.beta.environments.work.poller({environmentId, environmentKey, ' +
      'blockMs: null, reclaimOlderThanMs: 2000, drain: true, autoStop: false})`';
    const f = factsOf(span);
    expect(f.has('blockMs')).toBe(true);
    expect(f.has('reclaimOlderThanMs')).toBe(true);
  });

  it('skips sample scaffolding that is not an object key', () => {
    // `m.path` / `v.id` are loop bindings in a deleted tutorial, not API surface.
    const f = factsOf('```py\nfor m in items:\n    print(m.path, v.id)\n```');
    expect(f.has('m.path')).toBe(false);
    expect(f.has('v.id')).toBe(false);
  });

  it('takes a CLI command from running prose', () => {
    expect(factsOf('run `ant beta:memory-stores` to list them').has('ant beta:memory-stores')).toBe(
      true
    );
  });

  it('ignores running prose that names no exact identifier', () => {
    expect(factsOf('Repositories are cached, so future sessions start faster.').size).toBe(0);
  });
});

describe('checkFactCoverage: coverage is set-wide and delimiter-blind', () => {
  it('accepts a fact that moved to a sibling prompt', () => {
    // An API fact only has to reach the model once; per-file scoping produced a
    // false finding on exactly this shape.
    expect(uncoveredFacts(['`client.beta.vaults.create`'], 'other file: client.beta.vaults.create')).toEqual(
      []
    );
  });

  it('accepts a fact that survived as prose instead of as a code key', () => {
    // Demanding the original delimiter flagged `standard`/`medium`/`city` as
    // losses while all three were live.
    expect(uncoveredFacts(['```json\n{ "speed": "standard" }\n```'], 'speed defaults to standard')).toEqual(
      []
    );
  });

  it('reports a fact reachable nowhere in the set', () => {
    expect(uncoveredFacts(['`client.beta.memory_stores.memories.redact`'], 'unrelated text')).toEqual([
      'client.beta.memory_stores.memories.redact',
    ]);
  });

  it('unions facts across a multi-site prompt', () => {
    expect(
      uncoveredFacts(['`client.beta.a.create`', '`client.beta.b.create`'], 'client.beta.a.create').sort()
    ).toEqual(['client.beta.b.create']);
  });
});

describe('checkFactCoverage: body handling', () => {
  it('reconstructs a pristine body by identifiers, never by index', () => {
    expect(
      reconstruct({ pieces: ['a ', ' b'], identifiers: [7], identifierMap: { 7: 'MODEL' } })
    ).toBe('a MODEL b');
  });

  it('drops the metadata comment before reading a deployed body', () => {
    expect(stripFrontmatter('<!--\nname: x\n-->\nbody')).toBe('body');
  });
});
