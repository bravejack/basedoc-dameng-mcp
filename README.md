# dameng-mcp

Read-only MCP server for Dameng (DM8). Built after rejecting `zqeast/dameng-mcp-server` for stdout-leaking the password and offering an unguarded `execute_sql`.

## Guarantees

- **Read-only at the application layer.** Only `SELECT` / `WITH` / `EXPLAIN` are accepted. Multi-statement input is rejected. Leading line/block comments are stripped before classification, so `-- foo\nDROP TABLE t` is also rejected.
- **No password fallback.** `DAMENG_PASSWORD` must be set; missing → exit 2. Nothing defaults to `SYSDBA`.
- **stderr-only logging.** stdio's stdout is the JSON-RPC channel — every log line goes through `console.error`.
- **Timeout + row cap.** Every query is bounded by `DAMENG_QUERY_TIMEOUT_MS` (default 10s) and capped at `DAMENG_MAX_ROWS` (default 1000). On timeout the underlying connection is closed.
- **Pinned dependencies.** `dmdb`, `@modelcontextprotocol/sdk`, and `zod` are all locked to exact versions.

The first line of defense is still **using a low-privilege Dameng account**. The app-layer guard is belt-and-braces; the database account should not have DML/DDL grants in the first place.

## Provision a read-only DB user

```sql
CREATE USER MCP_RO IDENTIFIED BY "<strong-password>";
GRANT CONNECT TO MCP_RO;
GRANT SELECT ON <schema>.<table> TO MCP_RO;
-- or grant on a whole schema you trust:
-- GRANT SELECT ANY TABLE TO MCP_RO;
GRANT SELECT ON V$INSTANCE TO MCP_RO;
GRANT SELECT ON V$DATABASE TO MCP_RO;
```

## Build

```bash
npm install
npm run build
```

## Configuration (env vars)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DAMENG_HOST` | yes | — | e.g. `dameng.example.com` |
| `DAMENG_PORT` | yes | — | e.g. `5236` |
| `DAMENG_USER` | yes | — | low-privilege account |
| `DAMENG_PASSWORD` | yes | — | no fallback |
| `DAMENG_SCHEMA` | no | — | default schema for `list_tables` / `describe_table` |
| `DAMENG_QUERY_TIMEOUT_MS` | no | `10000` | per-query timeout |
| `DAMENG_MAX_ROWS` | no | `1000` | hard cap on returned rows |
| `DAMENG_POOL_MIN` | no | `1` | |
| `DAMENG_POOL_MAX` | no | `4` | |
| `DAMENG_DOCS_ROOT` | no | — | absolute path to a directory of Markdown manuals. Enables the docs tools. |
| `DAMENG_DOCS_INCLUDE` | no | — | comma-separated top-level dir patterns to include (glob `*` supported). Recommended: `DM8-*` to scope to official manuals only. |
| `DAMENG_DOCS_EXCLUDE` | no | — | comma-separated top-level dir patterns to exclude. `node_modules` is always excluded. |

## Tools

### Database (require DB connection)
- `query(sql)` — run a single read-only statement.
- `list_tables(schema?)` — tables in a schema (defaults to `DAMENG_SCHEMA` or current user).
- `describe_table(table, schema?)` — columns + types for one table.
- `instance_status()` — `V$INSTANCE` + `V$DATABASE` snapshot.

### Docs (require `DAMENG_DOCS_ROOT`)
- `list_manuals()` — discover what manuals exist; each entry has `fileCount` and a short index summary (from `00-目录索引.md` or `README.md`).
- `list_sections(manual)` — list `.md` chapters in one manual with their H1/H2 headings (with line numbers).
- `read_section(file, heading?, maxBytes?)` — read a chapter or a single heading-bounded section. Use this to pull full context after a `lookup_docs` hit.
- `lookup_docs(query, manual?, regex?, maxMatches?)` — keyword/regex search. Results are **grouped by section** (file + nearest heading), each match has line ± 1 line of context, sections sorted by match count descending.

**Recommended workflow** for the LLM client:
1. `list_manuals()` → know what's available
2. `lookup_docs("keyword", manual: "DM8-...")` → find candidate sections
3. `read_section(file, heading)` → pull the full passage
4. Synthesize the answer for the user

### Safety
- `list_tables` / `describe_table` build their SQL internally and only accept identifier-shaped input (`[A-Za-z_][A-Za-z0-9_]*`).
- All docs tools only read `.md` files under `DAMENG_DOCS_ROOT`. `manual` and `file` parameters reject `..`, leading `.`, leading `/`, and other unsafe segments — no path traversal. `node_modules` directories are never walked.

## Register with Claude Code

```bash
claude mcp add dameng-prod \
  -e DAMENG_HOST=<your-dameng-host> \
  -e DAMENG_PORT=5236 \
  -e DAMENG_USER=MCP_RO \
  -e DAMENG_PASSWORD=<password> \
  -e DAMENG_SCHEMA=<your-schema> \
  -e DAMENG_DOCS_ROOT=/path/to/dameng-docs \
  -e DAMENG_DOCS_INCLUDE='DM8-*' \
  -- npx -y basedoc-dameng-mcp
```

Or, if you cloned the repo and want to run from source:

```bash
  -- node /path/to/basedoc-dameng-mcp/dist/server.js
```

Register one MCP server per Dameng instance. If the same box hosts multiple instances on different ports, use distinct names like `dameng-prod-a` / `dameng-prod-b`.

## Tests

```bash
npm test
```

Tests cover the SQL guard (rejection rules, comment stripping, multi-statement detection), the config loader (required vars, no password fallback, type validation, docs-root + include/exclude validation), the timeout helper, and the docs layer (`searchDocs` grouping/ranking/context, `listManuals`, `listSections`, `readSection` heading extraction + path-traversal safety). The dmdb integration is not unit-tested; verify it by pointing at a real instance.

## What is NOT here, by design

- No `execute_sql` / no DML / no DDL. If you need writes, write them directly with `dmctl`/JDBC, not through an LLM.
- No HTTP transport. stdio only — no inbound network surface.
- No automatic schema introspection on startup. Tools query system views on demand.

## Known transitive vulnerabilities

`npm audit` flags issues in `@modelcontextprotocol/sdk`'s HTTP transport chain (`express-rate-limit` → `ip-address`) and in the dev-only Vitest/Vite chain. The stdio server we ship doesn't load the HTTP transport, and Vitest isn't part of the runtime. These will clear when upstream bumps; we don't paper over them with `npm audit fix --force`.
