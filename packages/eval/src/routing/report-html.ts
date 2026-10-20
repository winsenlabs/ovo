// The routing scorecard as one self-contained HTML page (no scripts, no external files): headline
// numbers, the gate's verdict, accuracy bars and shaded confusion matrices. Same look as the call
// eval's page; the content is `reportBlocks`, shared with the markdown.
import type { RoutingScorecard } from '@winsendotai/ovo-plugin-router';
import { escapeHtml } from '../report/timeline-svg.ts';
import { reportBlocks, type Block, type Gate } from './report-model.ts';

const STYLE = `
:root{--fg:#1b1f24;--muted:#5d6670;--line:#d8dde3;--bg:#fff;--card:#f5f7f9;--good:#1a7f37;--bad:#cf222e;--heat:9,105,218}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9da7b1;--line:#30363d;--bg:#0d1117;--card:#161b22;--heat:88,166,255}}
body{font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:1100px;padding:16px}
h1{font-size:22px}h2{font-size:18px;margin-top:32px;border-bottom:1px solid var(--line)}h3{font-size:15px}
table{border-collapse:collapse;margin:8px 0}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}.card{background:var(--card);border-radius:6px;padding:8px}
.card b{display:block;font-size:20px}.card span{color:var(--muted);font-size:12px}
.pass{color:var(--good);font-weight:700}.fail{color:var(--bad);font-weight:700}.note{color:var(--muted)}
.bar{display:inline-block;height:8px;background:rgb(var(--heat));border-radius:2px;vertical-align:middle}
.overflow{overflow-x:auto}`;

const e = escapeHtml;
const cell = (value: string | number, first: boolean) =>
  first ? `<td>${e(String(value))}</td>` : `<td class="num">${e(String(value))}</td>`;
const head = (cells: string[]) => `<tr>${cells.map((c) => `<th>${e(c)}</th>`).join('')}</tr>`;
const wrap = (rows: string[]) => `<div class="overflow"><table>${rows.join('')}</table></div>`;

function render(block: Block): string {
  switch (block.kind) {
    case 'title':
      return `<h1>${e(block.text)}</h1>`;
    case 'heading':
      return `<h${block.level}>${e(block.text)}</h${block.level}>`;
    case 'text':
      return `<p${block.tone ? ` class="${block.tone}"` : ''}>${e(block.text)}</p>`;
    case 'cards':
      return `<div class="cards">${block.items.map((i) => `<div class="card"><b>${e(i.value)}</b><span>${e(i.name)}</span></div>`).join('')}</div>`;
    case 'table':
      return wrap([
        head(block.bar ? [...block.head, ''] : block.head),
        ...block.rows.map((row) => {
          const cells = row.map((value, i) => cell(value, i === 0));
          if (block.bar) {
            const width = Math.round((Number.parseFloat(String(row.at(-1))) || 0) * 0.8);
            cells.push(`<td><span class="bar" style="width:${width}px"></span></td>`);
          }
          return `<tr>${cells.join('')}</tr>`;
        }),
      ]);
    case 'matrix': {
      const peak = Math.max(1, ...block.rows.flatMap((r) => r.cells));
      return wrap([
        head(['expected \\ chosen', ...block.head]),
        ...block.rows.map(
          (row, i) =>
            `<tr><th>${e(row.label)}</th>${row.cells
              .map(
                (n, j) =>
                  `<td class="num" style="background:rgba(var(--heat),${((n / peak) * (i === j ? 0.55 : 0.3)).toFixed(2)})" title="expected ${e(row.label)}, chose ${e(block.head[j]!)}">${n}</td>`,
              )
              .join('')}</tr>`,
        ),
      ]);
    }
    case 'list':
      return `<ul>${block.items
        .map(
          (item) =>
            `<li>${e(item.text)}${item.children ? `<ul>${item.children.map((c) => `<li>${e(c)}</li>`).join('')}</ul>` : ''}</li>`,
        )
        .join('')}</ul>`;
  }
}

export function routingHtmlReport(card: RoutingScorecard, label: string, gate?: Gate): string {
  const body = reportBlocks(card, label, gate).map(render).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Routing eval: ${e(label)}</title><style>${STYLE}</style></head><body>${body}</body></html>\n`;
}
