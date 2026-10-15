import { readFileSync } from 'node:fs';
import { BlockList, isIPv4 } from 'node:net';
import { z } from 'zod';
import { parseUri } from '../sip/address.ts';

const E164 = /^\+[1-9]\d{6,14}$/;

/** `a.b.c.d/nn` (IPv4 only, like the trunks and the VM). */
export function parseCidr(value: string): { address: string; prefix: number } {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(value.trim());
  const prefix = match?.[2] === undefined ? 32 : Number(match[2]);
  if (!match || !isIPv4(match[1]!) || prefix > 32) throw new TypeError(`Invalid CIDR ${value}`);
  return { address: match[1]!, prefix };
}

export function blockListOf(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const { address, prefix } = parseCidr(cidr);
    list.addSubnet(address, prefix, 'ipv4');
  }
  return list;
}

/** Whether `address` (v4, or v4-mapped v6 from a dual-stack socket) is inside `list`. */
export function contains(list: BlockList, address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIPv4(v4) && list.check(v4, 'ipv4');
}

const cidr = z.string().refine((value) => {
  try {
    parseCidr(value);
    return true;
  } catch {
    return false;
  }
}, 'invalid IPv4 CIDR');

/** `sip:host[:port][;transport=udp|tcp]` with a literal IPv4 host or a DNS name. */
const proxy = z.string().regex(/^sip:[A-Za-z0-9.-]+(?::\d{1,5})?(?:;transport=(?:udp|tcp))?$/);

function proxyInsideSignalling(proxy: string | undefined, cidrs: readonly string[]): boolean {
  const host = proxy ? /^sip:([^:;]+)/.exec(proxy)?.[1] : undefined;
  if (!host || !isIPv4(host)) return true;
  try {
    return contains(blockListOf(cidrs), host);
  } catch {
    return true;
  }
}

const referHost = z
  .string()
  .regex(/^\.?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/)
  .refine((value) => !value.includes('..'), 'empty DNS label')
  .transform((value) => value.toLowerCase());

/**
 * `{e164}` once, in the user part, of a `sip:`/`sips:` URI with a host: `sip:{e164}@sbc.example.net;user=phone`.
 * Checked by substituting a sample number, so a template can never produce a URI the Refer-To
 * builder would not accept.
 */
export function phoneTemplateProblem(template: string): string | undefined {
  if (template.split('{e164}').length !== 2) return 'phoneUriTemplate needs {e164} exactly once';
  if (/[\s<>"?#]/.test(template))
    return 'phoneUriTemplate may not contain whitespace, <>, ?, # or "';
  const uri = parseUri(template.replace('{e164}', '+919000000000'));
  if (!uri || uri.scheme === 'tel' || !uri.host)
    return 'phoneUriTemplate must be a sip: or sips: URI';
  if (uri.user !== '+919000000000')
    return 'phoneUriTemplate must carry {e164} as the whole user part';
  return undefined;
}

/**
 * SIP REFER transfer (R3). Off by default per trunk: a carrier's SBC either accepts REFER from us
 * or it does not, and only the operator knows. `phoneUriTemplate` turns a phone target into the
 * Refer-To URI; `allowedHosts` (exact host, or `.suffix` for subdomains) is the toll-fraud guard
 * for `sip` targets, which come from a third party's answer.
 */
const ReferSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    phoneUriTemplate: z.string().max(512).optional(),
    allowedHosts: z.array(referHost).max(64).default([]),
  })
  .superRefine((refer, ctx) => {
    const problem = refer.phoneUriTemplate
      ? phoneTemplateProblem(refer.phoneUriTemplate)
      : undefined;
    if (problem) ctx.addIssue({ code: 'custom', path: ['phoneUriTemplate'], message: problem });
    if (refer.enabled && !refer.phoneUriTemplate && !refer.allowedHosts.length)
      ctx.addIssue({
        code: 'custom',
        message: 'refer.enabled needs phoneUriTemplate, allowedHosts or both',
      });
  });

const TrunkSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    /** The OVO carrier id the trunk is delivered through (`/carriers/<carrierId>/…`). */
    carrierId: z.string().regex(/^[a-z0-9-]{1,40}$/),
    bindingId: z.string().min(1).max(256),
    transport: z.enum(['udp', 'tcp']).default('udp'),
    signallingCidrs: z.array(cidr).min(1).max(64),
    mediaCidrs: z.array(cidr).max(64).default([]),
    codecs: z
      .array(z.enum(['PCMU', 'PCMA']))
      .min(1)
      .max(2)
      .default(['PCMU', 'PCMA']),
    dtmf: z.enum(['rfc4733', 'info']).default('rfc4733'),
    numberFormat: z.strictObject({ country: z.enum(['IN', 'E164']) }).default({ country: 'IN' }),
    forwardHeaders: z
      .array(z.string().regex(/^X-[A-Za-z0-9-]{1,60}$/))
      .max(16)
      .default([]),
    inviteRatePerSecond: z.number().positive().max(100).default(5),
    maxConcurrent: z.number().int().positive().max(1000).default(2),
    optionsPingSeconds: z.number().int().min(0).max(3600).default(30),
    refer: ReferSchema.default({ enabled: false, allowedHosts: [] }),
    inbound: z
      .strictObject({
        enabled: z.boolean(),
        numbers: z.array(z.string().regex(E164)).max(1000).default([]),
      })
      .default({ enabled: false, numbers: [] }),
    outbound: z
      .strictObject({
        enabled: z.boolean(),
        proxy: proxy.optional(),
        fromNumbers: z.array(z.string().regex(E164)).max(1000).default([]),
        auth: z.enum(['ip', 'digest']).default('ip'),
      })
      .default({ enabled: false, fromNumbers: [], auth: 'ip' }),
  })
  .refine((trunk) => !trunk.outbound.enabled || trunk.outbound.proxy, {
    message: 'outbound.enabled needs outbound.proxy',
  })
  .refine((trunk) => proxyInsideSignalling(trunk.outbound.proxy, trunk.signallingCidrs), {
    // Its responses would be dropped by the pre-parse allow-list.
    message: 'outbound.proxy must be inside signallingCidrs',
  });

export const TrunkFileSchema = z
  .strictObject({ version: z.literal(1), trunks: z.array(TrunkSchema).min(1).max(32) })
  .refine((file) => new Set(file.trunks.map((t) => t.id)).size === file.trunks.length, {
    message: 'trunk ids must be unique',
  });

export type TrunkConfig = z.infer<typeof TrunkSchema>;

export interface Trunk extends TrunkConfig {
  signalling: BlockList;
  media: BlockList;
}

export function parseTrunkFile(value: unknown): Trunk[] {
  const parsed = TrunkFileSchema.safeParse(value);
  if (!parsed.success)
    throw new TypeError(
      `Invalid trunk file: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return parsed.data.trunks.map((trunk) => ({
    ...trunk,
    signalling: blockListOf(trunk.signallingCidrs),
    media: blockListOf(trunk.mediaCidrs),
  }));
}

/** Fails closed: an unreadable or invalid file stops the boot. */
export function loadTrunkFile(path: string): Trunk[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new TypeError(`Cannot read the trunk file ${path}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new TypeError(`The trunk file ${path} is not JSON`);
  }
  return parseTrunkFile(json);
}

/** The trunk whose signalling CIDRs contain `address` (first match wins). */
export function trunkForSource(trunks: readonly Trunk[], address: string): Trunk | undefined {
  return trunks.find((trunk) => contains(trunk.signalling, address));
}
