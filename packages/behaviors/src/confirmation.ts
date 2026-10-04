import {
  classifyConfirmation,
  type BehaviorEvent,
  type SpeechReceipt,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { speakArguments } from './args-speaker.ts';

export interface ConfirmedSelection {
  tool: ToolDefinition;
  input: unknown;
  operationId: string;
}

/** Whole-utterance confirmation requires actual playback evidence; NO always wins. */
export class ToolConfirmation {
  private pending?: ConfirmedSelection & { prompt: string; epoch?: number; heard: boolean };
  private epoch?: number;

  constructor(private readonly emit: (event: BehaviorEvent) => void = () => undefined) {}

  speechKind(text: string): 'confirmation' | undefined {
    return this.pending?.prompt === text ? 'confirmation' : undefined;
  }

  beginTurn(epoch: number): void {
    this.epoch = epoch;
  }
  expire(): void {
    if (this.pending) this.resolve('expired');
  }
  get waiting(): boolean {
    return !!this.pending;
  }

  request(selection: ConfirmedSelection, language = 'en-IN'): string {
    const details = speakArguments(selection.input, selection.tool.inputSchema, language);
    if (this.pending) this.resolve('expired');
    const prompt = `Please confirm: ${selection.tool.description}. Details: ${details}. Say yes to proceed or no to cancel.`;
    this.pending = { ...selection, prompt, epoch: this.epoch, heard: false };
    this.emit({
      type: 'confirmation.pending',
      toolId: selection.tool.id,
      operationId: selection.operationId,
    });
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
    const classification = classifyConfirmation(input);
    if (classification === 'no') {
      this.resolve('declined');
      return { kind: 'declined' };
    }
    if (pending.heard && classification === 'yes') {
      this.resolve('confirmed');
      return { kind: 'approved', selection: pending };
    }
    pending.epoch = this.epoch;
    pending.heard = false;
    this.emit({
      type: 'confirmation.pending',
      toolId: pending.tool.id,
      operationId: pending.operationId,
    });
    return { kind: 'repeat', prompt: pending.prompt };
  }

  played(receipt: SpeechReceipt): void {
    if (
      !this.pending ||
      receipt.text !== this.pending.prompt ||
      receipt.epoch !== this.pending.epoch
    )
      return;
    this.pending.heard = receipt.state === 'completed' && receipt.evidence !== 'estimated';
  }

  private resolve(result: 'confirmed' | 'declined' | 'expired'): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending)
      this.emit({
        type: 'confirmation.resolved',
        toolId: pending.tool.id,
        operationId: pending.operationId,
        result,
      });
  }
}
