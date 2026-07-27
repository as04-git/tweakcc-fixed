// Locks the detection-coverage gate against the miss it was built for: prompts
// assembled from several AST nodes, which the extractor's per-node gating cannot
// see as a unit. Regression target = the real 2.1.220 shapes.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  collectComposites,
  looksLikeProse,
  isDroppedByContext,
  isCaptured,
} = require('./detectionCoverage.js');

const textOf = (composites, needle) =>
  composites.find(c => c.text.includes(needle));

describe('detectionCoverage: composite collection', () => {
  it('assembles an inline array .join() — the Opus 5 shape', () => {
    const code =
      'ttp=["Do not call the AgentTool unless the user requested it",' +
      '"Do not use workflows or deep-research unless the user requested it"].join(`\\n`);';
    const hit = textOf(collectComposites(code), 'Do not call the AgentTool');
    expect(hit).toBeDefined();
    expect(hit.shape).toBe('array');
    // both fragments present as ONE unit — that is the whole point
    expect(hit.text).toContain('deep-research');
  });

  it('assembles an array joined elsewhere, not just an inline .join()', () => {
    const code =
      'var A=["## Keystroke Syntax","- `ctrl` (alias: `control`)"];f(A.join("\\n"));';
    const hit = textOf(collectComposites(code), 'Keystroke Syntax');
    expect(hit).toBeDefined();
    expect(hit.text).toContain('control');
  });

  it('assembles a "a" + "b" concatenation chain', () => {
    const code =
      'x=E.string().describe("Invokes an MCP tool via the " + "subprocess MCP client.");';
    const hit = textOf(collectComposites(code), 'Invokes an MCP tool');
    expect(hit).toBeDefined();
    expect(hit.shape).toBe('concat');
    expect(hit.text).toContain('subprocess MCP client');
  });
});

describe('detectionCoverage: prose gate', () => {
  it('accepts real instructional prose', () => {
    expect(
      looksLikeProse(
        'Do not call the AgentTool unless the user requested it. ' +
          'You should not use workflows or deep research when it is not asked for.'
      )
    ).toBe(true);
  });

  it('rejects identifier soup that is full of real words but has no grammar', () => {
    // the DTD catalogue / syntax-highlighter keyword tables that flooded v1
    expect(
      looksLikeProse(
        'array bigint bool byte char datetime decimal double single string ' +
          'switch table timespan uint ulong ushort variant version void'
      )
    ).toBe(false);
  });

  it('rejects contributor blocks', () => {
    expect(
      looksLikeProse(
        'Pierre Inglebert <pierre.inglebert@gmail.com> Jonathan Ong ' +
          '<jonathanrichardong@gmail.com> Chanon Sajjamanochai <chanon.s@gmail.com> ' +
          'and the rest of you who are listed with us in this file for it'
      )
    ).toBe(false);
  });
});

describe('detectionCoverage: drop contexts', () => {
  it('drops a thrown vendored SDK message', () => {
    expect(
      isDroppedByContext(
        'You must install the identity-broker plugin package.',
        'if(L8i===void 0)throw Error('
      )
    ).toBe(true);
  });

  it('drops TUI demo frames and shell shims', () => {
    expect(isDroppedByContext('> run tests [success:✓] done', 'x=')).toBe(true);
    expect(isDroppedByContext('#!/bin/sh\necho hi', 'x=')).toBe(true);
  });

  it('does NOT drop a normal prompt assignment', () => {
    expect(
      isDroppedByContext('Do not call the AgentTool unless asked.', 'ttp=')
    ).toBe(false);
  });
});

describe('detectionCoverage: capture test', () => {
  const corpus =
    ' Wait for MCP servers that are still connecting and whose tools are not yet in your tool list. ';

  it('sees a prompt that IS in the corpus', () => {
    expect(
      isCaptured(
        corpus,
        'Wait for MCP servers that are still connecting and whose tools are not yet in your tool list.'
      )
    ).toBe(true);
  });

  it('flags a prompt that is absent', () => {
    expect(
      isCaptured(
        corpus,
        'Do not call the AgentTool unless the user requested it, ever.'
      )
    ).toBe(false);
  });

  it('tolerates piece-splitting at interpolation boundaries', () => {
    // extractor stores pieces split at ${...}; a probe must survive that
    expect(
      isCaptured(
        corpus,
        '${PREFIX}Wait for MCP servers that are still connecting and whose tools are not yet in your tool list.'
      )
    ).toBe(true);
  });
});
