import dmdb from "dmdb";
import type { Config } from "./config.js";
import { ensureReadOnly } from "./sql-guard.js";
import { withTimeout } from "./with-timeout.js";

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  rowCount: number;
}

export class Database {
  private pool: dmdb.Pool | null = null;

  constructor(private readonly config: Config) {}

  async connect(): Promise<void> {
    if (this.pool) return;
    const connectString = buildConnectString(this.config);
    this.pool = await dmdb.createPool({
      connectString,
      poolMin: this.config.poolMin,
      poolMax: this.config.poolMax,
      poolAlias: "dameng-mcp",
    });
    console.error(
      `[dameng-mcp] connected to ${this.config.host}:${this.config.port} as ${this.config.user}`,
    );
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = null;
    await pool.close(2);
  }

  async runReadOnly(sql: string): Promise<QueryResult> {
    const safeSql = ensureReadOnly(sql);
    return this.runRaw(safeSql);
  }

  /**
   * Internal helper used by built-in tools (list_tables, describe_table,
   * instance_status) that build their own SELECT against system views.
   * Still capped by maxRows and timeout. Never expose to user-supplied input.
   */
  async runRaw(sql: string): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error("Database not connected");
    }
    const conn = await this.pool.getConnection();
    let timedOut = false;
    try {
      const exec = conn.execute<Record<string, unknown>>(sql, [], {
        outFormat: dmdb.OUT_FORMAT_OBJECT,
        maxRows: this.config.maxRows + 1,
        autoCommit: false,
        extendedMetaData: false,
      });

      const result = await withTimeout(
        exec,
        this.config.queryTimeoutMs,
        "query",
        () => {
          timedOut = true;
          conn.close().catch(() => {});
        },
      );

      const allRows = result.rows ?? [];
      const truncated = allRows.length > this.config.maxRows;
      const rows = truncated ? allRows.slice(0, this.config.maxRows) : allRows;
      const columns = (result.metaData ?? [])
        .filter((m): m is dmdb.Metadata => !Array.isArray(m))
        .map((m) => m.name);
      return { columns, rows, truncated, rowCount: rows.length };
    } finally {
      if (!timedOut) {
        await conn.close().catch(() => {});
      }
    }
  }
}

function buildConnectString(c: Config): string {
  const auth = `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}`;
  const params = new URLSearchParams();
  if (c.schema) params.set("schema", c.schema);
  params.set("autoCommit", "false");
  const qs = params.toString();
  return `dm://${auth}@${c.host}:${c.port}${qs ? `?${qs}` : ""}`;
}
