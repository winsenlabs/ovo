import {
  AGENT_BUILTIN_VARIABLES,
  type AgentBuiltinVariable,
  type AgentConfig,
  type JsonSchema,
} from '@winsendotai/ovo-contracts';
import {
  AnnouncementValidationError,
  formatTemplateValue,
  renderAnnouncementTemplate,
  validateTemplatePaths,
} from './announcement.ts';

const PLACEHOLDER = /{{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*}}/g;
const BUILTIN_SCHEMA: Record<string, JsonSchema> = Object.fromEntries(
  AGENT_BUILTIN_VARIABLES.map((name) => [name, { type: 'string', format: 'date' }]),
);

/** Where an authored agent template lives, for the release check and the clip inventory. */
export interface AgentTemplate {
  field: string;
  template: string;
  /** Spoken lines must render completely; the briefing is prose the LLM reads. */
  spoken: boolean;
}

/**
 * Per-call variables as an agent sees them: the declared variables of this call, plus today's date
 * and two relative dates in the agent's timezone. A declared variable shadows a built-in.
 */
export class AgentVariables {
  readonly schema: JsonSchema;

  constructor(
    private readonly config: AgentConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.schema = templateSchema(config);
    for (const entry of agentTemplates(config))
      if (entry.spoken) validateTemplatePaths(entry.template, this.schema);
  }

  /** A spoken line. A declared variable this call does not carry fails the line, never reads "{{". */
  render(template: string, variables: Readonly<Record<string, unknown>>): string {
    return renderAnnouncementTemplate(template, this.values(variables), this.schema, this.config);
  }

  /**
   * The briefing, rendered per call. Lenient where a spoken line is strict: an undeclared or absent
   * path is left for the LLM to read as written, so a briefing that predates templating still works.
   */
  renderBriefing(text: string, variables: Readonly<Record<string, unknown>>): string {
    const values = this.values(variables);
    return text.replace(PLACEHOLDER, (placeholder, path: string) => {
      try {
        return renderAnnouncementTemplate(`{{${path}}}`, values, this.schema, this.config);
      } catch (error) {
        if (error instanceof AnnouncementValidationError) return placeholder;
        throw error;
      }
    });
  }

  /**
   * The "Call facts" section for the LLM: each declared variable this call carries, formatted as
   * it would be spoken, and today's date. Empty for an agent that declares no variables, so its
   * prompt is exactly what it was before variables existed.
   */
  facts(variables: Readonly<Record<string, unknown>>): string {
    const declared = declaredProperties(this.config);
    if (!Object.keys(declared).length) return '';
    const lines: string[] = [];
    for (const [key, schema] of Object.entries(declared)) {
      const value = Object.hasOwn(variables, key) ? variables[key] : undefined;
      if (value === undefined || value === null) continue;
      lines.push(`- ${key}: ${describe(value, schema, this.config)}`);
    }
    lines.push(`- today: ${this.today()}`);
    return [
      'Call facts (from the call record; these are the only account facts you may state):',
      ...lines,
    ].join('\n');
  }

  /** Today in the agent's locale and timezone, weekday included, for the decision state. */
  today(): string {
    return new Intl.DateTimeFormat(this.config.locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: this.config.timezone,
    }).format(this.now());
  }

  private values(variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return { ...builtinVariables(this.now(), this.config.timezone), ...variables };
  }
}

/** ISO dates for the built-ins, computed in `timezone` so "today" is the caller's today. */
export function builtinVariables(
  now: Date,
  timezone: string,
): Record<AgentBuiltinVariable, string> {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const plus = (days: number) =>
    new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  return { today, date_tomorrow: plus(1), date_week: plus(7) };
}

/** The declared variable schema with the built-ins it does not shadow. */
export function templateSchema(config: AgentConfig): JsonSchema {
  return { ...config.variables, properties: { ...BUILTIN_SCHEMA, ...declaredProperties(config) } };
}

/** Every template an agent authors: opening, voicemail message, decision lines and the briefing. */
export function agentTemplates(config: AgentConfig): AgentTemplate[] {
  if (config.mode !== 'agent') return [];
  const found: AgentTemplate[] = [];
  const spoken = (field: string, template: string | undefined) => {
    if (template !== undefined) found.push({ field, template, spoken: true });
  };
  config.opening?.lines.forEach((line, index) => spoken(`opening.lines.${index}`, line));
  spoken('voicemail.message', config.voicemail?.message);
  config.decision?.questions.forEach((question, index) => {
    const at = `decision.questions.${index}`;
    if (question.type === 'choice')
      question.options.forEach((option, optionIndex) =>
        spoken(`${at}.options.${optionIndex}.outcome.say`, option.outcome.say),
      );
    else if (question.type === 'noul') {
      spoken(`${at}.yes.outcome.say`, question.yes.outcome.say);
      spoken(`${at}.no.outcome.say`, question.no.outcome.say);
    } else
      question.bands.forEach((band, bandIndex) =>
        spoken(`${at}.bands.${bandIndex}.outcome.say`, band.outcome.say),
      );
  });
  if (config.context) found.push({ field: 'context', template: config.context, spoken: false });
  return found;
}

/** Spoken lines with no placeholder: identical on every call, so they can be rendered once. */
export function staticAgentLines(config: AgentConfig): AgentTemplate[] {
  return agentTemplates(config).filter((entry) => entry.spoken && !/{{|}}/.test(entry.template));
}

function declaredProperties(config: AgentConfig): Record<string, JsonSchema> {
  const properties = config.variables.properties;
  return typeof properties === 'object' && properties !== null
    ? (properties as Record<string, JsonSchema>)
    : {};
}

function describe(
  value: unknown,
  schema: JsonSchema,
  options: { locale: string; timezone: string },
): string {
  if (typeof value === 'object') return JSON.stringify(value);
  try {
    return formatTemplateValue(value, schema, options);
  } catch {
    // swallow-ok: a value its schema cannot format is still a fact; the LLM reads it as given.
    return String(value);
  }
}
