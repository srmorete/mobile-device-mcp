import { describe, test, expect, mock, spyOn } from "bun:test";
import {
  nodeAdapter,
  signalProcessTree,
  stopProcessTree,
  type Subproc,
} from "../src/server/proc";

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

describe("signalProcessTree / stopProcessTree", () => {
  test("signalProcessTree prefers process-group signal", () => {
    const killMock = spyOn(process, "kill").mockImplementation(() => true);
    const proc = {
      pid: 4242,
      exitCode: null,
      exited: new Promise<number>(() => {}),
      kill: mock(() => {}),
      stdout: null,
      stderr: null,
    } as unknown as Subproc;

    signalProcessTree(proc, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(proc.kill).not.toHaveBeenCalled();

    killMock.mockRestore();
  });

  test("signalProcessTree falls back to handle when group signal fails", () => {
    const killMock = spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const handleKill = mock(() => {});
    const proc = {
      pid: 4243,
      exitCode: null,
      exited: new Promise<number>(() => {}),
      kill: handleKill,
      stdout: null,
      stderr: null,
    } as unknown as Subproc;

    signalProcessTree(proc, "SIGKILL");
    expect(handleKill).toHaveBeenCalledWith("SIGKILL");

    killMock.mockRestore();
  });

  test("stopProcessTree is a no-op when already exited", async () => {
    const killMock = spyOn(process, "kill").mockImplementation(() => true);
    const proc = {
      pid: 1,
      exitCode: 0,
      exited: Promise.resolve(0),
      kill: mock(() => {}),
      stdout: null,
      stderr: null,
    } as unknown as Subproc;

    await stopProcessTree(proc, { graceMs: 50 });
    expect(killMock).not.toHaveBeenCalled();

    killMock.mockRestore();
  });

  test("stopProcessTree stops at SIGTERM when the child exits in time", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const state = { exitCode: null as number | null };
    const killMock = spyOn(process, "kill").mockImplementation((_pid: any, signal?: any) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        state.exitCode = 0;
        resolveExit(0);
      }
      return true;
    });
    const proc = {
      pid: 777,
      get exitCode() {
        return state.exitCode;
      },
      exited,
      kill: mock(() => {}),
      stdout: null,
      stderr: null,
    } as unknown as Subproc;

    await stopProcessTree(proc, { graceMs: 500 });
    expect(signals).toEqual(["SIGTERM"]);

    killMock.mockRestore();
  });

  test("stopProcessTree escalates to SIGKILL after graceMs", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const killMock = spyOn(process, "kill").mockImplementation((_pid: any, signal?: any) => {
      signals.push(signal);
      return true;
    });
    const proc = {
      pid: 888,
      exitCode: null,
      exited: new Promise<number>(() => {}),
      kill: mock(() => {}),
      stdout: null,
      stderr: null,
    } as unknown as Subproc;

    const started = Date.now();
    await stopProcessTree(proc, { graceMs: 50 });
    const elapsed = Date.now() - started;

    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(elapsed).toBeGreaterThanOrEqual(40);

    killMock.mockRestore();
  });
});
