import { describe, expect, test } from "vitest";
import { withTimeout, TimeoutError } from "../src/with-timeout.js";

describe("withTimeout", () => {
  test("resolves with the inner value when the promise wins", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 100, "demo");
    expect(result).toBe("ok");
  });

  test("rejects with TimeoutError when the promise loses", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(slow, 30, "demo-op")).rejects.toBeInstanceOf(TimeoutError);
  });

  test("includes the label and timeout in the error message", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(slow, 30, "fetch-rows")).rejects.toThrow(/fetch-rows.*30/);
  });

  test("invokes onTimeout callback when timing out", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    let called = false;
    await expect(
      withTimeout(slow, 30, "x", () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(called).toBe(true);
  });

  test("propagates inner rejection unchanged", async () => {
    const err = new Error("boom");
    await expect(withTimeout(Promise.reject(err), 100, "x")).rejects.toBe(err);
  });
});
