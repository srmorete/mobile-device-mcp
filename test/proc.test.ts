import { describe, test, expect } from "bun:test";
import { nodeAdapter } from "../src/server/proc";

// nodeAdapter is the Node-only path that the published cli.js runs through
// (the bundle has no Bun runtime). Tests for the Bun synchronous-throw path
// live in devices.test.ts. These tests exercise the real child_process flow.

describe("nodeAdapter", () => {
  test("exposes spawnError when binary is missing", async () => {
    // The exact message differs across runtimes ("spawn X ENOENT" on Node,
    // "Executable not found in $PATH" on Bun's child_process polyfill), but
    // both surface the binary name and resolve `exited` rather than rejecting.
    const proc = nodeAdapter(["__definitely_not_a_real_binary_42__"]);
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(proc.spawnError).toBeDefined();
    expect(proc.spawnError!.message).toContain("__definitely_not_a_real_binary_42__");
  });

  test("resolves exitCode 0 for successful command", async () => {
    const proc = nodeAdapter(["true"], { stdout: "ignore", stderr: "ignore" });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(proc.spawnError).toBeUndefined();
  });

  test("resolves non-zero exitCode for failing command", async () => {
    const proc = nodeAdapter(["false"], { stdout: "ignore", stderr: "ignore" });
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(proc.spawnError).toBeUndefined();
  });

  test("captures stdout and stderr", async () => {
    const proc = nodeAdapter(["sh", "-c", "echo out; echo err 1>&2"]);
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("out\n");
    expect(stderr).toBe("err\n");
  });
});
