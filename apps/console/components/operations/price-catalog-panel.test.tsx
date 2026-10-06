import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PriceCardPanel } from './price-card-panel';
import { PriceCatalogPanel } from './price-catalog-panel';

// OPS-13/14: prices were typed by hand (the only seed had invented INR values) and a card could not
// say which model it priced or that its price was a placeholder.
const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));
afterEach(() => {
  cleanup();
  request.mockReset();
});

const entry = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  card: {
    id,
    version: '2026-10-06',
    provider: 'openai',
    unit: 'output_tokens',
    currency: 'USD',
    minorUnitsPerBlock: '50',
    blockQuantity: '1000000',
    effectiveAt: '2026-10-06T00:00:00.000Z',
    ...extra,
  },
  meterKeys: ['openai.inference.output_tokens'],
  source: {
    url: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
    retrievedAt: '2026-10-06',
    quote: 'Output $0.5 / 1M tokens',
  },
  priceCard: {},
  status,
});

it('lists dated catalog prices and imports the selected ones as price cards', async () => {
  const onImported = vi.fn();
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/cost/price-catalog')
      return {
        data: {
          items: [
            entry('luna-output', 'not_imported', { model: 'gpt-6-luna', provisional: true }),
            entry('twilio', 'imported'),
          ],
        },
      };
    if (path === '/cost/price-catalog/import' && init?.method === 'POST')
      return { data: { items: JSON.parse(String(init.body)).ids } };
    throw new Error(`Unexpected API request: ${path}`);
  });
  render(<PriceCatalogPanel role="admin" onImported={onImported} />);
  const table = await screen.findByRole('region', { name: 'Vendor price catalog' });
  expect(within(table).getByText('gpt-6-luna')).toBeTruthy();
  expect(within(table).getByText('Provisional')).toBeTruthy();
  expect(within(table).getAllByText('Retrieved 2026-10-06')).toHaveLength(2);
  expect(screen.getByLabelText('Import twilio')).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByLabelText('Import luna-output'));
  fireEvent.click(screen.getByRole('button', { name: 'Import 1 selected' }));
  await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith(
    '/cost/price-catalog/import',
    expect.objectContaining({ body: JSON.stringify({ ids: ['luna-output'] }) }),
  );
  expect(await screen.findByText('Imported 1 price card.')).toBeTruthy();
});

it('hides import controls from non-admins', async () => {
  request.mockResolvedValue({ data: { items: [entry('luna-output', 'not_imported')] } });
  render(<PriceCatalogPanel role="viewer" />);
  await screen.findByRole('region', { name: 'Vendor price catalog' });
  expect(screen.queryByLabelText('Import luna-output')).toBeNull();
  expect(screen.queryByRole('button', { name: /Import/ })).toBeNull();
});

it('stores a card’s model and provisional flag and shows them in the list', async () => {
  const posted: Record<string, unknown>[] = [];
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/plugins')
      return {
        data: {
          plugins: [
            {
              id: 'llm',
              provider: 'openai',
              meters: [
                { key: 'openai.inference.output_tokens', label: 'Output', unit: 'output_tokens' },
              ],
            },
          ],
        },
      };
    if (path === '/cost/price-cards' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return { data: {} };
    }
    if (path.startsWith('/cost/price-cards'))
      return {
        data: {
          items: [
            { ...entry('luna', 'imported').card, model: 'gpt-6-luna', provisional: true },
            { ...entry('any', 'imported').card, id: 'any-model' },
          ],
        },
      };
    throw new Error(`Unexpected API request: ${path}`);
  });
  render(<PriceCardPanel role="admin" />);
  const table = await screen.findByRole('region', { name: 'Immutable price cards' });
  expect(within(table).getByText('gpt-6-luna')).toBeTruthy();
  expect(within(table).getByText('Any model')).toBeTruthy();
  expect(within(table).getByText('Provisional')).toBeTruthy();
  await screen.findByRole('option', { name: /openai\.inference\.output_tokens/ });
  fireEvent.change(screen.getByLabelText('Manifest meter key'), {
    target: { value: 'openai.inference.output_tokens' },
  });
  for (const [label, value] of [
    ['Card ID', 'luna-2'],
    ['Version', 'v2'],
    ['Minor units per block', '50'],
    ['Block quantity', '1000000'],
    ['Effective at', '2026-10-06T00:00'],
    ['Provenance', 'docs'],
    ['Model', ' gpt-6-luna '],
  ])
    fireEvent.change(screen.getByLabelText(label!, { exact: false }), { target: { value } });
  fireEvent.click(screen.getByLabelText('Provisional price', { exact: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Store immutable card' }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toMatchObject({ id: 'luna-2', model: 'gpt-6-luna', provisional: true });
});
