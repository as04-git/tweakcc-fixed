import { CustomModelDefinition } from './types';

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function invalid(path: string, requirement: string): never {
  throw new Error(`Invalid settings.customModels: ${path} ${requirement}`);
}

function requireNonEmptyString(
  value: unknown,
  path: string
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(path, 'must be a non-empty string');
  }
}

function requirePositiveInteger(
  value: unknown,
  path: string
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    invalid(path, 'must be a positive safe integer');
  }
}

/**
 * Validate the runtime shape of settings.customModels.
 *
 * Config files are JSON, so their TypeScript annotation provides no runtime
 * protection. The same settings can also arrive through --config-url or the
 * programmatic API. Validate before any patch builds JavaScript from these
 * values, and before applyCustomization restores or rewrites an installation.
 */
export const validateCustomModelDefinitions = (
  value: unknown
): CustomModelDefinition[] => {
  if (!Array.isArray(value)) {
    invalid('itself', 'must be an array');
  }
  const models = value as unknown[];

  const ids = new Set<string>();
  const aliases = new Set<string>();

  models.forEach((candidate, index) => {
    const base = `[${index}]`;
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      invalid(base, 'must be an object');
    }

    const model = candidate as Record<string, unknown>;
    const id = model.id;
    const displayName = model.display_name;
    const family = model.family;
    const contextWindow = model.context_window;
    requireNonEmptyString(id, `${base}.id`);
    requireNonEmptyString(displayName, `${base}.display_name`);
    requireNonEmptyString(family, `${base}.family`);
    requirePositiveInteger(contextWindow, `${base}.context_window`);

    const normalizedId = id.trim().toLowerCase();
    if (ids.has(normalizedId)) {
      invalid(`${base}.id`, `duplicates model id "${id}"`);
    }
    ids.add(normalizedId);

    const description = model.description;
    if (description !== undefined) {
      requireNonEmptyString(description, `${base}.description`);
    }
    const maxOutputTokens = model.max_output_tokens;
    if (maxOutputTokens !== undefined) {
      requirePositiveInteger(maxOutputTokens, `${base}.max_output_tokens`);
    }

    const effort = model.effort;
    if (effort !== undefined) {
      if (!Array.isArray(effort)) {
        invalid(`${base}.effort`, 'must be an array');
      }
      for (const [effortIndex, rung] of effort.entries()) {
        if (typeof rung !== 'string' || !VALID_EFFORTS.has(rung)) {
          invalid(
            `${base}.effort[${effortIndex}]`,
            'must be one of low, medium, high, xhigh, max'
          );
        }
      }
    }

    const defaultEffort = model.default_effort;
    if (
      defaultEffort !== undefined &&
      (typeof defaultEffort !== 'string' || !VALID_EFFORTS.has(defaultEffort))
    ) {
      invalid(
        `${base}.default_effort`,
        'must be one of low, medium, high, xhigh, max'
      );
    }
    if (
      defaultEffort !== undefined &&
      (!Array.isArray(effort) || !effort.includes(defaultEffort))
    ) {
      invalid(`${base}.default_effort`, 'must also appear in effort');
    }

    const capabilities = model.capabilities;
    if (capabilities !== undefined) {
      if (
        !Array.isArray(capabilities) ||
        capabilities.some(
          capability =>
            typeof capability !== 'string' || capability.trim().length === 0
        )
      ) {
        invalid(`${base}.capabilities`, 'must contain only non-empty strings');
      }
    }

    const alias = model.alias;
    if (alias !== undefined) {
      requireNonEmptyString(alias, `${base}.alias`);
      const normalizedAlias = alias.trim().toLowerCase();
      if (aliases.has(normalizedAlias)) {
        invalid(`${base}.alias`, `duplicates alias "${alias}"`);
      }
      aliases.add(normalizedAlias);
    }
  });

  for (const [index, candidate] of models.entries()) {
    const model = candidate as CustomModelDefinition;
    const alias = model.alias?.trim().toLowerCase();
    if (alias && ids.has(alias)) {
      invalid(
        `[${index}].alias`,
        `collides with custom model id "${model.alias}"`
      );
    }
  }

  return models as CustomModelDefinition[];
};
