import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DID } from './harness.ts';

/** Path to the sipp binary; the SIPp suites run only when it is set (W11 §17.3). */
export const SIPP = process.env.OVO_TEST_SIPP;

const SCENARIOS = fileURLToPath(new URL('../sipp/', import.meta.url));

/** With SIPP_EVIDENCE_DIR set, the fake media gateway appends every frame to a jsonl file there. */
export function evidence(): { jsonlPath?: string } {
  const dir = process.env.SIPP_EVIDENCE_DIR;
  return dir ? { jsonlPath: join(dir, `frames-${Date.now()}-${process.pid}.jsonl`) } : {};
}

export interface SippResult {
  code: number | null;
  /** Every SIP message SIPp sent or received (`-trace_msg`). */
  messages: string;
  /** Unexpected-message and error log (`-trace_err`). */
  errors: string;
  output: string;
}

export interface SippRun {
  done: Promise<SippResult>;
  kill(): void;
}

export interface SippOptions {
  /** Our SIPp port; the gateway (UAC role) or nothing (UAS role) is the remote. */
  localPort: number;
  remote?: string;
  transport?: 'u1' | 't1';
  calls?: number;
  limit?: number;
  rate?: number;
  /** `-d`: the length of every `<pause/>`. */
  pauseMs?: number;
  mediaPort: number;
  rtpEcho?: boolean;
  keys?: Record<string, string>;
  extra?: string[];
  timeoutSec?: number;
}

/** Runs one SIPp scenario natively on loopback; exit code 0 means every call succeeded. */
export function runSipp(scenario: string, options: SippOptions): SippRun {
  const dir = mkdtempSync(join(tmpdir(), `sipp-${scenario}-`));
  const keys = { did: DID, formats: '0 8 101', ...options.keys };
  const args = [
    '-sf',
    join(SCENARIOS, `${scenario}.xml`),
    '-i',
    '127.0.0.1',
    '-p',
    String(options.localPort),
    '-t',
    options.transport ?? 'u1',
    '-m',
    String(options.calls ?? 1),
    '-l',
    String(options.limit ?? 1),
    '-r',
    String(options.rate ?? 1),
    '-d',
    String(options.pauseMs ?? 3000),
    '-mi',
    '127.0.0.1',
    '-mp',
    String(options.mediaPort),
    '-nostdin',
    '-timeout',
    `${options.timeoutSec ?? 60}s`,
    '-timeout_error',
    '-trace_msg',
    '-message_file',
    join(dir, 'messages.log'),
    '-trace_err',
    '-error_file',
    join(dir, 'errors.log'),
    ...Object.entries(keys).flatMap(([key, value]) => ['-key', key, value]),
    ...(options.rtpEcho ? ['-rtp_echo'] : []),
    ...(options.extra ?? []),
    ...(options.remote ? [options.remote] : []),
  ];
  const child = spawn(SIPP!, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const done = new Promise<SippResult>((resolve) =>
    child.on('close', (code) =>
      resolve({
        code,
        messages: read('messages.log'),
        errors: read('errors.log'),
        output: output.slice(-4000),
      }),
    ),
  );
  return { done, kill: () => child.kill('SIGINT') };
}

/** The bodies of every message of one kind in a SIPp message trace. */
export function tracedMessages(trace: string, startLine: RegExp): string[] {
  return trace
    .split(/^-{20,}.*$/m)
    .map((block) => block.replace(/^\s*(?:UDP|TCP) message (?:sent|received)[^\n]*\n/m, '').trim())
    .filter((block) => startLine.test(block.split('\n').find((line) => line.trim()) ?? ''));
}
