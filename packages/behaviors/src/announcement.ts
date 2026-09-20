import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Behavior,
  type JsonSchema,
} from '@winsendotai/ovo-contracts';
import { addIsoFormats } from './schema-formats.ts';

const PLACEHOLDER = /{{\s*([^{}]+?)\s*}}/g;
const SAFE_PATH = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const FORBIDDEN_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

export class AnnouncementValidationError extends Error {
  constructor(
    message: string,
    readonly validationErrors: readonly ErrorObject[] = [],
  ) {
    super(message);
    this.name = 'AnnouncementValidationError';
  }
}

export class AnnouncementBehavior implements Behavior {
  readonly config: AgentConfig;
  private readonly validate: ValidateFunction;

  constructor(config: AgentConfig) {
    this.config = AgentConfigSchema.parse(config);
    if (this.config.mode !== 'announcement') {
      throw new TypeError(
        `Announcement behavior requires announcement mode, received ${this.config.mode}`,
      );
    }
    const ajv = new Ajv({ allErrors: true, strict: false });
    addIsoFormats(ajv);
    this.validate = ajv.compile(this.config.variables);
    validateTemplatePaths(this.config.message, this.config.variables);
  }

  async respond(_input: string, variables: Record<string, unknown> = {}): Promise<string> {
    return this.render(variables);
  }

  render(variables: Record<string, unknown>): string {
    if (!this.validate(variables)) {
      throw new AnnouncementValidationError(
        `Announcement variables failed schema validation: ${formatAjvErrors(this.validate.errors)}`,
        this.validate.errors ?? [],
      );
    }
    return renderAnnouncementTemplate(this.config.message, variables, this.config.variables, {
      locale: this.config.locale,
      timezone: this.config.timezone,
    });
  }
}

export function createAnnouncementBehavior(config: AgentConfig): AnnouncementBehavior {
  return new AnnouncementBehavior(config);
}

export function renderAnnouncementTemplate(
  template: string,
  variables: Record<string, unknown>,
  schema: JsonSchema,
  options: { locale: string; timezone: string },
): string {
  const rendered = template.replace(PLACEHOLDER, (_placeholder, rawPath: string) => {
    const path = rawPath.trim();
    assertSafePath(path);
    const value = readOwnPath(variables, path);
    if (value === undefined || value === null) {
      throw new AnnouncementValidationError(`Missing announcement variable: ${path}`);
    }
    const valueSchema = schemaAtPath(schema, path);
    return formatValue(value, valueSchema, options);
  });
  if (rendered.includes('{{') || rendered.includes('}}')) {
    throw new AnnouncementValidationError(
      'Announcement template contains an unsupported expression',
    );
  }
  return rendered;
}

export function validateTemplatePaths(template: string, schema: JsonSchema): string[] {
  const paths: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const path = match[1].trim();
    assertSafePath(path);
    if (!schemaAtPath(schema, path)) {
      throw new AnnouncementValidationError(
        `Template path is not declared by the variable schema: ${path}`,
      );
    }
    paths.push(path);
  }
  if (
    template.replace(PLACEHOLDER, '').includes('{{') ||
    template.replace(PLACEHOLDER, '').includes('}}')
  ) {
    throw new AnnouncementValidationError(
      'Announcement template contains an unsupported expression',
    );
  }
  return paths;
}

function assertSafePath(path: string): void {
  const parts = path.split('.');
  if (!SAFE_PATH.test(path) || parts.some((part) => FORBIDDEN_PATH_PARTS.has(part))) {
    throw new AnnouncementValidationError(`Unsafe announcement template path: ${path}`);
  }
}

function readOwnPath(root: Record<string, unknown>, path: string): unknown {
  let value: unknown = root;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function schemaAtPath(root: JsonSchema, path: string): JsonSchema | undefined {
  let schema: unknown = root;
  for (const part of path.split('.')) {
    if (typeof schema !== 'object' || schema === null) return undefined;
    const properties = (schema as Record<string, unknown>).properties;
    if (typeof properties !== 'object' || properties === null || !Object.hasOwn(properties, part))
      return undefined;
    schema = (properties as Record<string, unknown>)[part];
  }
  return typeof schema === 'object' && schema !== null ? (schema as JsonSchema) : undefined;
}

function formatValue(
  value: unknown,
  schema: JsonSchema | undefined,
  options: { locale: string; timezone: string },
): string {
  const format = schema?.format;
  const ovoFormat = schema?.['x-ovo-format'];
  if (ovoFormat === 'currency') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AnnouncementValidationError('Currency variables must be finite numbers');
    }
    const currency = schema?.['x-ovo-currency'];
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new AnnouncementValidationError(
        'Currency variables require x-ovo-currency as an ISO 4217 code',
      );
    }
    return new Intl.NumberFormat(options.locale, { style: 'currency', currency }).format(value);
  }
  if (format === 'date') return formatDateOnly(value, options.locale);
  if (format === 'date-time') return formatDateTime(value, options.locale, options.timezone);
  if (format === 'time') return formatTime(value, options.locale, options.timezone);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  throw new AnnouncementValidationError(
    'Announcement template variables must render to a scalar value',
  );
}

function formatDateOnly(value: unknown, locale: string): string {
  if (typeof value !== 'string')
    throw new AnnouncementValidationError('Date variables must be ISO date strings');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new AnnouncementValidationError(`Invalid ISO date: ${value}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new AnnouncementValidationError(`Invalid ISO date: ${value}`);
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

function formatDateTime(value: unknown, locale: string, timezone: string): string {
  const date = parseDate(value, 'date-time');
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(date);
}

function formatTime(value: unknown, locale: string, timezone: string): string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    throw new AnnouncementValidationError(
      'Time variables must use HH:mm, HH:mm:ss, or include an offset',
    );
  }
  const withDate = /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? `1970-01-01T${value}`
    : `1970-01-01T${value}Z`;
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: timezone }).format(
    parseDate(withDate, 'time'),
  );
}

function parseDate(value: unknown, kind: string): Date {
  if (typeof value !== 'string')
    throw new AnnouncementValidationError(`${kind} variables must be ISO strings`);
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()))
    throw new AnnouncementValidationError(`Invalid ISO ${kind}: ${value}`);
  return date;
}

function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'unknown validation error';
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}
