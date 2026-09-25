import type { SpeechReceipt, ToolDefinition } from '@winsendotai/ovo-contracts';

export interface ConfirmedSelection {
  tool: ToolDefinition;
  input: unknown;
  operationId: string;
}

/** Exact acknowledgments only, after the confirmation request finishes playback. */
export class ToolConfirmation {
  private pending?: ConfirmedSelection & { prompt: string; epoch?: number; heard: boolean };
  private epoch?: number;

  beginTurn(epoch: number): void {
    this.epoch = epoch;
  }
  get waiting(): boolean {
    return !!this.pending;
  }

  request(selection: ConfirmedSelection): string {
    const details = JSON.stringify(selection.input, (key, value) =>
      /password|secret|token|authorization|api.?key/i.test(key) ? '[redacted]' : value,
    );
    if (details.length > 800)
      throw new Error('Action details are too large for voice confirmation');
    const prompt = `Please confirm: ${selection.tool.description}. Details: ${details}. Say yes to proceed or no to cancel.`;
    this.pending = { ...selection, prompt, epoch: this.epoch, heard: false };
    return prompt;
  }

  accept(
    input: string,
  ):
    | { kind: 'approved'; selection: ConfirmedSelection }
    | { kind: 'declined' }
    | { kind: 'repeat'; prompt: string } {
    const pending = this.pending;
    if (!pending) throw new Error('No confirmation request is pending');
    const normalized = input
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/[.!?]+$/, '');
    if (['no', 'cancel', 'do not proceed', 'stop'].includes(normalized)) {
      this.pending = undefined;
      return { kind: 'declined' };
    }
    if (pending.heard && ['yes', 'confirm', 'go ahead', 'proceed'].includes(normalized)) {
      this.pending = undefined;
      return { kind: 'approved', selection: pending };
    }
    pending.epoch = this.epoch;
    pending.heard = false;
    return { kind: 'repeat', prompt: pending.prompt };
  }

  played(receipt: SpeechReceipt): void {
    if (
      !this.pending ||
      receipt.text !== this.pending.prompt ||
      receipt.epoch !== this.pending.epoch
    )
      return;
    this.pending.heard = receipt.state === 'completed';
  }
}
