import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { bind, QUERIES, type Named } from './export-queries.ts';
import { IN_TCCCPR_2026_10, seriesOf } from './rule-packs.ts';
import { zipFiles } from './zip.ts';

/** Rows per file; a larger export is cut short and its manifest says so. */
const MAX_ROWS = 100_000;
const FORMULA = /^[\u0000- ]*[=+\-@]/;
const DAY = 86_400_000;

export interface ExportFilter {
  from: Date;
  to: Date;
  phoneNumber?: string;
  campaignId?: string;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text =
    value instanceof Date
      ? value.toISOString()
      : Array.isArray(value)
        ? value.join(';')
        : String(value);
  // Spreadsheet formulas never run on open; E.164 numbers keep their leading plus.
  if (FORMULA.test(text) && !/^\+\d+$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(columns: readonly string[], rows: readonly Record<string, unknown>[]): Buffer {
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((key) => cell(row[key])).join(',')),
  ];
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

/**
 * The regulator export (spec 3.8): one ZIP of CSVs plus a manifest with the rule pack, every
 * policy hash in range and a SHA-256 per file, so an OAP or TRAI investigation can check it.
 */
export async function complianceExport(
  pool: Pool,
  organizationId: string,
  filter: ExportFilter,
  settingsVersion: number,
): Promise<{ zip: Buffer; manifest: Record<string, unknown> }> {
  const named: Named = {
    org: organizationId,
    from: filter.from,
    to: filter.to,
    phone: filter.phoneNumber ?? null,
    campaign: filter.campaignId ?? null,
  };
  const files: Array<{ name: string; data: Buffer }> = [];
  const listed: Array<Record<string, unknown>> = [];
  const hashes = new Set<string>();
  for (const query of QUERIES) {
    const result = await pool.query(...bind(`${query.sql} LIMIT ${MAX_ROWS + 1}`, named));
    const rows = result.rows
      .slice(0, MAX_ROWS)
      .map((row) =>
        query.name === 'attempts.csv' ? { ...row, series: seriesOf(row.from_number) } : row,
      );
    if (query.name === 'decisions.csv') for (const row of rows) hashes.add(row.policy_hash);
    const data = csv(query.columns, rows);
    files.push({ name: query.name, data });
    listed.push({
      name: query.name,
      rows: rows.length,
      truncated: result.rows.length > MAX_ROWS,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    organizationId,
    filter: {
      from: filter.from.toISOString(),
      to: filter.to.toISOString(),
      ...(filter.phoneNumber ? { phoneNumber: filter.phoneNumber } : {}),
      ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    },
    rulePack: `${IN_TCCCPR_2026_10.id}@${IN_TCCCPR_2026_10.version}`,
    settingsVersion,
    policyHashes: [...hashes].sort(),
    files: listed,
    // Disclosure playback lives in each call's session events, not in operations storage.
    notes: ['Disclosure lines played are in GET /v1/calls/:id/events for each call_id.'],
  };
  files.push({
    name: 'manifest.json',
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  });
  return { zip: zipFiles(files), manifest };
}

/** The complaint-response packet: everything about one number within 7 days of a date (R21). */
export async function evidencePacket(
  pool: Pool,
  organizationId: string,
  phoneNumber: string,
  date: Date,
) {
  const from = new Date(date.getTime() - 7 * DAY);
  const to = new Date(date.getTime() + 7 * DAY);
  const named: Named = { org: organizationId, from, to, phone: phoneNumber, campaign: null };
  const packet: Record<string, unknown> = {
    phoneNumber,
    from: from.toISOString(),
    to: to.toISOString(),
  };
  for (const query of QUERIES.filter(
    (candidate) => !candidate.name.startsWith('cli_') && !candidate.name.startsWith('a2p'),
  ))
    packet[query.name.replace('.csv', '')] = (
      await pool.query(...bind(`${query.sql} LIMIT 1000`, named))
    ).rows;
  return packet;
}
