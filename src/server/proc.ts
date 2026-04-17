// Runtime-agnostic subprocess shim.
//
// The published package ships a Node-bundled cli.js (shebang `#!/usr/bin/env node`),
// but `Bun.spawn` is a Bun-only runtime global that `bun build --target node` does
// not polyfill. Without this shim, every `Bun.spawn(...)` call throws
// `ReferenceError: Bun is not defined` under `npx`, and `discoverAndroid` swallows
// the error into `[]` — which is the bug reported in issue #2.
//
// Under Bun this delegates to `Bun.spawn` so test spies on `Bun.spawn` keep working.
// Under Node it wraps `child_process.spawn` in the Bun-shaped API the callers use.

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

function nodeAdapter(cmd: string[], options: SpawnOptions): Subproc {
  const [command, ...args] = cmd;
  const child = nodeSpawn(command, args, {
    stdio: [
      "ignore",
      options.stdout === "ignore" ? "ignore" : "pipe",
      options.stderr === "ignore" ? "ignore" : "pipe",
    ],
    env: options.env as NodeJS.ProcessEnv | undefined,
    cwd: options.cwd,
  });

  let exitCode: number | null = null;
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? 128 : 1);
      resolve(exitCode);
    });
    child.on("error", () => {
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
      child.kill(signal as NodeJS.Signals);
    },
  };
}
