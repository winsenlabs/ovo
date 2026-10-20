import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The sip-gateway's own SIPp REFER scenarios: SIPp is the trunk's far end, answering a REFER. */
const SCENARIOS = new URL('../../../apps/sip-gateway/tests/sipp/', import.meta.url).pathname;

export interface SippReferResult {
  code: number | null;
  /** Every SIP message SIPp sent or received. */
  messages: string;
  errors: string;
  output: string;
}

/**
 * Runs one of the gateway's REFER scenarios against a running sip-gateway: SIPp sends the INVITE
 * for `did`, then plays the trunk while the call is handed off. The scenario exits 0 only when the
 * dialog went the way the scenario says (for instance a BYE after the final NOTIFY).
 */
export function runReferScenario(
  sipp: string,
  scenario: string,
  input: { target: string; localPort: number; mediaPort: number; did: string; pauseMs?: number },
) {
  const dir = mkdtempSync(join(tmpdir(), `sip-refer-${scenario}-`));
  const args = [
    '-sf',
    join(SCENARIOS, `${scenario}.xml`),
    '-i',
    '127.0.0.1',
    '-p',
    String(input.localPort),
    '-t',
    'u1',
    '-m',
    '1',
    '-l',
    '1',
    '-r',
    '1',
    '-d',
    String(input.pauseMs ?? 3_000),
    '-mi',
    '127.0.0.1',
    '-mp',
    String(input.mediaPort),
    '-nostdin',
    '-timeout',
    '90s',
    '-timeout_error',
    '-trace_msg',
    '-message_file',
    join(dir, 'messages.log'),
    '-trace_err',
    '-error_file',
    join(dir, 'errors.log'),
    '-key',
    'did',
    input.did,
    '-key',
    'formats',
    '0 8 101',
    input.target,
  ];
  const child = spawn(sipp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  const done = new Promise<SippReferResult>((resolve) =>
    child.on('close', (code) =>
      resolve({
        code,
        messages: read('messages.log'),
        errors: read('errors.log'),
        output: output.slice(-4_000),
      }),
    ),
  );
  return { done, kill: () => child.kill('SIGINT') };
}

/** The messages of one kind in a SIPp trace (those whose first line matches). */
export function tracedMessages(trace: string, startLine: RegExp): string[] {
  return trace
    .split(/^-{20,}.*$/m)
    .map((block) => block.replace(/^\s*(?:UDP|TCP) message (?:sent|received)[^\n]*\n/m, '').trim())
    .filter((block) => startLine.test(block.split('\n').find((line) => line.trim()) ?? ''));
}
