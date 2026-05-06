import { describe, expect, test } from "vitest";
import { ensureReadOnly, SqlGuardError } from "../src/sql-guard.js";

describe("ensureReadOnly", () => {
  test("accepts a plain SELECT and returns it trimmed", () => {
    expect(ensureReadOnly("  SELECT 1 FROM dual  ")).toBe("SELECT 1 FROM dual");
  });

  test("accepts SELECT regardless of case", () => {
    expect(ensureReadOnly("select * from t")).toBe("select * from t");
  });

  test("accepts WITH (CTE)", () => {
    expect(ensureReadOnly("WITH x AS (SELECT 1 FROM dual) SELECT * FROM x")).toMatch(/^WITH/);
  });

  test("accepts EXPLAIN", () => {
    expect(ensureReadOnly("EXPLAIN SELECT 1 FROM dual")).toMatch(/^EXPLAIN/);
  });

  test("strips a single trailing semicolon", () => {
    expect(ensureReadOnly("SELECT 1 FROM dual;")).toBe("SELECT 1 FROM dual");
  });

  test("ignores leading line comments before classifying", () => {
    expect(ensureReadOnly("-- audit note\nSELECT 1 FROM dual")).toMatch(/SELECT 1/);
  });

  test("ignores leading block comments before classifying", () => {
    expect(ensureReadOnly("/* hint */ SELECT 1 FROM dual")).toMatch(/SELECT 1/);
  });

  test("rejects empty input", () => {
    expect(() => ensureReadOnly("")).toThrow(SqlGuardError);
    expect(() => ensureReadOnly("   \n\t  ")).toThrow(SqlGuardError);
  });

  test.each([
    ["UPDATE", "UPDATE t SET a=1"],
    ["DELETE", "DELETE FROM t"],
    ["INSERT", "INSERT INTO t VALUES (1)"],
    ["MERGE", "MERGE INTO t USING s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET a=1"],
    ["TRUNCATE", "TRUNCATE TABLE t"],
    ["DROP", "DROP TABLE t"],
    ["CREATE", "CREATE TABLE t(a INT)"],
    ["ALTER", "ALTER TABLE t ADD b INT"],
    ["GRANT", "GRANT SELECT ON t TO u"],
    ["REVOKE", "REVOKE SELECT ON t FROM u"],
    ["CALL", "CALL SP_SET_PARA_VALUE(1,'X',0)"],
    ["BEGIN", "BEGIN UPDATE t SET a=1; END;"],
    ["DECLARE", "DECLARE x INT; BEGIN x:=1; END;"],
    ["SET", "SET SCHEMA SYS"],
    ["COMMIT", "COMMIT"],
    ["ROLLBACK", "ROLLBACK"],
  ])("rejects %s statements", (_label, sql) => {
    expect(() => ensureReadOnly(sql)).toThrow(SqlGuardError);
  });

  test("rejects multi-statement input even if both are SELECT", () => {
    expect(() => ensureReadOnly("SELECT 1 FROM dual; SELECT 2 FROM dual")).toThrow(SqlGuardError);
  });

  test("rejects sneaky DML hidden after a comment-stripped SELECT", () => {
    // The classifier should only look at the first statement, but multi-statement
    // detection must still trip on the trailing UPDATE.
    expect(() => ensureReadOnly("SELECT 1 FROM dual; UPDATE t SET a=1")).toThrow(SqlGuardError);
  });

  test("rejects keyword that only looks like SELECT (e.g. SELECTED)", () => {
    expect(() => ensureReadOnly("SELECTED * FROM t")).toThrow(SqlGuardError);
  });

  test("error includes the first keyword it rejected", () => {
    try {
      ensureReadOnly("DROP TABLE t");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SqlGuardError);
      expect((e as Error).message).toMatch(/DROP/i);
    }
  });
});
