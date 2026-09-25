import { consoleExtensions } from '../layout';
import { AgentsFeature } from '../../../features/agents';
export default async function Page() { return <AgentsFeature extensions={await consoleExtensions} />; }
