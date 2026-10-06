import { agentTemplates, templateSchema, validateTemplatePaths } from '@winsendotai/ovo-behaviors';
import type { CompatRule } from './types.ts';
import { issue } from './types.ts';

/**
 * An agent line may only read variables its schema declares, or a built-in date. A spoken line that
 * names anything else would fail on every call, so it blocks the release; the briefing is rendered
 * leniently and left as written, so there it is only a warning.
 */
export const templateVariableUndeclared: CompatRule = (input, stage) => {
  const schema = templateSchema(input.config);
  return agentTemplates(input.config).flatMap((entry) => {
    try {
      validateTemplatePaths(entry.template, schema);
      return [];
    } catch (error) {
      return [
        issue(
          'template_variable_undeclared',
          stage,
          `${entry.field}: ${error instanceof Error ? error.message : String(error)}`,
          { field: entry.field },
          entry.spoken ? 'error' : 'warning',
        ),
      ];
    }
  });
};
