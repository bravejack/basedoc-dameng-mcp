import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import TurndownService from "turndown";

export interface Chapter {
  href: string;
  title: string;
}

export interface ManualGroup {
  manual: string;
  chapters: Chapter[];
}

const ICONFONT_RANGE = /[-]/g;

const HTML_ICONFONT_ENTITY = /&#x[eE][0-9a-fA-F]{3};/g;

export function normalizeManualName(raw: string): string {
  return raw
    .replace(HTML_ICONFONT_ENTITY, "")
    .replace(ICONFONT_RANGE, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^DM8\s+/, "DM8-");
}

export function parseManualsFromSidebar(html: string): ManualGroup[] {
  // Each manual is rendered as `<div class="left-sidebar-link-group top" ...>`
  // The literal string `left-sidebar-link-group` also appears inside <script>
  // blocks for the toggle animation; we anchor to the `top` modifier so we
  // only match the actual HTML wrappers.
  const blockRe = /<div\s+class="left-sidebar-link-group top"[^>]*>/g;
  const positions: number[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = blockRe.exec(html)) !== null) positions.push(mm.index);

  const out: ManualGroup[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i]!;
    const end = i + 1 < positions.length ? positions[i + 1]! : html.length;
    let block = html.slice(start, end);
    // Bound to the closing of this group's container — the `bar-border`
    // separator that always follows a finished group.
    const closeAt = block.search(/<div\s+class="bar-border"/);
    if (closeAt > 0) block = block.slice(0, closeAt);

    // Manual name is the first font-weight:800 anchor in the block.
    const titleMatch = block.match(
      /<a[^>]*font-weight:\s*800;?[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!titleMatch) continue;
    const rawTitle = titleMatch[1]!.replace(/<[^>]+>/g, "");
    const manual = normalizeManualName(rawTitle);
    if (!manual.startsWith("DM8-")) continue;

    const chapters: Chapter[] = [];
    const chapterRe = /<a[^>]*href="([^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = chapterRe.exec(block)) !== null) {
      const href = m[1]!;
      if (!href.endsWith(".html") || href.includes("/") || href.includes(":")) continue;
      const title = m[2]!.replace(/<[^>]+>/g, "").replace(ICONFONT_RANGE, "").trim();
      if (!title) continue;
      chapters.push({ href, title });
    }
    if (chapters.length > 0) out.push({ manual, chapters });
  }
  return out;
}

export function extractArticleHtml(html: string): string {
  // The eco.dameng.com pages wrap the actual chapter content in
  //   <div class="article-content vditor-reset" ...> ... </div>
  // followed by a <footer class="article-footer"> we want to drop.
  const m = html.match(
    /<div\s+class="article-content[^"]*"[^>]*>([\s\S]*?)<(?:footer|div|aside)[^>]*\sclass="article-footer/,
  );
  return m ? m[1]!.trim() : "";
}

let _turndown: TurndownService | null = null;
function turndown(): TurndownService {
  if (_turndown) return _turndown;
  const t = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });
  // Drop the inline anchor links Hexo adds after every heading.
  t.addRule("strip-article-anchor", {
    filter: (node) =>
      node.nodeName === "A" &&
      ((node as HTMLElement).getAttribute("class") || "").includes("article-anchor"),
    replacement: () => "",
  });
  // Drop "copy code" buttons commonly added by docs sites.
  t.addRule("strip-copy-button", {
    filter: (node) =>
      node.nodeName === "BUTTON" ||
      ((node as HTMLElement).getAttribute("class") || "").includes("copy"),
    replacement: () => "",
  });
  _turndown = t;
  return t;
}

export function htmlToMarkdown(html: string): string {
  return turndown().turndown(html).trim() + "\n";
}

export interface FetchOpts {
  source: string; // base URL e.g. https://eco.dameng.com/document/dm/zh-cn/pm/
  targetDir: string;
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

export interface FetchResult {
  manualCount: number;
  chapterCount: number;
  failures: { url: string; error: string }[];
}

export async function fetchAndConvertAll(opts: FetchOpts): Promise<FetchResult> {
  const concurrency = opts.concurrency ?? 5;
  const log = opts.onProgress ?? (() => {});
  const baseUrl = opts.source.endsWith("/") ? opts.source : opts.source + "/";

  log(`fetching index: ${baseUrl}`);
  const indexHtml = await fetchText(baseUrl);
  const manuals = parseManualsFromSidebar(indexHtml);
  if (manuals.length === 0) {
    throw new Error(`No manuals found in sidebar at ${baseUrl}. Did the site structure change?`);
  }
  log(`found ${manuals.length} manuals, ${manuals.reduce((n, m) => n + m.chapters.length, 0)} chapters total`);

  await mkdir(opts.targetDir, { recursive: true });
  await writeFile(
    join(opts.targetDir, "README.md"),
    `# Dameng manuals (auto-fetched)\n\nGenerated from ${baseUrl} at ${new Date().toISOString()}.\n\nCopyright belongs to 达梦数据库股份有限公司. Kept locally for personal/team reference.\n`,
    "utf8",
  );

  const tasks: { manual: string; chapter: Chapter; url: string; outPath: string }[] = [];
  for (const group of manuals) {
    const dir = join(opts.targetDir, group.manual);
    await mkdir(dir, { recursive: true });
    for (const ch of group.chapters) {
      tasks.push({
        manual: group.manual,
        chapter: ch,
        url: baseUrl + ch.href,
        outPath: join(dir, ch.href.replace(/\.html$/, ".md")),
      });
    }
  }

  const failures: FetchResult["failures"] = [];
  let completed = 0;
  const total = tasks.length;

  async function worker(slice: typeof tasks) {
    for (const t of slice) {
      try {
        const html = await fetchText(t.url);
        const article = extractArticleHtml(html);
        if (!article) throw new Error("no article body in HTML");
        const md = `# ${t.chapter.title}\n\n` + htmlToMarkdown(article);
        await writeFile(t.outPath, md, "utf8");
      } catch (e) {
        failures.push({ url: t.url, error: e instanceof Error ? e.message : String(e) });
      }
      completed++;
      if (completed % 10 === 0 || completed === total) {
        log(`  [${completed}/${total}] ${t.manual} :: ${t.chapter.title}`);
      }
    }
  }

  // Slice tasks evenly across workers.
  const slices: typeof tasks[] = Array.from({ length: concurrency }, () => []);
  tasks.forEach((t, i) => slices[i % concurrency]!.push(t));
  await Promise.all(slices.map((s) => worker(s)));

  return {
    manualCount: manuals.length,
    chapterCount: tasks.length,
    failures,
  };
}

async function fetchText(url: string, retries = 2): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "basedoc-dameng-mcp/0.1.2 (+https://github.com/bravejack/basedoc-dameng-mcp)",
          "Accept": "text/html",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
