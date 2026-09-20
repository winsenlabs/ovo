import { loadConsoleExtensions } from '@winsendotai/ovo-ui';
import { ConsoleApp } from '../../components/console-app';

const validViews = new Set([
  'agents',
  'providers',
  'tools',
  'calls',
  'evaluations',
  'performance',
  'infrastructure',
]);

export const dynamic = 'force-dynamic';

export default async function ConsolePage({ params }: { params: Promise<{ view?: string[] }> }) {
  const { view } = await params;
  const requested = view?.[0] ?? 'agents';
  const activeView = validViews.has(requested) ? requested : 'agents';
  const extensions = await loadConsoleExtensions();
  return <ConsoleApp activeView={activeView} extensions={extensions} />;
}
