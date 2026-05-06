import { describe, expect, test } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

const baseEnv = {
  DAMENG_HOST: "dameng.example.test",
  DAMENG_PORT: "5236",
  DAMENG_USER: "MCP_RO",
  DAMENG_PASSWORD: "s3cret",
};

describe("loadConfig", () => {
  test("parses all required fields and applies defaults", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.host).toBe("dameng.example.test");
    expect(cfg.port).toBe(5236);
    expect(cfg.user).toBe("MCP_RO");
    expect(cfg.password).toBe("s3cret");
    expect(cfg.schema).toBeUndefined();
    expect(cfg.queryTimeoutMs).toBe(10_000);
    expect(cfg.maxRows).toBe(1000);
    expect(cfg.poolMin).toBe(1);
    expect(cfg.poolMax).toBe(4);
  });

  test("respects optional overrides", () => {
    const cfg = loadConfig({
      ...baseEnv,
      DAMENG_SCHEMA: "GZKJ",
      DAMENG_QUERY_TIMEOUT_MS: "30000",
      DAMENG_MAX_ROWS: "5000",
      DAMENG_POOL_MIN: "2",
      DAMENG_POOL_MAX: "8",
    });
    expect(cfg.schema).toBe("GZKJ");
    expect(cfg.queryTimeoutMs).toBe(30_000);
    expect(cfg.maxRows).toBe(5000);
    expect(cfg.poolMin).toBe(2);
    expect(cfg.poolMax).toBe(8);
  });

  test("docsRoot is undefined when DAMENG_DOCS_ROOT is unset", () => {
    expect(loadConfig({ ...baseEnv }).docsRoot).toBeUndefined();
  });

  test("docsRoot is normalized to an absolute path when set", () => {
    const cfg = loadConfig({ ...baseEnv, DAMENG_DOCS_ROOT: "/opt/dameng/docs" });
    expect(cfg.docsRoot).toBe("/opt/dameng/docs");
  });

  test("docsRoot rejects relative paths", () => {
    expect(() =>
      loadConfig({ ...baseEnv, DAMENG_DOCS_ROOT: "relative/dir" }),
    ).toThrow(ConfigError);
  });

  test("docsInclude/Exclude default to empty arrays", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.docsInclude).toEqual([]);
    expect(cfg.docsExclude).toEqual([]);
  });

  test("docsInclude parses comma-separated patterns and trims whitespace", () => {
    const cfg = loadConfig({
      ...baseEnv,
      DAMENG_DOCS_INCLUDE: "DM8-* , SQL优化, openspec",
    });
    expect(cfg.docsInclude).toEqual(["DM8-*", "SQL优化", "openspec"]);
  });

  test("docsExclude parses comma-separated patterns", () => {
    const cfg = loadConfig({ ...baseEnv, DAMENG_DOCS_EXCLUDE: "dameng-mcp,售前" });
    expect(cfg.docsExclude).toEqual(["dameng-mcp", "售前"]);
  });

  test.each(["DAMENG_HOST", "DAMENG_PORT", "DAMENG_USER", "DAMENG_PASSWORD"])(
    "throws ConfigError when %s is missing",
    (key) => {
      const env = { ...baseEnv } as Record<string, string>;
      delete env[key];
      expect(() => loadConfig(env)).toThrow(ConfigError);
    },
  );

  test("does NOT default the password to SYSDBA or anything else (docs-only path)", () => {
    // In docs-only mode (no DB env), password must remain unset — never
    // fall back to a hardcoded value like SYSDBA. The DB tools simply aren't
    // registered in this case.
    const cfg = loadConfig({ DAMENG_DOCS_ROOT: "/opt/dameng/docs" });
    expect(cfg.password).toBe("");
    expect(cfg.host).toBe("");
  });

  test("requires either full DB env OR DAMENG_DOCS_ROOT", () => {
    expect(() => loadConfig({})).toThrow(/DOCS_ROOT|credentials/);
  });

  test("rejects non-numeric port", () => {
    expect(() => loadConfig({ ...baseEnv, DAMENG_PORT: "abc" })).toThrow(ConfigError);
  });

  test("rejects negative timeout", () => {
    expect(() =>
      loadConfig({ ...baseEnv, DAMENG_QUERY_TIMEOUT_MS: "-1" }),
    ).toThrow(ConfigError);
  });

  test("rejects maxRows of 0 or negative", () => {
    expect(() => loadConfig({ ...baseEnv, DAMENG_MAX_ROWS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, DAMENG_MAX_ROWS: "-5" })).toThrow(ConfigError);
  });
});
