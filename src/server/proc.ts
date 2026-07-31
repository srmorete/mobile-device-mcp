// Runtime-agnostic subprocess shim.
//
// The published package runs cli.js under Node, where the Bun global does not
// exist. Under Bun this delegates to Bun.spawn so test spies keep working;
// under Node it wraps child_process.spawn in the same Bun-shaped API.

import { spawn as nodeSpawn } from "child_process";
import { Readable } from "stream";

type StdioOption = "pipe" | "ignore";

export interface SpawnOptions {
  stdout?: StdioOption;
  stderr?: StdioOption;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface Subproc {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  // Node-only: set when child_process.spawn fires 'error' (ENOENT, EACCES, …).
  // Bun.spawn throws synchronously on those cases, so this stays undefined
  // under Bun.
  readonly spawnError?: Error;
  kill(signal?: number | NodeJS.Signals): void;
}

const BUN = (globalThis as { Bun?: { spawn: (cmd: string[], opts?: SpawnOptions) => Subproc; sleep: (ms: number) => Promise<void> } }).Bun;

export function spawn(cmd: string[], options: SpawnOptions = {}): Subproc {
  if (BUN) return BUN.spawn(cmd, options);
  return nodeAdapter(cmd, options);
}

export function sleep(ms: number): Promise<void> {
  if (BUN) return BUN.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nodeAdapter(cmd: string[], options: SpawnOptions = {}): Subproc {
  const [command, ...args] = cmd;
  const child = nodeSpawn(command, args, {
    // Make the child its own process-group leader so cleanup can reap the whole
    // tree via process.kill(-pid). Without this, grandchildren of
    // xcodebuild / iproxy / adb-instrumentation orphan on cleanup under Node.
    // NOTE: deliberately no child.unref() — the parent must keep waiting on it.
    detached: true,
    stdio: [
      "ignore",
      options.stdout === "ignore" ? "ignore" : "pipe",
      options.stderr === "ignore" ? "ignore" : "pipe",
    ],
    env: options.env as NodeJS.ProcessEnv | undefined,
    cwd: options.cwd,
  });

  let exitCode: number | null = null;
  let spawnError: Error | undefined;
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? 128 : 1);
      resolve(exitCode);
    });
    child.on("error", (err) => {
      spawnError = err;
      if (exitCode === null) exitCode = 1;
      resolve(exitCode);
    });
  });

  let stdoutWeb: ReadableStream<Uint8Array> | null | undefined;
  let stderrWeb: ReadableStream<Uint8Array> | null | undefined;

  return {
    get pid() { return child.pid; },
    get exitCode() { return exitCode; },
    get exited() { return exited; },
    get spawnError() { return spawnError; },
    get stdout() {
      if (stdoutWeb === undefined) {
        stdoutWeb = child.stdout ? (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>) : null;
      }
      return stdoutWeb;
    },
    get stderr() {
      if (stderrWeb === undefined) {
        stderrWeb = child.stderr ? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>) : null;
      }
      return stderrWeb;
    },
    kill(signal?: number | NodeJS.Signals) {
      child.kill(signal);
    },
  };
}

/// Deliver `signal` to the whole process group when possible (spawn() makes
/// children group leaders so grandchildren — the test runner under xcodebuild,
/// instrumentation under adb — receive it). Falls back to the process handle.
export function signalProcessTree(proc: Subproc, signal: NodeJS.Signals | number): void {
  try {
    if (proc.pid && proc.pid > 0) {
      process.kill(-proc.pid, signal);
      return;
    }
  } catch { /* group signal failed — try the handle */ }
  try { proc.kill(signal); } catch { /* already dead */ }
}

/// SIGKILL the whole process group. Prefer {@link stopProcessTree} when the
/// child deserves a chance to exit cleanly (iOS xcodebuild must detach
/// XCTest automation from SpringBoard before it dies).
export function killProcessTree(proc: Subproc): void {
  signalProcessTree(proc, "SIGKILL");
}

/** Default wait after SIGTERM before escalating to SIGKILL. */
export const PROCESS_STOP_GRACE_MS = 2_000;

/// Ask the process group to exit (SIGTERM), wait up to `graceMs` for a clean
/// exit, then SIGKILL if it is still alive. Twin of MCP SDK transport close
/// (stdin end → SIGTERM → SIGKILL): hard-killing xcodebuild mid-session has
/// been observed to crash SpringBoard inside XCTAutomationSupport.
export async function stopProcessTree(
  proc: Subproc,
  options?: { graceMs?: number },
): Promise<void> {
  if (proc.exitCode !== null) return;

  const graceMs = options?.graceMs ?? PROCESS_STOP_GRACE_MS;
  signalProcessTree(proc, "SIGTERM");

  if (proc.exitCode !== null) return;

  // `exited` stays pending until the child dies. Race it against the grace
  // window so a stubborn child cannot block MCP process shutdown forever
  // (hosts typically SIGKILL us a couple of seconds after SIGTERM).
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      proc.exited.then(() => undefined),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }

  if (proc.exitCode !== null) return;
  killProcessTree(proc);
}
