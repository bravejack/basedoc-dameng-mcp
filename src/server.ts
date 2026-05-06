#!/usr/bin/env node
// Self-relaunch with --openssl-legacy-provider so dmdb's login handshake works
// on Node >= 17 (OpenSSL 3 disabled the algos dmdb relies on by default).
// Set DAMENG_NO_LEGACY_OPENSSL=1 to skip this, or invoke node directly with
// the flag already set.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const haveLegacyFlag =
  process.execArgv.some((a) => a.includes("openssl-legacy-provider")) ||
  (process.env.NODE_OPTIONS ?? "").includes("openssl-legacy-provider");

if (!haveLegacyFlag && !process.env.DAMENG_NO_LEGACY_OPENSSL) {
  const r = spawnSync(
    process.execPath,
    [
      "--openssl-legacy-provider",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, ConfigError } from "./config.js";
import { Database, type QueryResult } from "./database.js";
import {
  searchDocs,
  listManuals,
  listSections,
  readSection,
  DocsSearchError,
  type SectionHit,
} from "./docs.js";
import { SqlGuardError } from "./sql-guard.js";
import { TimeoutError } from "./with-timeout.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return `"${name.toUpperCase()}"`;
}

function formatResult(r: QueryResult): string {
  const header = r.truncated
    ? `(${r.rowCount} rows shown — truncated by maxRows)`
    : `(${r.rowCount} rows)`;
  if (r.rows.length === 0) {
    return `${header}\n[no rows]`;
  }
  return `${header}\n${JSON.stringify(r.rows, replacer, 2)}`;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[dameng-mcp] config error: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  const hasDb = config.host.length > 0 && config.port > 0;
  const db = hasDb ? new Database(config) : null;
  if (db) {
    await db.connect();
  } else {
    console.error("[dameng-mcp] no DB credentials — docs-only mode");
  }

  const server = new McpServer({
    name: "dameng-mcp",
    version: "0.1.0",
  });

  // --- DB tools (only when connected) ---

  if (db) {
  server.registerTool(
    "query",
    {
      description:
        "Execute a read-only SQL statement against Dameng. Only SELECT/WITH/EXPLAIN are accepted; multi-statement input is rejected. Results are capped by DAMENG_MAX_ROWS.",
      inputSchema: {
        sql: z.string().describe("Single SELECT, WITH, or EXPLAIN statement."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ sql }) => {
      try {
        const result = await db.runReadOnly(sql);
        return toolText(formatResult(result));
      } catch (e) {
        return toolError(formatToolError(e));
      }
    },
  );

  server.registerTool(
    "list_tables",
    {
      description:
        "List tables in a schema. Defaults to DAMENG_SCHEMA (or the connected user's schema if unset).",
      inputSchema: {
        schema: z
          .string()
          .optional()
          .describe("Schema/owner name. Identifier characters only."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ schema }) => {
      try {
        const owner = schema ?? config.schema;
        const sql = owner
          ? `SELECT OWNER, TABLE_NAME FROM ALL_TABLES WHERE OWNER = '${quoteIdent(owner).slice(1, -1)}' ORDER BY TABLE_NAME`
          : `SELECT TABLE_NAME FROM USER_TABLES ORDER BY TABLE_NAME`;
        const result = await db.runRaw(sql);
        return toolText(formatResult(result));
      } catch (e) {
        return toolError(formatToolError(e));
      }
    },
  );

  server.registerTool(
    "describe_table",
    {
      description: "Show columns and data types for a table.",
      inputSchema: {
        table: z.string().describe("Table name."),
        schema: z.string().optional().describe("Schema/owner name (optional)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ table, schema }) => {
      try {
        const tableQ = quoteIdent(table).slice(1, -1);
        const owner = schema ?? config.schema;
        const sql = owner
          ? `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE, DATA_DEFAULT
             FROM ALL_TAB_COLUMNS
             WHERE OWNER = '${quoteIdent(owner).slice(1, -1)}' AND TABLE_NAME = '${tableQ}'
             ORDER BY COLUMN_ID`
          : `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE, DATA_DEFAULT
             FROM USER_TAB_COLUMNS
             WHERE TABLE_NAME = '${tableQ}'
             ORDER BY COLUMN_ID`;
        const result = await db.runRaw(sql);
        return toolText(formatResult(result));
      } catch (e) {
        return toolError(formatToolError(e));
      }
    },
  );

  server.registerTool(
    "lookup_docs",
    {
      description:
        "Search the local Dameng knowledge base (Markdown manuals) for a phrase or pattern. Returns matches grouped by file with the nearest preceding heading. Requires DAMENG_DOCS_ROOT to be set.",
      inputSchema: {
        query: z.string().describe("Phrase to search for (literal, case-insensitive by default)."),
        manual: z
          .string()
          .optional()
          .describe(
            "Optional top-level subdirectory under DAMENG_DOCS_ROOT to restrict the search (e.g. DM8-SQL语言使用手册).",
          ),
        regex: z
          .boolean()
          .optional()
          .describe("Treat query as a JavaScript regex (case-insensitive). Default false."),
        maxMatches: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap on returned matches. Default 30."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ query, manual, regex, maxMatches }) => {
      if (!config.docsRoot) return docsRootMissingError();
      try {
        const sections = await searchDocs({
          root: config.docsRoot,
          query,
          manual,
          regex,
          maxMatches,
          include: config.docsInclude,
          exclude: config.docsExclude,
        });
        return toolText(formatSections(sections, maxMatches ?? 30));
      } catch (e) {
        return toolError(formatToolError(e));
      }
    },
  );

  server.registerTool(
    "list_manuals",
    {
      description:
        "List the Dameng manuals available under DAMENG_DOCS_ROOT, with file counts and a short index summary per manual. Use this to discover what to pass to list_sections / lookup_docs(manual=...).",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      if (!config.docsRoot) return docsRootMissingError();
      try {
        const manuals = await listManuals({
          root: config.docsRoot,
          include: config.docsInclude,
          exclude: config.docsExclude,
        });
        return toolText(formatManuals(manuals));
      } catch (e) {
        return toolError(formatToolError(e));
      }
    },
  );

  server.registerTool(
    "list_sections",
    {
      description:
        "List the .md files (chapters) inside one manual along with their H1/H2 headings. Use the (file, heading) pair to call read_section.",
      inputSchema: {
        manual: z.string().describe("Manual name (top-level dir under DAMENG_DOCS_ROOT)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ manual }) => {
      if (!config.docsRoot) return docsRootMissingError();
      try {
        const files = await listSections({ root: config.docsRoot, manual });
        return toolText(formatSectionList(files));
      } catch (e) {
        return toolError(formatToolError(e));
      }
    },
  );

  server.registerTool(
    "read_section",
    {
      description:
        "Read a Markdown chapter under DAMENG_DOCS_ROOT. With heading omitted, returns the whole file. With heading set, returns text from that heading until the next same-or-higher heading. Use after lookup_docs / list_sections to pull full context.",
      inputSchema: {
        file: z
          .string()
          .describe(
            "Relative path under DAMENG_DOCS_ROOT, e.g. DM8-数据守护与读写分离集群/data-watch-version-upgrade.md",
          ),
        heading: z
          .string()
          .optional()
          .describe("Heading text (without # markers) to extract a single section."),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap on returned content size. Default 64000."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ file, heading, maxBytes }) => {
      if (!config.docsRoot) return docsRootMissingError();
      try {
        const r = await readSection({ root: config.docsRoot, file, heading, maxBytes });
        const header = r.heading
          ? `# ${r.file} — ${r.heading}${r.truncated ? " (truncated)" : ""}\n\n`
          : `# ${r.file}${r.truncated ? " (truncated)" : ""}\n\n`;
        return toolText(header + r.content);
      } catch (e) {
        return toolError(formatToolError(e));
      }
    },
  );

  server.registerTool(
    "instance_status",
    {
      description:
        "Report Dameng instance and database status from V$INSTANCE / V$DATABASE.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const inst = await db.runRaw(
          `SELECT NAME, INSTANCE_NAME, HOST_NAME, SVR_VERSION, STATUS$, MODE$, START_TIME FROM V$INSTANCE`,
        );
        const dbi = await db.runRaw(
          `SELECT NAME, STATUS$, ARCH_MODE, DSC_ROLE FROM V$DATABASE`,
        );
        return toolText(
          `# V$INSTANCE\n${formatResult(inst)}\n\n# V$DATABASE\n${formatResult(dbi)}`,
        );
      } catch (e) {
        return toolError(formatToolError(e));
      }
    },
  );

  } // end if (db) block for DB tools

  // --- Docs tools (always available when DOCS_ROOT is set) ---

  const shutdown = async (signal: string) => {
    console.error(`[dameng-mcp] received ${signal}, shutting down`);
    try {
      await server.close();
    } catch {}
    try {
      if (db) await db.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[dameng-mcp] ready on stdio");
}

function formatToolError(e: unknown): string {
  if (e instanceof SqlGuardError) return `Rejected: ${e.message}`;
  if (e instanceof DocsSearchError) return `Docs: ${e.message}`;
  if (e instanceof TimeoutError) return `Timeout: ${e.message}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function docsRootMissingError() {
  return toolError(
    "DAMENG_DOCS_ROOT is not set. Configure it in the MCP server env to enable docs tools.",
  );
}

function formatSections(sections: SectionHit[], cap: number): string {
  if (sections.length === 0) return "No matches.";
  const totalShown = sections.reduce((n, s) => n + s.matches.length, 0);
  const totalAll = sections.reduce((n, s) => n + s.matchCount, 0);
  const truncated = totalShown >= cap || totalShown < totalAll;
  const parts: string[] = [];
  parts.push(
    truncated
      ? `${totalShown} of ${totalAll} matches in ${sections.length} sections (capped — narrow query or increase maxMatches):`
      : `${totalShown} match${totalShown === 1 ? "" : "es"} in ${sections.length} section${
          sections.length === 1 ? "" : "s"
        } (sorted by relevance):`,
  );
  for (const s of sections) {
    const head = s.heading ?? "(no heading)";
    parts.push(`\n## ${s.file} — ${head}  [${s.matchCount} hit${s.matchCount === 1 ? "" : "s"}]`);
    for (const m of s.matches) {
      if (m.contextBefore) parts.push(`    ${m.contextBefore}`);
      parts.push(`  L${m.line}: ${m.text}`);
      if (m.contextAfter) parts.push(`    ${m.contextAfter}`);
    }
  }
  return parts.join("\n");
}

function formatManuals(manuals: { manual: string; fileCount: number; indexSummary?: string }[]): string {
  if (manuals.length === 0) return "No manuals found.";
  const parts: string[] = [`${manuals.length} manual${manuals.length === 1 ? "" : "s"}:`];
  for (const m of manuals) {
    parts.push(`\n## ${m.manual}  (${m.fileCount} file${m.fileCount === 1 ? "" : "s"})`);
    if (m.indexSummary) {
      parts.push(m.indexSummary);
    }
  }
  return parts.join("\n");
}

function formatSectionList(
  files: { file: string; headings: { level: number; text: string; line: number }[] }[],
): string {
  if (files.length === 0) return "No files in this manual.";
  const parts: string[] = [`${files.length} file${files.length === 1 ? "" : "s"}:`];
  for (const f of files) {
    parts.push(`\n## ${f.file}`);
    if (f.headings.length === 0) {
      parts.push("  (no H1/H2 headings)");
      continue;
    }
    for (const h of f.headings) {
      const indent = "  ".repeat(h.level);
      parts.push(`${indent}L${h.line}: ${"#".repeat(h.level)} ${h.text}`);
    }
  }
  return parts.join("\n");
}

main().catch((e) => {
  console.error("[dameng-mcp] fatal:", e);
  process.exit(1);
});
