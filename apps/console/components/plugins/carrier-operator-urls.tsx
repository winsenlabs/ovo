'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';

type CarrierUrl = { purpose: string; label?: string; url: string };
export function carrierOperatorUrls(value: unknown): CarrierUrl[] {
  const items = value && typeof value === 'object' && 'items' in value ? value.items : undefined;
  if (
    !Array.isArray(items) ||
    items.some((item) => !item || typeof item.purpose !== 'string' || typeof item.url !== 'string')
  )
    throw new Error('Carrier URL response is invalid.');
  return items as CarrierUrl[];
}

export function CarrierOperatorUrls({ bindingId }: { bindingId: string }) {
  const [urls, setUrls] = useState<CarrierUrl[]>([]);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    let active = true;
    void apiRequest<unknown>(`/provider-bindings/${encodeURIComponent(bindingId)}/carrier-urls`)
      .then(({ data }) => {
        if (active) {
          setUrls(carrierOperatorUrls(data));
          setError(undefined);
        }
      })
      .catch((failure) => {
        if (active) {
          setUrls([]);
          setError(failure instanceof Error ? failure.message : 'Carrier URLs unavailable');
        }
      });
    return () => {
      active = false;
    };
  }, [bindingId]);
  return (
    <section>
      <h3>Operator URLs</h3>
      <p>Paste these URLs into your carrier console.</p>
      {error && <p role="alert">{error}</p>}
      {urls.map((item) => (
        <div className="ui-cluster" key={item.purpose}>
          <span>{item.label ?? item.purpose}</span>
          <code className="mono">{item.url}</code>
          <button
            type="button"
            className="button"
            onClick={() =>
              void navigator.clipboard.writeText(item.url).then(() => setCopied(item.purpose))
            }
          >
            {copied === item.purpose ? 'Copied' : 'Copy'}
          </button>
        </div>
      ))}
    </section>
  );
}
