import { describe, it, expect } from 'vitest';
import { writeCustomModelPicker } from './customModelPicker';
import { CustomModelDefinition } from '../types';

// Faithful to CC 2.1.220's picker assembly: a function declaring the list var,
// then the availableModels loop ending in the "Custom model" push.
const PICKER_SITE =
  'function Tk(){let e=HWi();let t=[];t.push({value:null,label:"Default",description:"x"});' +
  'for(let c of $1e()){t.push({value:c,label:c,description:"Custom model"});continue}return dit(t)}';

const K3: CustomModelDefinition = {
  id: 'kimi-k3',
  display_name: 'Kimi K3',
  description: 'Kimi K3 · 1M context',
  family: 'kimi',
  context_window: 1048576,
};

const SOL: CustomModelDefinition = {
  id: 'gpt-5.6-sol',
  display_name: 'GPT-5.6 Sol',
  family: 'gpt',
  context_window: 372000,
};

describe('writeCustomModelPicker', () => {
  it('pushes picker entries for each custom model', () => {
    const out = writeCustomModelPicker(PICKER_SITE, [K3, SOL]);
    expect(out).not.toBeNull();
    expect(out).toContain(
      't.push({"value":"kimi-k3","label":"Kimi K3","description":"Kimi K3 · 1M context"});'
    );
    expect(out).toContain(
      't.push({"value":"gpt-5.6-sol","label":"GPT-5.6 Sol","description":"GPT-5.6 Sol"});'
    );
    // Original entries intact
    expect(out).toContain('description:"Custom model"');
  });

  it('is idempotent', () => {
    const once = writeCustomModelPicker(PICKER_SITE, [K3])!;
    expect(writeCustomModelPicker(once, [K3])).toBe(once);
  });

  it('returns file unchanged for empty model list', () => {
    expect(writeCustomModelPicker(PICKER_SITE, [])).toBe(PICKER_SITE);
  });

  it('fails closed (null) when the push site is absent', () => {
    expect(writeCustomModelPicker('function other(){}', [K3])).toBeNull();
  });
});
