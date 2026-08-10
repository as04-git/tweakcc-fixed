// Locks the trim-slot gate against the miss it was built for: a trim that
// deletes the last occurrence of a runtime interpolation, which applies clean,
// parses, smokes green, and leaves the model with no value where one belongs.
// Regression targets are the real CC 2.1.226 shapes.

import { describe, it, expect } from 'vitest';
import {
  normalizeToken,
  tokensOf,
  reconstruct,
  stripFrontmatter,
  lostTokens,
} from './checkTrimSlots.mjs';

describe('checkTrimSlots: token identity', () => {
  it('takes the opening identifier of a nested interpolation', () => {
    // the naive match truncates at the first inner `}`, so the raw token text
    // is not a stable key — this is the system-prompt-worker-agent shape
    expect(normalizeToken('${AGENT_TOOL_NAME()>1?`- If you have ${OTHER}')).toBe(
      'AGENT_TOOL_NAME'
    );
  });

  it('keeps a property path, because the slot binds through it', () => {
    expect(normalizeToken('${ATTACHMENT_OBJECT.remaining}')).toBe('ATTACHMENT_OBJECT.remaining');
  });

  it('reads the {{TEMPLATE}} form CC fills from the model catalogue', () => {
    expect(normalizeToken('{{OPUS_ID}}')).toBe('OPUS_ID');
  });

  it('drops the degenerate forms reconstruction can emit', () => {
    // `${}` and `${""}` name nothing; counting them is pure noise
    expect(normalizeToken('${}')).toBeNull();
    expect(normalizeToken('${""}')).toBeNull();
  });
});

describe('checkTrimSlots: lost tokens', () => {
  const pristine =
    '${DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_0.length} browsers are connected. ' +
    '${DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_1(DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_2.askUserToolName)}';

  it('flags the 2.1.226 browser-disambiguation cut', () => {
    const trimmed = '${DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_0.length} browsers are connected.';
    expect(lostTokens([pristine], trimmed)).toEqual([
      'DATA_MULTIPLE_BROWSERS_CONNECTED_TOOL_RESULT_VAR_1',
    ]);
  });

  it('says nothing when every token still has a home', () => {
    expect(lostTokens([pristine], pristine)).toEqual([]);
  });

  it('does not flag a token that survives elsewhere in the body', () => {
    // deleting one code example that happens to carry {{OPUS_ID}} is fine as
    // long as another occurrence remains — that distinction is the whole
    // reason the rule is "zero remaining", not "the sets must match"
    const p = 'call with {{OPUS_ID}}\n\n```py\nmodel="{{OPUS_ID}}"\n```';
    expect(lostTokens([p], 'call with {{OPUS_ID}}')).toEqual([]);
  });

  it('unions the slots of every site of a same-id multi-site prompt', () => {
    // a first-entry-only comparison is how stubs have been misclassified before
    const a = 'one ${ALPHA}';
    const b = 'two ${BETA}';
    expect(lostTokens([a, b], 'one ${ALPHA}').sort()).toEqual(['BETA']);
  });

  it('reports a suppression as losing every token it carried', () => {
    expect(lostTokens([pristine], '')).toHaveLength(2);
  });
});

describe('checkTrimSlots: body handling', () => {
  it('reconstructs with the bare label and the identifiers[i] key', () => {
    const p = {
      pieces: ['a ${', '} b'],
      identifiers: [3],
      identifierMap: { 3: 'NAME' },
    };
    // the `${` and `}` are already in the pieces; appending `${NAME}` here
    // would double them, and keying on i instead of identifiers[i] binds the
    // wrong slot
    expect(reconstruct(p)).toBe('a ${NAME} b');
  });

  it('strips the override front-matter comment', () => {
    expect(stripFrontmatter('<!--\nname: x\n-->\nbody ${A}')).toBe('body ${A}');
  });

  it('leaves a body that has no front-matter alone', () => {
    expect(stripFrontmatter('body ${A}')).toBe('body ${A}');
  });

  it('finds tokens through the front-matter strip', () => {
    expect([...tokensOf(stripFrontmatter('<!--\nx: 1\n-->\nhi ${A} and {{B}}'))].sort()).toEqual([
      'A',
      'B',
    ]);
  });
});
