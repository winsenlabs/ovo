import { readFileSync } from 'node:fs';
import { BlockList, isIPv4 } from 'node:net';
import { z } from 'zod';

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
