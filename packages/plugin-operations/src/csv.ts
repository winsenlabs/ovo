import type { CampaignContactInput } from './types.ts';

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_ROWS = 100;
const FORMULA_PREFIX = /^[\u0000-\u0020]*[=+\-@]/;

export interface CampaignCsvMapping {
  phone: string;
  externalId?: string;
  variables?: Record<string, string>;
}

export interface CampaignCsvPreview {
  headers: string[];
  rows: CampaignContactInput[];
  errors: Array<{ row: number; field: string; message: string }>;
  truncated: boolean;
  exportSafe: true;
}

export function normalizePhoneNumber(value: string): string {
  const normalized = value.trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) throw new Error('must be an E.164 phone number');
  return normalized;
}

function parseCsv(input: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  if (Buffer.byteLength(input, 'utf8') > MAX_CSV_BYTES) throw new Error('CSV exceeds 2 MiB');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  for (let index = 0; index <= input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else if (char === undefined) throw new Error('CSV has an unterminated quoted field');
      else cell += char;
      continue;
    }
    if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === undefined) {
      if (char === '\n' && cell.endsWith('\r')) cell = cell.slice(0, -1);
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = '';
      if (rows.length > maxRows) {
        truncated = true;
        break;
      }
    } else cell += char;
  }
  return { rows: rows.slice(0, maxRows), truncated };
}

function validateMapping(headers: string[], mapping: CampaignCsvMapping): void {
  if (new Set(headers).size !== headers.length) throw new Error('CSV headers must be unique');
  const columns = [
    mapping.phone,
    mapping.externalId,
    ...Object.values(mapping.variables ?? {}),
  ].filter((value): value is string => Boolean(value));
  for (const column of columns)
    if (!headers.includes(column)) throw new Error(`Unknown CSV column: ${column}`);
  for (const key of Object.keys(mapping.variables ?? {}))
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`Invalid variable name: ${key}`);
}

export function previewCampaignCsv(csv: string, mapping: CampaignCsvMapping): CampaignCsvPreview {
  const parsed = parseCsv(csv, MAX_PREVIEW_ROWS + 1);
  const [headers, ...sourceRows] = parsed.rows;
  if (!headers?.length) throw new Error('CSV header is required');
  validateMapping(headers, mapping);
  const index = new Map(headers.map((header, column) => [header, column]));
  const errors: CampaignCsvPreview['errors'] = [];
  const rows: CampaignContactInput[] = [];
  const seenPhones = new Set<string>();
  for (const [offset, source] of sourceRows.slice(0, MAX_PREVIEW_ROWS).entries()) {
    const rowNumber = offset + 2;
    const phoneValue = source[index.get(mapping.phone)!] ?? '';
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhoneNumber(phoneValue);
    } catch (error) {
      errors.push({ row: rowNumber, field: mapping.phone, message: (error as Error).message });
      continue;
    }
    if (seenPhones.has(phoneNumber)) {
      errors.push({ row: rowNumber, field: mapping.phone, message: 'duplicate phone number' });
      continue;
    }
    seenPhones.add(phoneNumber);
    const variables = Object.fromEntries(
      Object.entries(mapping.variables ?? {}).map(([key, column]) => [
        key,
        source[index.get(column)!] ?? '',
      ]),
    );
    rows.push({
      sourceRow: rowNumber,
      phoneNumber,
      externalId: mapping.externalId
        ? source[index.get(mapping.externalId)!] || undefined
        : undefined,
      variables,
    });
  }
  return {
    headers,
    rows,
    errors,
    truncated: parsed.truncated || sourceRows.length > MAX_PREVIEW_ROWS,
    exportSafe: true,
  };
}

export function sanitizeCsvExportCell(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

function encodeCell(value: string): string {
  const safe = sanitizeCsvExportCell(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function exportCampaignContacts(rows: readonly CampaignContactInput[]): string {
  if (rows.length > 100) throw new Error('Export page exceeds 100 contacts');
  const variableNames = [...new Set(rows.flatMap((row) => Object.keys(row.variables)))].sort();
  const output = [['phoneNumber', 'externalId', ...variableNames].map(encodeCell).join(',')];
  for (const row of rows) {
    output.push(
      [
        row.phoneNumber,
        row.externalId ?? '',
        ...variableNames.map((name) => row.variables[name] ?? ''),
      ]
        .map(encodeCell)
        .join(','),
    );
  }
  return `${output.join('\r\n')}\r\n`;
}
