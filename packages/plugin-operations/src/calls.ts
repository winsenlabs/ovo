import type { Pool, QueryResultRow } from 'pg';
import type { OwnedCallBinding } from './types.ts';

interface CallBindingRow extends QueryResultRow {
  internal_call_id: string;
  carrier_call_id: string;
  release_id: string;
  binding_receipt_id: string;
  status: 'active' | 'terminal';
}

function fromRow(row: CallBindingRow): OwnedCallBinding {
  return {
    internalCallId: row.internal_call_id,
    carrierCallId: row.carrier_call_id,
    releaseId: row.release_id,
    bindingReceiptId: row.binding_receipt_id,
    status: row.status,
  };
}

export class OperationsCallRegistry {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  /** Internal worker hook. `bindingReceiptId` must identify the verified carrier/orchestration receipt. */
  async bind(input: {
    internalCallId: string;
    carrierCallId: string;
    releaseId: string;
    bindingReceiptId: string;
  }): Promise<OwnedCallBinding> {
    for (const [name, value] of Object.entries(input)) {
      if (!value.trim() || value.length > 500) throw new Error(`${name} is invalid`);
    }
    const result = await this.pool.query<CallBindingRow>(
      `INSERT INTO ovo_ops_call_bindings
        (organization_id, internal_call_id, carrier_call_id, release_id, binding_receipt_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id, internal_call_id) DO UPDATE SET
         updated_at = now()
       WHERE ovo_ops_call_bindings.carrier_call_id = EXCLUDED.carrier_call_id
         AND ovo_ops_call_bindings.release_id = EXCLUDED.release_id
         AND ovo_ops_call_bindings.binding_receipt_id = EXCLUDED.binding_receipt_id
       RETURNING internal_call_id, carrier_call_id, release_id, binding_receipt_id, status`,
      [
        this.organizationId,
        input.internalCallId,
        input.carrierCallId,
        input.releaseId,
        input.bindingReceiptId,
      ],
    );
    if (!result.rows[0]) throw new Error('Owned call binding collision');
    return fromRow(result.rows[0]);
  }

  async get(internalCallId: string): Promise<OwnedCallBinding | undefined> {
    const result = await this.pool.query<CallBindingRow>(
      `SELECT internal_call_id, carrier_call_id, release_id, binding_receipt_id, status
       FROM ovo_ops_call_bindings WHERE organization_id = $1 AND internal_call_id = $2`,
      [this.organizationId, internalCallId],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async markTerminal(internalCallId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_ops_call_bindings SET status = 'terminal', updated_at = now()
       WHERE organization_id = $1 AND internal_call_id = $2 AND status = 'active'`,
      [this.organizationId, internalCallId],
    );
    return result.rowCount === 1;
  }

  async markTerminalByCarrierCallId(carrierCallId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_ops_call_bindings SET status = 'terminal', updated_at = now()
       WHERE organization_id = $1 AND carrier_call_id = $2 AND status = 'active'`,
      [this.organizationId, carrierCallId],
    );
    return result.rowCount === 1;
  }
}
