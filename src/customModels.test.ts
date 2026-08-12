import { describe, expect, it } from 'vitest';
import { validateCustomModelDefinitions } from './customModels';

const VALID = {
  id: 'gpt-5.6-luna',
  display_name: 'GPT-5.6 Luna',
  family: 'gpt',
  context_window: 372000,
  max_output_tokens: 128000,
  effort: ['low', 'medium', 'high', 'xhigh'],
  default_effort: 'high',
  alias: 'luna',
};

describe('validateCustomModelDefinitions', () => {
  it('accepts a valid custom model list unchanged', () => {
    const models = [VALID];
    expect(validateCustomModelDefinitions(models)).toBe(models);
  });

  it('rejects a non-array config before patch conditions read .length/.map', () => {
    expect(() => validateCustomModelDefinitions('gpt-5.6-luna')).toThrow(
      'settings.customModels: itself must be an array'
    );
  });

  it.each([
    [{ ...VALID, id: '' }, '[0].id must be a non-empty string'],
    [
      { ...VALID, context_window: '372000' },
      '[0].context_window must be a positive safe integer',
    ],
    [
      { ...VALID, max_output_tokens: Number.POSITIVE_INFINITY },
      '[0].max_output_tokens must be a positive safe integer',
    ],
    [
      { ...VALID, effort: ['high', 'ultracode'] },
      '[0].effort[1] must be one of',
    ],
    [
      { ...VALID, effort: ['low'], default_effort: 'high' },
      '[0].default_effort must also appear in effort',
    ],
  ])('rejects malformed model fields: %s', (model, message) => {
    expect(() => validateCustomModelDefinitions([model])).toThrow(message);
  });

  it('rejects duplicate ids and alias-to-id collisions case-insensitively', () => {
    expect(() =>
      validateCustomModelDefinitions([
        VALID,
        { ...VALID, id: 'GPT-5.6-LUNA', alias: 'other' },
      ])
    ).toThrow('duplicates model id');

    expect(() =>
      validateCustomModelDefinitions([
        VALID,
        { ...VALID, id: 'gpt-5.6-sol', alias: 'GPT-5.6-LUNA' },
      ])
    ).toThrow('collides with custom model id');
  });
});
