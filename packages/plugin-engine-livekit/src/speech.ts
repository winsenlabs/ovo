import type { Speech, SpeechReceipt } from '@winsendotai/ovo-contracts';

/** Progress may arrive while the graph is opening; attach exactly once after AgentSession.start. */
export class LiveKitSpeech implements Speech {
  private target?: Speech;
  private readonly waiting: {
    text: string;
    options?: Parameters<Speech['speak']>[1];
    resolve: (value: SpeechReceipt) => void;
    reject: (error: Error) => void;
  }[] = [];
  private closed = false;
  speak(text: string, options?: Parameters<Speech['speak']>[1]): Promise<SpeechReceipt> {
    if (this.closed) return Promise.reject(new Error('LiveKit speech is closed'));
    if (this.target) return this.target.speak(text, options);
    return new Promise((resolve, reject) => this.waiting.push({ text, options, resolve, reject }));
  }
  attach(target: Speech): void {
    if (this.target || this.closed)
      throw new Error('LiveKit speech cannot attach twice or after close');
    this.target = target;
    for (const item of this.waiting.splice(0))
      void target.speak(item.text, item.options).then(item.resolve, item.reject);
  }
  async interrupt(): Promise<void> {
    await this.target?.interrupt();
  }
  close(): void {
    this.closed = true;
    for (const item of this.waiting.splice(0))
      item.reject(new Error('LiveKit speech closed before start'));
  }
}
