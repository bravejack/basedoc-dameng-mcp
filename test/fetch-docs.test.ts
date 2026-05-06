import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseManualsFromSidebar,
  normalizeManualName,
  extractArticleHtml,
  htmlToMarkdown,
} from "../src/fetch-docs.js";

const ECO_PAGE_HTML = readFileSync(
  join(__dirname, "fixtures", "eco-page.html"),
  "utf8",
);

describe("normalizeManualName", () => {
  test("converts 'DM8 系统管理员手册' → 'DM8-系统管理员手册'", () => {
    expect(normalizeManualName("DM8 系统管理员手册")).toBe("DM8-系统管理员手册");
  });

  test("collapses multiple spaces", () => {
    expect(normalizeManualName("DM8   数据守护与读写分离集群")).toBe(
      "DM8-数据守护与读写分离集群",
    );
  });

  test("strips trailing iconfont placeholder characters (e.g. \\ue6a0)", () => {
    expect(normalizeManualName("DM8 安全管理")).toBe("DM8-安全管理");
  });

  test("trims whitespace", () => {
    expect(normalizeManualName("  DM8 安装手册  ")).toBe("DM8-安装手册");
  });
});

describe("parseManualsFromSidebar", () => {
  test("extracts all 22 manuals from the live eco.dameng.com sidebar", () => {
    const manuals = parseManualsFromSidebar(ECO_PAGE_HTML);
    expect(manuals.length).toBeGreaterThanOrEqual(22);
  });

  test("each manual has a normalized name and at least one chapter", () => {
    const manuals = parseManualsFromSidebar(ECO_PAGE_HTML);
    for (const m of manuals) {
      expect(m.manual).toMatch(/^DM8-/);
      expect(m.chapters.length).toBeGreaterThan(0);
    }
  });

  test("chapters carry a relative .html href and a Chinese title", () => {
    const manuals = parseManualsFromSidebar(ECO_PAGE_HTML);
    const dataguard = manuals.find((m) => m.manual === "DM8-数据守护与读写分离集群");
    expect(dataguard).toBeDefined();
    const overview = dataguard!.chapters.find((c) => c.title === "概述");
    expect(overview?.href).toBe("data-watch-overview.html");
  });

  test("includes the security manual with expected chapter count", () => {
    const manuals = parseManualsFromSidebar(ECO_PAGE_HTML);
    const sec = manuals.find((m) => m.manual === "DM8-安全管理");
    expect(sec).toBeDefined();
    // The security manual on eco has 14 chapters (matches the local mirror).
    expect(sec!.chapters.length).toBeGreaterThanOrEqual(10);
  });

  test("returns an empty array on completely unrelated HTML", () => {
    expect(parseManualsFromSidebar("<html><body>nothing</body></html>")).toEqual([]);
  });
});

describe("extractArticleHtml", () => {
  test("returns just the article body, not the page chrome", () => {
    const article = extractArticleHtml(ECO_PAGE_HTML);
    expect(article).toBeTruthy();
    expect(article).toMatch(/通信加密|6\.1|6\.2/);
    // Should NOT contain the sidebar markup with all 22 manuals
    expect(article).not.toContain("DM8 数据守护与读写分离集群");
    expect(article).not.toContain("left-sidebar-link-group");
  });

  test("returns empty string when no article element is found", () => {
    expect(extractArticleHtml("<html><body><p>x</p></body></html>")).toBe("");
  });
});

describe("htmlToMarkdown", () => {
  test("converts a simple article to Markdown headings + paragraphs", () => {
    const md = htmlToMarkdown(
      "<article><h1>标题</h1><p>段落一</p><h2>小节</h2><p>段落二</p></article>",
    );
    expect(md).toMatch(/^#\s+标题/m);
    expect(md).toMatch(/^##\s+小节/m);
    expect(md).toContain("段落一");
    expect(md).toContain("段落二");
  });

  test("strips the inline anchor links Hexo adds after each heading", () => {
    const md = htmlToMarkdown(
      '<article><h2>6.1 SSL <a class="article-anchor" href="#x" aria-hidden="true"></a></h2><p>body</p></article>',
    );
    expect(md).not.toContain("article-anchor");
    expect(md).not.toContain("aria-hidden");
    expect(md).toMatch(/##\s+6\.1 SSL/);
  });

  test("preserves code blocks", () => {
    const md = htmlToMarkdown(
      "<article><pre><code>SELECT 1 FROM dual;</code></pre></article>",
    );
    expect(md).toContain("SELECT 1 FROM dual;");
    expect(md).toMatch(/```/);
  });
});
