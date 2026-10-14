// One call drawn on a time axis, for the HTML report: what the caller said (gold), the turns the
// detector made of it, and the agent's lines (heard, cut off, or composed and thrown away). Split
// turns, talk-over and discarded replies are visible at a glance.
import type { CallScore } from '../score/scorecard.ts';

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const ROW = 22;
const LEFT = 70;
const WIDTH = 1400;

function bar(x: number, y: number, w: number, cls: string, title: string): string {
  return `<rect class="${cls}" x="${x.toFixed(1)}" y="${y}" width="${Math.max(2, w).toFixed(1)}" height="${ROW - 6}"><title>${escapeHtml(title)}</title></rect>`;
}

export function timelineSvg(call: CallScore): string {
  const ends = [
    ...call.turns.map((turn) => turn.endMs ?? turn.startMs),
    ...call.lines.map((line) => line.endedMs ?? line.audibleMs ?? line.generatedMs),
    ...call.utterances.map((u) => u.endMs),
  ];
  const span = Math.max(1000, ...ends);
  const scale = (WIDTH - LEFT - 10) / span;
  const x = (ms: number) => LEFT + ms * scale;
  const rows = ['said (gold)', 'turns', 'agent heard', 'agent unheard'];
  const parts: string[] = [];
  rows.forEach((label, index) =>
    parts.push(`<text class="label" x="4" y="${index * ROW + 15}">${label}</text>`),
  );
  for (const u of call.utterances)
    parts.push(bar(x(u.startMs), 3, (u.endMs - u.startMs) * scale, 'gold', `${u.id}: ${u.gold}`));
  for (const turn of call.turns) {
    const end = turn.endMs ?? turn.startMs;
    const cls =
      turn.outcome === 'stopped'
        ? turn.flags.some((f) => f === 'split' || f === 'false-endpoint')
          ? 'turn bad'
          : 'turn'
        : 'turn reset';
    parts.push(
      bar(
        x(turn.startMs),
        ROW + 3,
        (end - turn.startMs) * scale,
        cls,
        `${turn.turnId} ${turn.rule ?? turn.outcome}: ${turn.text}`,
      ),
    );
  }
  for (const line of call.lines) {
    if (line.audibleMs !== undefined) {
      const end = line.endedMs ?? line.audibleMs + 500;
      const cls =
        line.kind === 'acknowledgment'
          ? 'line filler'
          : line.outcome === 'interrupted'
            ? 'line cut'
            : 'line';
      parts.push(
        bar(
          x(line.audibleMs),
          2 * ROW + 3,
          (end - line.audibleMs) * scale,
          cls,
          `${line.turnId ?? ''} ${line.text}`,
        ),
      );
    } else
      parts.push(
        bar(
          x(line.generatedMs),
          3 * ROW + 3,
          3,
          'line dropped',
          `${line.turnId ?? ''} unheard: ${line.text}`,
        ),
      );
  }
  const ticks: string[] = [];
  for (let s = 0; s * 1000 <= span; s += 10)
    ticks.push(
      `<line class="tick" x1="${x(s * 1000)}" x2="${x(s * 1000)}" y1="0" y2="${rows.length * ROW}"/><text class="tick" x="${x(s * 1000) + 2}" y="${rows.length * ROW + 12}">${s}s</text>`,
    );
  return `<svg class="timeline" viewBox="0 0 ${WIDTH} ${rows.length * ROW + 16}" role="img" aria-label="${escapeHtml(call.call)} timeline">${ticks.join('')}${parts.join('')}</svg>`;
}
