import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { runControlMigrations, PostgresControlStore } from '../src/index.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;
const integration = url ? describe : describe.skip;

integration('F3 Postgres inspection cursors', () => {
  const schema = `f3_inspection_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url!, options: `-c search_path=${schema}` });
    await runControlMigrations(pool);
    await pool.query(
      "INSERT INTO ovo_ctl_workspaces(id,name,created_at) VALUES('w','Workspace',now())",
    );
    const config = AgentConfig.parse({ name: 'Micro', mode: 'announcement', message: 'hello' });
    await pool.query(
      `INSERT INTO ovo_ctl_agents(workspace_id,id,config,draft_version,created_at,updated_at)
      VALUES('w','a',$1,1,now(),now())`,
      [config],
    );
    await pool.query(
      `INSERT INTO ovo_ctl_releases(workspace_id,id,agent_id,draft_version,config,plugins,provider_bindings,mcp_tools,created_at,created_by)
      VALUES('w','r','a',1,$1,'[]','{}','{}',now(),'tester')`,
      [config],
    );
    await pool.query(
      "INSERT INTO ovo_ctl_calls(workspace_id,id,release_id,kind,status,created_at) VALUES('w','call','r','live','done',now())",
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  it('pages evaluations through distinct microsecond timestamps', async () => {
    await pool.query(
      `INSERT INTO ovo_ctl_evaluations(workspace_id,id,release_id,status,fixtures,created_at,created_by)
       VALUES ('w','evaluation-micro-a','r','passed','[]','2025-01-01T00:00:00.000100Z','tester'),
              ('w','evaluation-micro-b','r','passed','[]','2025-01-01T00:00:00.000900Z','tester')`,
    );
    const store = await PostgresControlStore.open({
      connectionString: url!,
      options: `-c search_path=${schema}`,
    });
    try {
      const first = await store.listEvaluations('w', 1);
      expect(first.items.map((item) => item.id)).toEqual(['evaluation-micro-a']);
      expect(
        (await store.listEvaluations('w', 1, first.nextCursor!)).items.map((item) => item.id),
      ).toEqual(['evaluation-micro-b']);
    } finally {
      await store.close();
    }
  });
  it('pages usage through distinct microsecond timestamps', async () => {
    await pool.query(
      `INSERT INTO ovo_ctl_usage_entries
       (workspace_id,id,call_id,provider,request_id,quantity,unit,price_card_id,price_card_version,amount_minor,currency,state,created_at)
       VALUES ('w','usage-micro-a','call','fixture','micro-a','1','tokens','card','1','1','INR','estimated','2025-01-01T00:00:00.000100Z'),
              ('w','usage-micro-b','call','fixture','micro-b','1','tokens','card','1','1','INR','estimated','2025-01-01T00:00:00.000900Z')`,
    );
    const store = await PostgresControlStore.open({
      connectionString: url!,
      options: `-c search_path=${schema}`,
    });
    try {
      const first = await store.listUsage('w', 'call', 1);
      expect(first.items.map((item) => item.id)).toEqual(['usage-micro-a']);
      expect(
        (await store.listUsage('w', 'call', 1, first.nextCursor!)).items.map((item) => item.id),
      ).toEqual(['usage-micro-b']);
    } finally {
      await store.close();
    }
  });
  it('pages audit through distinct microsecond timestamps', async () => {
    await pool.query(
      `INSERT INTO ovo_ctl_audit_entries
       (workspace_id,id,actor_id,action,resource_type,resource_id,payload,created_at)
       VALUES ('w','audit-micro-a','tester','test','call','call','{}','2025-01-01T00:00:00.000100Z'),
              ('w','audit-micro-b','tester','test','call','call','{}','2025-01-01T00:00:00.000900Z')`,
    );
    const store = await PostgresControlStore.open({
      connectionString: url!,
      options: `-c search_path=${schema}`,
    });
    try {
      const first = await store.listAudit('w', 1);
      expect(first.items.map((item) => item.id)).toEqual(['audit-micro-a']);
      expect(
        (await store.listAudit('w', 1, first.nextCursor!)).items.map((item) => item.id),
      ).toEqual(['audit-micro-b']);
    } finally {
      await store.close();
    }
  });
});
