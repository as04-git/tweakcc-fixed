import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeAgentToolModelString } from './agentToolModelString';

const LEGACY_ENUM_SITE =
  'G8y=Se(()=>v.object({description:v.string(),prompt:v.string(),subagent_type:v.string().optional(),model:v.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent.`),run_in_background:v.boolean().optional()}));';

// Faithful to CC 2.1.226: Zod's string and enum constructors are standalone
// factories (`$()` and `$r([...])`) rather than methods on one namespace.
const FACTORY_ENUM_SITE =
  'uYb=Ee(()=>Se({description:$().describe("A short description"),prompt:$().describe("The task"),subagent_type:$().optional().describe("The type of specialized agent to use for this task"),model:$r(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Takes precedence over the agent definition.`),run_in_background:Ut().optional()}));';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeAgentToolModelString', () => {
  it('replaces the legacy method-style enum with a free string', () => {
    const out = writeAgentToolModelString(LEGACY_ENUM_SITE);
    expect(out).not.toBeNull();
    expect(out).toContain('model:v.string().optional()');
    expect(out).not.toContain('.enum(["sonnet","opus","haiku","fable"])');
    expect(out).toContain('v.object(');
  });

  it('replaces the current standalone enum factory with the adjacent string factory', () => {
    const out = writeAgentToolModelString(FACTORY_ENUM_SITE);
    expect(out).not.toBeNull();
    expect(out).toContain('model:$().optional()');
    expect(out).not.toContain('$r(["sonnet","opus","haiku","fable"])');
  });

  it.each([LEGACY_ENUM_SITE, FACTORY_ENUM_SITE])(
    'is idempotent after patching either Zod emission style',
    source => {
      const once = writeAgentToolModelString(source)!;
      expect(writeAgentToolModelString(once)).toBe(once);
    }
  );

  it('fails loudly when the Agent model field changes to an unknown schema shape', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unknown =
      'model:futureSchema({choices:["sonnet","opus","haiku","fable"]}).describe(`Optional model override for this agent.`)';
    expect(writeAgentToolModelString(unknown)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('re-anchor for this CC version')
    );
  });

  it('does not treat an unrelated enum absence as proof that the Agent tool is open', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeAgentToolModelString('v.object({model:v.string()})')
    ).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Agent model field description not found')
    );
  });
});
