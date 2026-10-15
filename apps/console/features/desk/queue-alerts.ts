'use client';
import { useEffect, useRef, useState } from 'react';
import type { DeskTicket } from '../../lib/derive/desk';
import { playChime } from './chime';

/** Tickets in `rows` this operator can act on that were not in `seen`. */
export function newOffers(seen: ReadonlySet<string>, rows: readonly DeskTicket[]): DeskTicket[] {
  return rows.filter(
    (entry) =>
      !seen.has(entry.ticket.id) && (entry.ticket.offeredToMe || entry.ticket.mode === 'OPEN_PICKUP'),
  );
}

/** The sentence a screen reader hears for a new caller. */
export function offerAnnouncement(entry: DeskTicket): string {
  return `Caller waiting in ${entry.ticket.queueName}`;
}

/**
 * Chimes, raises a desktop notification when the tab is hidden (only if the operator allowed
 * them) and returns the text for an `aria-live` region whenever a new caller appears. Nothing
 * fires for the tickets already on screen at first load, or while the operator is not Available.
 */
export function useQueueAlerts(rows: readonly DeskTicket[], enabled: boolean): string {
  const seen = useRef<Set<string> | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const known = seen.current;
    seen.current = new Set(rows.map((entry) => entry.ticket.id));
    if (!known || !enabled) return;
    const fresh = newOffers(known, rows);
    if (!fresh.length) return;
    playChime();
    const text = offerAnnouncement(fresh[0]!);
    setAnnouncement(text);
    if (
      typeof document !== 'undefined' &&
      document.hidden &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    )
      new Notification('Caller waiting', { body: text, tag: 'ovo-desk-offer' });
  }, [rows, enabled]);
  return announcement;
}
