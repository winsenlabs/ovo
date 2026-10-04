import { normalizeForMatch } from '@winsendotai/ovo-contracts';

export interface InlineDocument {
  id: string;
  text: string;
  title?: string;
  citation?: string;
}

export interface InlineSource {
  id: string;
  label?: string;
  documents: readonly InlineDocument[];
}

export interface Chunked {
  id: string;
  sourceId: string;
  text: string;
  citation?: string;
  /** Term → count, over the normalised passage. Built once, at construction. */
  terms: ReadonlyMap<string, number>;
  length: number;
}

/**
 * Split on blank lines first, then pack paragraphs up to `maxCharacters`. Paragraph boundaries are
 * the author's own: a policy document's clauses are already separated, and cutting mid-clause is how
 * retrieval starts quoting half a rule. A single paragraph longer than the budget is split on
 * sentence boundaries, and only then, as a last resort, on the budget itself.
 */
export function chunkDocument(
  document: InlineDocument,
  sourceId: string,
  maxCharacters: number,
): Chunked[] {
  const paragraphs = document.text
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const packed: string[] = [];
  let current = '';
  for (const paragraph of paragraphs)
    for (const piece of fit(paragraph, maxCharacters)) {
      if (!current) current = piece;
      else if ([...current].length + 2 + [...piece].length <= maxCharacters)
        current = `${current}\n\n${piece}`;
      else {
        packed.push(current);
        current = piece;
      }
    }
  if (current) packed.push(current);
  return packed.map((text, index) => ({
    id: `${document.id}#${index + 1}`,
    sourceId,
    text,
    ...(citationFor(document, index, packed.length)
      ? { citation: citationFor(document, index, packed.length)! }
      : {}),
    terms: countTerms(text),
    length: [...text].length,
  }));
}

/** A citation a human can act on: the author's own, else the title, else nothing invented. */
function citationFor(document: InlineDocument, index: number, total: number): string | undefined {
  const base = document.citation ?? document.title;
  if (!base) return undefined;
  return total > 1 ? `${base} (${index + 1} of ${total})` : base;
}

/** One paragraph, cut only if it exceeds the budget on its own. */
function fit(paragraph: string, maxCharacters: number): string[] {
  if ([...paragraph].length <= maxCharacters) return [paragraph];
  const sentences = paragraph.match(/[^.!?]+[.!?]*\s*/g) ?? [paragraph];
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if ([...piece].length > maxCharacters) {
      if (current) {
        out.push(current);
        current = '';
      }
      // Nothing left to split on. Cut by code point, so a surrogate pair is never halved.
      const points = [...piece];
      for (let at = 0; at < points.length; at += maxCharacters)
        out.push(points.slice(at, at + maxCharacters).join(''));
      continue;
    }
    if (!current) current = piece;
    else if ([...current].length + 1 + [...piece].length <= maxCharacters)
      current = `${current} ${piece}`;
    else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

export function countTerms(text: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const term of normalizeForMatch(text).split(' ')) {
    if (!term) continue;
    terms.set(term, (terms.get(term) ?? 0) + 1);
  }
  return terms;
}
