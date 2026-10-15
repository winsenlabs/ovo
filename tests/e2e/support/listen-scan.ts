import { execFileSync } from 'node:child_process';

export interface ListeningSocket {
  protocol: 'tcp' | 'udp';
  /** The address as lsof prints it: `127.0.0.1`, `*`, `::1`. */
  host: string;
  port: number;
}

function sockets(protocol: 'tcp' | 'udp', pid: number): ListeningSocket[] {
  let output = '';
  try {
    output = execFileSync(
      'lsof',
      [
        '-nP',
        '-a',
        '-p',
        String(pid),
        protocol === 'tcp' ? '-iTCP' : '-iUDP',
        '-F',
        'n',
        ...(protocol === 'tcp' ? ['-sTCP:LISTEN'] : []),
      ],
      { encoding: 'utf8' },
    );
  } catch (error) {
    // lsof exits 1 when it finds nothing.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
  return output
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1))
    .filter((name) => !name.includes('->'))
    .map((name) => {
      const split = name.lastIndexOf(':');
      return {
        protocol,
        host: name.slice(0, split).replace(/^\[|\]$/g, ''),
        port: Number(name.slice(split + 1)),
      };
    });
}

/** Every socket this process is listening on: TCP listeners and bound UDP sockets. */
export function listeningSockets(pid = process.pid): ListeningSocket[] {
  return [...sockets('tcp', pid), ...sockets('udp', pid)];
}

/** What a LiveKit server listens on by default: signalling, ICE over TCP and UDP mux, TURN. */
export const LIVEKIT_DEFAULT_PORTS = [7880, 7881, 7882, 3478, 5349];
