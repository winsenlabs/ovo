import type { ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';

/** The "Environment" column credentials and bindings both carry — one definition so the two
 * tables don't drift (brief §2 "one way to do each thing"). */
export function environmentColumn<T extends { environment: string }>(): ColumnV2<T> {
  return {
    id: 'environment',
    header: 'Environment',
    priority: 'normal',
    sortValue: (row) => row.environment,
    cell: (row) => <StatusBadgeV2 value={row.environment} tone="neutral" size="sm" />,
  };
}
