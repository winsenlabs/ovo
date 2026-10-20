import type { RoutingScorecard } from '@winsendotai/ovo-plugin-router';
import { reportBlocks, type Block, type Gate } from './report-model.ts';

const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const table = (head: string[], rows: (string | number)[][]) => [
  row(head),
  row(head.map(() => '---')),
  ...rows.map(row),
];

function render(block: Block): string[] {
  switch (block.kind) {
    case 'title':
      return [`# ${block.text}`, ''];
    case 'heading':
      return [`${'#'.repeat(block.level)} ${block.text}`, ''];
    case 'text':
      return [block.tone === 'note' ? `_${block.text}_` : block.text, ''];
    case 'cards':
      return [`**${block.summary}**`, ''];
    case 'table':
      return [...table(block.head, block.rows), ''];
    case 'matrix':
      return [
        ...table(
          ['expected \\ chosen', ...block.head],
          block.rows.map((r) => [r.label, ...r.cells]),
        ),
        '',
      ];
    case 'list':
      return [
        ...block.items.flatMap((item) => [
          `- ${item.text}`,
          ...(item.children ?? []).map((child) => `  - ${child}`),
        ]),
        '',
      ];
  }
}

/** The scorecard as markdown: what a pull request or a mini-ci log shows. */
export function markdownReport(card: RoutingScorecard, label: string, gate?: Gate): string {
  return reportBlocks(card, label, gate).flatMap(render).join('\n');
}
