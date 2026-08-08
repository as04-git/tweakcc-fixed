import { describe, it, expect } from 'vitest';
import { writeAgentToolModelString } from './agentToolModelString';

const ENUM_SITE =
  'G8y=Se(()=>v.object({description:v.string(),prompt:v.string(),subagent_type:v.string().optional(),model:v.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent.`),run_in_background:v.boolean().optional()}));';

describe('writeAgentToolModelString', () => {
  it('replaces the enum with a free string', () => {
    const out = writeAgentToolModelString(ENUM_SITE);
    expect(out).not.toBeNull();
    expect(out).toContain('model:v.string().optional()');
    expect(out).not.toContain('.enum(["sonnet","opus","haiku","fable"])');
    // The Zod builder var is preserved (minified name captured).
    expect(out).toContain('v.object(');
  });

  it('is idempotent once the enum is gone', () => {
    const once = writeAgentToolModelString(ENUM_SITE)!;
    expect(writeAgentToolModelString(once)).toBe(once);
  });

  it('no-ops (returns input) when no enum is present anywhere', () => {
    const src = 'v.object({model:v.string().optional()})';
    expect(writeAgentToolModelString(src)).toBe(src);
  });
});
