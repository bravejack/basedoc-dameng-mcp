# basedoc-dameng-mcp

面向达梦数据库 (DM8) 的只读 MCP 服务，附带**本地 Markdown 手册**的离线全文检索能力。把"运维问答"和"翻手册"这两件事做成 LLM 直接可调用的工具，让 Claude / 其它 MCP 客户端在一次会话里既能问数据库当前状态，也能查官方文档。

整套搜索能力**完全离线**——内网部署的达梦客户也能用。

## 取舍清单（什么进、什么不进）

不该让 LLM 做的事，挡在工具调用之前：

- SQL 入参只放 `SELECT` / `WITH` / `EXPLAIN`，多语句 / 注释绕过 / `DROP` 之类的关键字一律拒绝
- `DAMENG_PASSWORD` 不写也不补——缺失就直接退出 (exit 2)，不存在 SYSDBA 兜底
- stdout 留给 JSON-RPC，所有日志都走 stderr
- 每个查询带超时 + 行数硬上限
- 文档相关的工具不能跨出 `DAMENG_DOCS_ROOT` 边界——`..`、绝对路径、`node_modules` 全部拦截
- 关键依赖（`@modelcontextprotocol/sdk`、`dmdb`、`zod`）全部锁死精确版本

## 启动模式

按环境变量自动判定：

| 给的环境变量 | 行为 |
| --- | --- |
| 完整 DB 凭据 + `DAMENG_DOCS_ROOT` | 注册全部 8 个工具 |
| 只有 DB 凭据 | 只注册 4 个 DB 工具 |
| 只有 `DAMENG_DOCS_ROOT` | 只注册 4 个文档工具——适合"只让 LLM 看手册、不暴露数据库"的场景 |
| 都没有 | exit 2 |

## 环境变量

| 变量 | 何时必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DAMENG_HOST` | DB 模式 | — | 达梦服务器地址 |
| `DAMENG_PORT` | DB 模式 | — | 比如 `5236` |
| `DAMENG_USER` | DB 模式 | — | 推荐建低权账号 |
| `DAMENG_PASSWORD` | DB 模式 | — | 没有任何兜底 |
| `DAMENG_SCHEMA` | 否 | — | `list_tables` / `describe_table` 默认查的 schema |
| `DAMENG_QUERY_TIMEOUT_MS` | 否 | `10000` | 单次查询超时 |
| `DAMENG_MAX_ROWS` | 否 | `1000` | 单次返回行数硬上限 |
| `DAMENG_POOL_MIN` / `DAMENG_POOL_MAX` | 否 | `1` / `4` | 连接池上下限 |
| `DAMENG_DOCS_ROOT` | 文档模式 | — | 含 markdown 的目录的**绝对路径** |
| `DAMENG_DOCS_INCLUDE` | 否 | — | 顶层目录白名单，逗号分隔，支持 `*` 通配，例如 `DM8-*` |
| `DAMENG_DOCS_EXCLUDE` | 否 | — | 顶层目录黑名单。`node_modules` 永远硬排，无需手动加 |
| `DAMENG_NO_LEGACY_OPENSSL` | 否 | 不设 | 设 `1` 跳过下文那个自重启 |

## 工具

### 数据库（需要 DB 凭据）

| 工具 | 干啥 |
| --- | --- |
| `query(sql)` | 执行单条只读 SQL |
| `list_tables(schema?)` | 列某个 schema 下的表 |
| `describe_table(table, schema?)` | 列字段名 / 类型 / 是否可空 / 默认值 |
| `instance_status()` | `V$INSTANCE` + `V$DATABASE` 当前快照 |

### 文档（需要 `DAMENG_DOCS_ROOT`）

| 工具 | 干啥 |
| --- | --- |
| `list_manuals()` | 根目录下都有哪些手册（自动读取 `00-目录索引.md` / `README.md` 当摘要） |
| `list_sections(manual)` | 某本手册里有哪些 .md 章节，每个带 H1 / H2 标题 + 行号 |
| `read_section(file, heading?, maxBytes?)` | 读整个章节文件；带 heading 则只切出对应小节 |
| `lookup_docs(query, manual?, regex?, maxMatches?)` | 全文检索；命中按 (文件 + 最近 heading) 分组，每条带 ±1 行上下文，结果按命中数倒序 |

### LLM 客户端的推荐用法

按"先发现 → 再缩小 → 最后细读"的顺序最高效：

```
list_manuals()
  ↓ 知道有哪些手册
lookup_docs(query, manual="DM8-...")
  ↓ 缩到候选段落
read_section(file, heading="...")
  ↓ 拉完整正文
（合成回答）
```

`list_tables` 和 `describe_table` 内部生成 SQL，对入参做严格的标识符正则校验（`[A-Za-z_][A-Za-z0-9_]*`），不会拼接出注入。

## 准备一个低权数据库账号

直接给 SYSDBA 跑也能用——SQL 守卫已经限死只读——但纵深防御原则下建议：

```sql
CREATE USER MCP_RO IDENTIFIED BY "<强密码>";
GRANT SELECT ANY TABLE TO MCP_RO;
GRANT SELECT ON V$INSTANCE TO MCP_RO;
GRANT SELECT ON V$DATABASE TO MCP_RO;
```

注：达梦中 `CREATE USER` 后默认就有 session 权限，无需 `GRANT CONNECT`（这条会报语法错）。

## 在 Claude Code 中接入

```bash
claude mcp add dameng \
  --scope user \
  -e DAMENG_HOST=<达梦主机> \
  -e DAMENG_PORT=5236 \
  -e DAMENG_USER=MCP_RO \
  -e DAMENG_PASSWORD=<密码> \
  -e DAMENG_DOCS_ROOT=/绝对路径/手册目录 \
  -e DAMENG_DOCS_INCLUDE='DM8-*' \
  -- npx -y basedoc-dameng-mcp
```

如果一台机器上跑多个达梦实例，按实例分别注册，名字加后缀区分（例如 `dameng-prod-a` / `dameng-prod-b`）。

## 二进制为什么会自重启

`dmdb` 驱动握手阶段使用了 OpenSSL 3 在 Node 17+ 默认禁用的算法。不带 `--openssl-legacy-provider` 启动 Node 时，会报 `[6071] 消息加密失败` / `error:0308010C`。本包的 bin 入口检测到没带这个 flag 就自己 spawn 一次新进程加上，对调用者透明。代价是约 50ms 的额外启动。如果你的 dmdb 版本不需要，设 `DAMENG_NO_LEGACY_OPENSSL=1` 跳过。

## 关于手册语料

包本身**不内嵌任何达梦官方文档**——版权属于达梦数据库股份有限公司，由使用者自行准备。常见做法：

- 团队内部维护一个**私有 Git repo** 存 markdown 化后的手册，新机器 `git clone` 到任意目录后把 `DAMENG_DOCS_ROOT` 指过去
- 使用 pandoc / mammoth 把官方提供的 docx / pdf 转成 markdown
- 用任意你自己整理的 markdown 笔记目录——`lookup_docs` 不强制必须是达梦手册，纯笔记 / 内部 wiki 也能搜

## 测试

```
npm test
```

103 个用例，覆盖：

- SQL 守卫的关键字白名单 / 注释剥离 / 多语句检测
- 配置加载，包括无 SYSDBA 兜底的明确断言、include/exclude 解析
- 超时 helper
- 4 个文档函数：搜索分组与排名、目录列出、章节按 heading 切片读取、路径越权防护

dmdb 与 MCP 协议握手部分没有单元测试，需要指向真实达梦实例验证。

## 已知传递依赖告警

`npm audit` 会标记 `@modelcontextprotocol/sdk` HTTP transport 链（`express-rate-limit` → `ip-address`）以及开发环境 Vitest / Vite 链上的几个中等漏洞。本服务只跑 stdio transport，HTTP 那条链不会被加载；Vitest 是开发依赖不进入运行时。等上游升级后会自动消失，不会用 `npm audit fix --force` 强行覆盖。

## 故意不做的能力

- 不暴露 DML / DDL / 系统过程调用——写入操作请直接走 dmctl 或 JDBC
- 不开 HTTP transport——只 stdio，没有可被外部访问的网络面
- 启动时不做 schema 自检——按需查系统视图，避免不必要的握手成本

## 许可证

MIT。详见 [LICENSE](./LICENSE)。
