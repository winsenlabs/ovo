import { BEAT_MS } from './human-bridge-end.ts';
import type { DeskCommand } from './human-contract.ts';
import type { HumanRuntimeDeps } from './human-runtime-deps.ts';

interface WatchInput {
  deps: HumanRuntimeDeps;
  ticketId: string;
  stop: AbortSignal;
  closed(): boolean;
  /** Someone else released or expired the ticket under the call. */
  ended(): Promise<void>;
  command(seq: number, command: DeskCommand): Promise<void>;
}

/** Beat, then poll the ticket for a command or an end someone else wrote. */
export async function watchTicket(input: WatchInput): Promise<void> {
  const { deps, ticketId: id } = input;
  let beat = deps.clock.now();
  while (!input.closed()) {
    await deps.clock.sleep(deps.pollMs, input.stop);
    if (input.closed()) return;
    if (deps.clock.now() - beat >= BEAT_MS) {
      beat = deps.clock.now();
      // swallow-ok: a missed beat is retried in five seconds; the sweeper allows twenty.
      void deps.service.tickets.workerBeat(id).catch(() => undefined);
    }
    const ticket = await deps.service.tickets.get(id).catch(() => undefined);
    if (!ticket || input.closed()) continue;
    if (ticket.status === 'released' || ticket.status === 'expired') return input.ended();
    const command = ticket.command;
    if (command && command.seq > command.ack) await input.command(command.seq, command.body);
  }
}
