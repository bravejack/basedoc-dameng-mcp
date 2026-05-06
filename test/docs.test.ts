import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  searchDocs,
  DocsSearchError,
  listManuals,
  listSections,
  readSection,
} from "../src/docs.js";

let root: string;

function file(rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dameng-docs-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("searchDocs", () => {
  test("returns one section with the match line and surrounding context", async () => {
    file(
      "manual-a/01-intro.md",
      ["# Intro", "before line", "This is about V$INSTANCE in Dameng.", "after line"].join("\n"),
    );

    const sections = await searchDocs({ root, query: "V$INSTANCE" });

    expect(sections).toHaveLength(1);
    expect(sections[0]!.file).toBe("manual-a/01-intro.md");
    expect(sections[0]!.manual).toBe("manual-a");
    expect(sections[0]!.matchCount).toBe(1);
    expect(sections[0]!.matches).toHaveLength(1);
    expect(sections[0]!.matches[0]!.line).toBe(3);
    expect(sections[0]!.matches[0]!.text).toContain("V$INSTANCE");
    expect(sections[0]!.matches[0]!.contextBefore).toBe("before line");
    expect(sections[0]!.matches[0]!.contextAfter).toBe("after line");
  });

  test("literal search is case-insensitive", async () => {
    file("a/x.md", "select * from t");
    const sections = await searchDocs({ root, query: "SELECT" });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.matches).toHaveLength(1);
  });

  test("attaches the nearest preceding heading", async () => {
    file(
      "a/x.md",
      [
        "# Top",
        "",
        "## V$INSTANCE",
        "",
        "Records the running state of the instance.",
      ].join("\n"),
    );

    const [s] = await searchDocs({ root, query: "running state" });
    expect(s!.heading).toBe("## V$INSTANCE");
  });

  test("falls back to no heading when match precedes any heading", async () => {
    file("a/x.md", "preface text\n# Heading\nbody");
    const [s] = await searchDocs({ root, query: "preface" });
    expect(s!.heading).toBeUndefined();
  });

  test("walks subdirectories and reports manual = top-level dir", async () => {
    file("manual-a/sub/01.md", "alpha");
    file("manual-b/02.md", "alpha");
    const sections = await searchDocs({ root, query: "alpha" });
    expect(sections.map((s) => s.manual).sort()).toEqual(["manual-a", "manual-b"]);
  });

  test("ignores non-.md files", async () => {
    file("a/01.md", "alpha");
    file("a/02.txt", "alpha");
    file("a/03.pdf", "alpha");
    const sections = await searchDocs({ root, query: "alpha" });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.file).toBe("a/01.md");
  });

  test("groups multiple matches under the same heading into one section", async () => {
    file("a/x.md", "## Topic\nfoo bar\nfoo baz\nother\nfoo qux");
    const [s] = await searchDocs({ root, query: "foo" });
    expect(s!.heading).toBe("## Topic");
    expect(s!.matchCount).toBe(3);
    expect(s!.matches.map((m) => m.line)).toEqual([2, 3, 5]);
  });

  test("splits matches under different headings into separate sections", async () => {
    file("a/x.md", "# A\nfoo\n# B\nfoo\nfoo");
    const sections = await searchDocs({ root, query: "foo" });
    expect(sections).toHaveLength(2);
  });

  test("sections are sorted by matchCount desc (most-relevant first)", async () => {
    file("a/x.md", "## Few\nfoo\n## Many\nfoo\nfoo\nfoo");
    const sections = await searchDocs({ root, query: "foo" });
    expect(sections[0]!.heading).toBe("## Many");
    expect(sections[0]!.matchCount).toBe(3);
    expect(sections[1]!.heading).toBe("## Few");
    expect(sections[1]!.matchCount).toBe(1);
  });

  test("contextBefore is undefined for a match on the first line", async () => {
    file("a/x.md", "alpha is here\nmore");
    const [s] = await searchDocs({ root, query: "alpha" });
    expect(s!.matches[0]!.contextBefore).toBeUndefined();
    expect(s!.matches[0]!.contextAfter).toBe("more");
  });

  test("contextAfter is undefined for a match on the last line", async () => {
    file("a/x.md", "first\nalpha at end");
    const [s] = await searchDocs({ root, query: "alpha" });
    expect(s!.matches[0]!.contextBefore).toBe("first");
    expect(s!.matches[0]!.contextAfter).toBeUndefined();
  });

  test("manual filter restricts to that top-level dir", async () => {
    file("manual-a/01.md", "needle");
    file("manual-b/02.md", "needle");
    const sections = await searchDocs({ root, query: "needle", manual: "manual-a" });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.manual).toBe("manual-a");
  });

  test.each(["..", "../etc", "a/b", "/abs"])(
    "manual filter %s rejects unsafe input",
    async (manual) => {
      file("a/01.md", "x");
      await expect(searchDocs({ root, query: "x", manual })).rejects.toBeInstanceOf(
        DocsSearchError,
      );
    },
  );

  test("manual filter accepts dir names with spaces", async () => {
    file("DM8-Linux 脚本使用手册/01.md", "alpha");
    const sections = await searchDocs({
      root,
      query: "alpha",
      manual: "DM8-Linux 脚本使用手册",
    });
    expect(sections).toHaveLength(1);
  });

  test("manual filter for nonexistent dir returns empty (not throw)", async () => {
    file("manual-a/01.md", "x");
    const sections = await searchDocs({ root, query: "x", manual: "missing" });
    expect(sections).toEqual([]);
  });

  test("regex mode matches by pattern", async () => {
    file("a/x.md", "Version 2.5.7 released");
    const sections = await searchDocs({
      root,
      query: "Version \\d+\\.\\d+",
      regex: true,
    });
    expect(sections).toHaveLength(1);
  });

  test("regex mode throws DocsSearchError on invalid regex", async () => {
    file("a/x.md", "anything");
    await expect(
      searchDocs({ root, query: "[unclosed", regex: true }),
    ).rejects.toBeInstanceOf(DocsSearchError);
  });

  test("maxMatches caps total match lines across all sections", async () => {
    file("a/x.md", "alpha\nalpha\nalpha\nalpha\nalpha");
    const sections = await searchDocs({ root, query: "alpha", maxMatches: 2 });
    const total = sections.reduce((sum, s) => sum + s.matches.length, 0);
    expect(total).toBe(2);
  });

  test("returns empty when nothing matches", async () => {
    file("a/x.md", "alpha");
    const sections = await searchDocs({ root, query: "omega" });
    expect(sections).toEqual([]);
  });

  test("throws when root does not exist", async () => {
    await expect(searchDocs({ root: "/nonexistent/path/zzz", query: "x" })).rejects.toBeInstanceOf(
      DocsSearchError,
    );
  });

  test("include filter (literal name) restricts to listed top-level dirs", async () => {
    file("DM8-A/01.md", "alpha");
    file("DM8-B/01.md", "alpha");
    file("misc/01.md", "alpha");
    const sections = await searchDocs({
      root,
      query: "alpha",
      include: ["DM8-A", "DM8-B"],
    });
    expect(sections.map((s) => s.manual).sort()).toEqual(["DM8-A", "DM8-B"]);
  });

  test("include filter supports * glob", async () => {
    file("DM8-A/01.md", "alpha");
    file("DM8-B/01.md", "alpha");
    file("openspec/01.md", "alpha");
    const sections = await searchDocs({ root, query: "alpha", include: ["DM8-*"] });
    expect(sections.every((s) => s.manual.startsWith("DM8-"))).toBe(true);
    expect(sections).toHaveLength(2);
  });

  test("exclude filter removes listed top-level dirs", async () => {
    file("DM8-A/01.md", "alpha");
    file("dameng-mcp/01.md", "alpha");
    const sections = await searchDocs({
      root,
      query: "alpha",
      exclude: ["dameng-mcp"],
    });
    expect(sections.map((s) => s.manual)).toEqual(["DM8-A"]);
  });

  test("node_modules is always excluded even when include matches", async () => {
    file("DM8-A/node_modules/some-pkg/README.md", "alpha");
    file("DM8-A/01.md", "alpha");
    const sections = await searchDocs({ root, query: "alpha", include: ["DM8-*"] });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.file).toBe("DM8-A/01.md");
  });
});

describe("listManuals", () => {
  test("returns top-level dirs that contain at least one .md, sorted", async () => {
    file("DM8-A/01.md", "x");
    file("DM8-B/01.md", "x");
    file("empty-dir/keep.txt", "x");
    const manuals = await listManuals({ root });
    expect(manuals.map((m) => m.manual)).toEqual(["DM8-A", "DM8-B"]);
  });

  test("reports fileCount per manual", async () => {
    file("DM8-A/01.md", "x");
    file("DM8-A/sub/02.md", "x");
    file("DM8-B/01.md", "x");
    const manuals = await listManuals({ root });
    expect(manuals.find((m) => m.manual === "DM8-A")!.fileCount).toBe(2);
    expect(manuals.find((m) => m.manual === "DM8-B")!.fileCount).toBe(1);
  });

  test("uses 00-目录索引.md content as indexSummary if present (truncated)", async () => {
    file(
      "DM8-A/00-目录索引.md",
      "# 目录\n- 第1章 概述\n- 第2章 安装\n- 第3章 使用",
    );
    file("DM8-A/01.md", "x");
    const [m] = await listManuals({ root });
    expect(m!.indexSummary).toContain("目录");
    expect(m!.indexSummary).toContain("第1章");
  });

  test("falls back to README.md if no 00-目录索引.md", async () => {
    file("DM8-A/README.md", "# README\nOverview line");
    file("DM8-A/01.md", "x");
    const [m] = await listManuals({ root });
    expect(m!.indexSummary).toContain("README");
  });

  test("indexSummary is undefined when neither index file exists", async () => {
    file("DM8-A/chapter.md", "# H\nbody");
    const [m] = await listManuals({ root });
    expect(m!.indexSummary).toBeUndefined();
  });

  test("honors include/exclude and always-excludes node_modules", async () => {
    file("DM8-A/01.md", "x");
    file("dameng-mcp/01.md", "x");
    file("DM8-A/node_modules/pkg/README.md", "x");
    const manuals = await listManuals({
      root,
      include: ["DM8-*"],
      exclude: ["dameng-mcp"],
    });
    expect(manuals.map((m) => m.manual)).toEqual(["DM8-A"]);
  });

  test("throws when root does not exist", async () => {
    await expect(listManuals({ root: "/nonexistent/zzz" })).rejects.toBeInstanceOf(DocsSearchError);
  });
});

describe("listSections", () => {
  test("returns each .md file in a manual with its H1/H2 headings", async () => {
    file(
      "DM8-A/01-intro.md",
      "# Chapter 1\n\nbody\n\n## 1.1 Section\n\nbody\n\n### 1.1.1 sub\n\nbody",
    );
    file("DM8-A/02-other.md", "# Chapter 2\n## 2.1 Topic");
    const result = await listSections({ root, manual: "DM8-A" });
    const f1 = result.find((f) => f.file === "DM8-A/01-intro.md")!;
    expect(f1.headings.map((h) => h.text)).toEqual(["Chapter 1", "1.1 Section"]);
    expect(f1.headings[0]!.level).toBe(1);
    expect(f1.headings[1]!.level).toBe(2);
  });

  test("returns line numbers for each heading", async () => {
    file("DM8-A/x.md", "preamble\n# H1\nbody\n## H2\nbody");
    const [f] = await listSections({ root, manual: "DM8-A" });
    expect(f!.headings[0]).toMatchObject({ level: 1, text: "H1", line: 2 });
    expect(f!.headings[1]).toMatchObject({ level: 2, text: "H2", line: 4 });
  });

  test("includes files with no H1/H2 (empty headings array)", async () => {
    file("DM8-A/x.md", "no headings here\njust text");
    const [f] = await listSections({ root, manual: "DM8-A" });
    expect(f!.headings).toEqual([]);
  });

  test("walks subdirectories within a manual", async () => {
    file("DM8-A/sub/01.md", "# Top");
    const result = await listSections({ root, manual: "DM8-A" });
    expect(result.map((f) => f.file)).toEqual(["DM8-A/sub/01.md"]);
  });

  test("returns empty when manual does not exist", async () => {
    file("DM8-A/x.md", "# H");
    const result = await listSections({ root, manual: "DM8-MISSING" });
    expect(result).toEqual([]);
  });

  test("rejects unsafe manual name", async () => {
    file("DM8-A/x.md", "x");
    await expect(listSections({ root, manual: ".." })).rejects.toBeInstanceOf(DocsSearchError);
    await expect(listSections({ root, manual: "a/b" })).rejects.toBeInstanceOf(DocsSearchError);
  });
});

describe("readSection", () => {
  test("returns the whole file when no heading is given", async () => {
    file("DM8-A/x.md", "# Top\nbody1\n## Sub\nbody2");
    const r = await readSection({ root, file: "DM8-A/x.md" });
    expect(r.content).toBe("# Top\nbody1\n## Sub\nbody2");
    expect(r.heading).toBeUndefined();
    expect(r.truncated).toBe(false);
  });

  test("extracts content from heading until next same-level heading", async () => {
    file(
      "DM8-A/x.md",
      [
        "# Top",
        "intro",
        "## 9.1 升级",
        "step 1",
        "step 2",
        "## 9.2 回滚",
        "rollback",
      ].join("\n"),
    );
    const r = await readSection({ root, file: "DM8-A/x.md", heading: "9.1 升级" });
    expect(r.heading).toBe("9.1 升级");
    expect(r.content).toBe("## 9.1 升级\nstep 1\nstep 2");
  });

  test("extracts content from heading until next higher-level heading", async () => {
    file(
      "DM8-A/x.md",
      ["## 1 First", "body", "### 1.1 Sub", "subbody", "## 2 Second"].join("\n"),
    );
    const r = await readSection({ root, file: "DM8-A/x.md", heading: "1 First" });
    expect(r.content).toContain("body");
    expect(r.content).toContain("### 1.1 Sub");
    expect(r.content).not.toContain("2 Second");
  });

  test("matches heading text ignoring trailing anchor link", async () => {
    file("DM8-A/x.md", "## 9.1 升级[](#9-1-升级)\nbody\n## 9.2");
    const r = await readSection({ root, file: "DM8-A/x.md", heading: "9.1 升级" });
    expect(r.content).toContain("body");
  });

  test("throws when heading not found", async () => {
    file("DM8-A/x.md", "## A\n## B");
    await expect(
      readSection({ root, file: "DM8-A/x.md", heading: "missing" }),
    ).rejects.toBeInstanceOf(DocsSearchError);
  });

  test("throws when file does not exist", async () => {
    await expect(readSection({ root, file: "DM8-A/none.md" })).rejects.toBeInstanceOf(
      DocsSearchError,
    );
  });

  test.each(["..", "../etc/passwd", "/abs/path", "x y"])(
    "rejects unsafe file path %s",
    async (path) => {
      await expect(readSection({ root, file: path })).rejects.toBeInstanceOf(DocsSearchError);
    },
  );

  test("rejects file path that escapes root via segment", async () => {
    file("DM8-A/x.md", "x");
    await expect(
      readSection({ root, file: "DM8-A/../../etc/passwd" }),
    ).rejects.toBeInstanceOf(DocsSearchError);
  });

  test("rejects non-.md files", async () => {
    file("DM8-A/x.txt", "x");
    await expect(readSection({ root, file: "DM8-A/x.txt" })).rejects.toBeInstanceOf(
      DocsSearchError,
    );
  });

  test("truncates when content exceeds maxBytes", async () => {
    file("DM8-A/x.md", "# Top\n" + "a".repeat(2000));
    const r = await readSection({ root, file: "DM8-A/x.md", maxBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(110);
  });
});
