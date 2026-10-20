const MUTE_KEY = 'ovo.desk.chimeMuted';

export function chimeMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setChimeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // Storage can be blocked; the preference then lasts the page only.
  }
}

/** Two short rising tones. Web Audio only: no asset to ship, and a failure is silent. */
export function playChime(): void {
  const Context = typeof AudioContext === 'undefined' ? undefined : AudioContext;
  if (!Context || chimeMuted()) return;
  try {
    const context = new Context();
    const start = context.currentTime;
    [660, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + index * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.2, start + index * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.16 + 0.15);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + index * 0.16);
      oscillator.stop(start + index * 0.16 + 0.16);
    });
    setTimeout(() => void context.close().catch(() => undefined), 600);
  } catch {
    // An audio context the browser refuses (autoplay policy) is not worth surfacing.
  }
}
