interface TransactionClient {
  query(sql: string): Promise<unknown>;
  release(): void;
}

/** Keep BEGIN/COMMIT/ROLLBACK and release paired for every PostgreSQL host repository. */
export async function transaction<Client extends TransactionClient, T>(
  pool: { connect(): Promise<Client> },
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
