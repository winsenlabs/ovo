import type { DiscoveredTool, McpConnection, ToolApproval } from '../../lib/api';
import { statusTone } from '../../lib/status';

/** Connections grouped by tone (healthy/ready -> ok, error -> danger, anything else -> neutral). */
export function connectionHealthCounts(connections: readonly McpConnection[]): {
  ok: number;
  attention: number;
} {
  let ok = 0;
  let attention = 0;
  for (const connection of connections) {
    if (statusTone(connection.status) === 'ok') ok += 1;
    else if (statusTone(connection.status) === 'danger' || statusTone(connection.status) === 'warn')
      attention += 1;
  }
  return { ok, attention };
}

/** Host only, for the truncated endpoint column; the full URL stays available via `title`. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export function approvalFor(
  tool: DiscoveredTool,
  approvals: readonly ToolApproval[],
): ToolApproval | undefined {
  return approvals.find((approval) => (approval.toolId ?? approval.id) === tool.id);
}

export function hasDrifted(tool: DiscoveredTool, approvals: readonly ToolApproval[]): boolean {
  const approved = approvalFor(tool, approvals);
  return Boolean(approved && approved.schemaDigest !== tool.schemaDigest);
}
