#!/usr/bin/env node
import { resolve } from "node:path";
import { fetchAndConvertAll } from "./fetch-docs.js";

const DEFAULT_SOURCE = "https://eco.dameng.com/document/dm/zh-cn/pm/";

function usage(): never {
  process.stderr.write(
    [
      "用法: basedoc-dameng-fetch-docs <目标目录> [--source <URL>] [--concurrency <N>]",
      "",
      "  从达梦官方在线文档抓取所有手册并转换为 Markdown，写入指定目录。",
      "  目标目录可以直接当作 DAMENG_DOCS_ROOT 给 basedoc-dameng-mcp 使用。",
      "",
      "选项:",
      "  --source <URL>      达梦文档站点的索引页 URL",
      `                      默认: ${DEFAULT_SOURCE}`,
      "  --concurrency <N>   并发下载数 (默认 5)",
      "  -h, --help          显示帮助",
      "",
      "示例:",
      "  basedoc-dameng-fetch-docs ~/.dameng-docs",
      "  npx -y basedoc-dameng-mcp/dist/bin-fetch.js ~/.dameng-docs",
      "",
      "注意: 抓取到的内容版权属于达梦数据库股份有限公司。仅供个人或团队",
      "      内部使用，不要公开再发布。",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

interface Args {
  target: string;
  source: string;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  let target: string | undefined;
  let source = DEFAULT_SOURCE;
  let concurrency = 5;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") usage();
    else if (a === "--source") source = argv[++i] ?? usage();
    else if (a === "--concurrency") concurrency = parseInt(argv[++i] ?? "", 10) || usage();
    else if (a.startsWith("-")) {
      process.stderr.write(`未知选项: ${a}\n`);
      usage();
    } else if (!target) target = a;
    else {
      process.stderr.write(`只支持一个目标目录参数，已经是 ${target}\n`);
      usage();
    }
  }
  if (!target) usage();
  if (concurrency < 1 || concurrency > 20) {
    process.stderr.write(`concurrency 取值必须在 1–20 之间，得到 ${concurrency}\n`);
    process.exit(2);
  }
  return { target: resolve(target!), source, concurrency };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(`目标目录: ${args.target}\n`);
  process.stderr.write(`源站点: ${args.source}\n`);
  process.stderr.write(`并发: ${args.concurrency}\n\n`);

  const t0 = Date.now();
  const result = await fetchAndConvertAll({
    source: args.source,
    targetDir: args.target,
    concurrency: args.concurrency,
    onProgress: (m) => process.stderr.write(m + "\n"),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  process.stderr.write(
    `\n完成: ${result.manualCount} 本手册, ${result.chapterCount} 个章节, ${elapsed}s\n`,
  );
  if (result.failures.length > 0) {
    process.stderr.write(`\n失败 ${result.failures.length} 个章节:\n`);
    for (const f of result.failures) {
      process.stderr.write(`  ${f.url}: ${f.error}\n`);
    }
    process.stderr.write(
      `\n可以重新运行同一条命令来重试 (已成功的章节会被覆盖)。\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `\n下一步: 把 ${args.target} 当 DAMENG_DOCS_ROOT 用，例如:\n` +
      `  claude mcp add dameng \\\n` +
      `    --scope user \\\n` +
      `    -e DAMENG_DOCS_ROOT="${args.target}" \\\n` +
      `    -e DAMENG_DOCS_INCLUDE='DM8-*' \\\n` +
      `    -- npx -y basedoc-dameng-mcp\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[fetch-docs] 错误: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
