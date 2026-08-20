// Locks the block scoping that keeps a word-shingle from spanning a structural
// boundary. Regression targets are the real CC 2.1.237 managed-agents shapes,
// where trimming one paragraph put two surviving paragraphs next to each other
// and the staleness gate read the new adjacency as re-injected text.

import { describe, it, expect } from 'vitest';
import { blocksOf } from './markdownBlocks.mjs';

describe('markdownBlocks: what separates two blocks', () => {
  it('splits on a blank line', () => {
    expect(blocksOf('start faster.\n\nRepositories are attached.')).toEqual([
      'start faster.',
      'Repositories are attached.',
    ]);
  });

  it('splits consecutive list items', () => {
    // data-managed-agents-client-patterns: two adjacent bullets with no blank
    // line between them, whose juxtaposition last existed at 2.1.235.
    const b = blocksOf('- `requires_action` — handle it.\n- `retries_exhausted` — terminal failure.');
    expect(b).toHaveLength(2);
  });

  it('splits on a heading, a blockquote, a table row and an ordered item', () => {
    expect(blocksOf('tools silently fail.\n### Creating an environment')).toHaveLength(2);
    expect(blocksOf('create pull requests\n> To generate PRs you need MCP.')).toHaveLength(2);
    expect(blocksOf('| a | b |\n| c | d |')).toHaveLength(2);
    expect(blocksOf('intro\n1. first step')).toHaveLength(2);
  });
});

describe('markdownBlocks: what does NOT separate two blocks', () => {
  it('keeps a hard-wrapped sentence in one block', () => {
    // Override bodies wrap prose mid-sentence; splitting every newline would
    // shatter the passages this gate exists to catch.
    expect(blocksOf('one orchestrated moment lands harder\nthan scattered effects')).toEqual([
      'one orchestrated moment lands harder\nthan scattered effects',
    ]);
  });

  it('keeps a continuation line that merely starts with a word', () => {
    expect(blocksOf('first line\nsecond line\nthird line')).toHaveLength(1);
  });

  it('drops whitespace-only blocks', () => {
    expect(blocksOf('a\n\n   \n\nb')).toEqual(['a', 'b']);
  });

  it('returns nothing for empty input', () => {
    expect(blocksOf('')).toEqual([]);
    expect(blocksOf(null)).toEqual([]);
  });
});
