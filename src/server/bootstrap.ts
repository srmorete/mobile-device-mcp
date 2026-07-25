import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import type { RegisteredDevice, DeviceType } from "./types.js";
import { spawn, sleep, killProcessTree, type Subproc } from "./proc.js";
import {
  getDevice,
  setDevice,
  removeDevice,
  cleanupDevice,
  detectPlatform,
} from "./devices.js";
import {
  allocateAndroidPort,
  allocateIOSPort,
  addPendingPort,
  releasePendingPort,
  unlockPort,
  cleanupStalePorts,
} from "./ports.js";

// Driver servers often come up in ~50ms, so probe aggressively at first,
// then settle into 500ms to avoid hammering a slow device.
const HEALTH_POLL_SCHEDULE = [25, 50, 100, 200];
const HEALTH_POLL_INTERVAL = 500;
// Must outlast xcodebuild cold start (destination resolution + runner install
// + testmanagerd handshake): ~40s on an idle machine; 3x headroom.
const HEALTH_TIMEOUT = 120_000;

// Source form (src/server/) is two levels above drivers/; bundled form (bin/) is one.
function resolveProjectRoot(moduleDir: string): string {
  for (const up of ["..", join("..", "..")]) {
    const root = join(moduleDir, up);
    const drivers = join(root, "drivers");
    if (existsSync(drivers) && statSync(drivers).isDirectory()) return root;
  }
  throw new Error(`drivers/ not found relative to ${moduleDir}`);
}

const PROJECT_ROOT = resolveProjectRoot(import.meta.dirname ?? import.meta.dir);
const DRIVERS_ANDROID = join(PROJECT_ROOT, "drivers", "android");
const DRIVERS_IOS_SIM = join(PROJECT_ROOT, "drivers", "ios");
const DRIVERS_IOS_DEVICE = join(PROJECT_ROOT, "drivers", "ios-device");

// ── Promise chains for per-device serialization ──
const bootstrapChains = new Map<string, Promise<void>>();

export async function ensureDevice(deviceId: string): Promise<RegisteredDevice> {
  // Fast path: already registered — but verify server is still alive
  const existing = getDevice(deviceId);
  if (existing) {
    if (existing.serverProcess.exitCode !== null) {
      const old = removeDevice(deviceId);
      if (old) await cleanupDevice(old);
    } else {
      return existing;
    }
  }

  // Serialize bootstrap per device
  const chain = (bootstrapChains.get(deviceId) ?? Promise.resolve()).catch(() => {});
  const next = chain.then(async () => {
    // Re-check after waiting (a prior bootstrap may have succeeded)
    const found = getDevice(deviceId);
    if (found) return;
    await bootstrapDevice(deviceId);
  });
  bootstrapChains.set(deviceId, next);
  try {
    await next;
  } finally {
    // Prune completed chains — one entry per device ever seen would
    // otherwise accumulate for the process lifetime.
    if (bootstrapChains.get(deviceId) === next) {
      bootstrapChains.delete(deviceId);
    }
  }

  const device = getDevice(deviceId);
  if (!device) throw new Error(`Bootstrap failed for device ${deviceId}`);
  return device;
}

async function bootstrapDevice(deviceId: string): Promise<void> {
  const { platform, deviceType } = await detectPlatform(deviceId);

  if (platform === "android") {
    await bootstrapAndroid(deviceId);
  } else {
    await bootstrapIOS(deviceId, deviceType!);
  }
}

// ── Android bootstrap ──

async function bootstrapAndroid(deviceId: string): Promise<void> {
  // Clean up stale state from a previous MCP instance (e.g. after Claude Code restart)
  await cleanupStaleAndroid(deviceId);

  const port = await allocateAndroidPort();
  const authToken = randomBytes(32).toString("hex");
  addPendingPort(port);

  let serverProcess: Subproc | undefined;
  let cdpPort: number | undefined;
  try {
    // Install APKs
    const apks = readdirSync(DRIVERS_ANDROID).filter((f) => f.endsWith(".apk"));
    for (const apk of apks) {
      const proc = spawn(["adb", "-s", deviceId, "install", "-r", "-g", join(DRIVERS_ANDROID, apk)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    }

    // Forward host port to device server
    await runAdb(deviceId, "forward", `tcp:${port}`, `tcp:${port}`);

    // CDP forwarding: route device:9222 → host:cdpPort → device Chrome abstract socket
    // ADB daemon bypasses SELinux app-to-app restrictions
    cdpPort = await setupCdpForwarding(deviceId);

    // Write auth token to device file (avoids exposing in process args / ps output)
    await runAdb(deviceId, "shell", `echo -n ${authToken} > /data/local/tmp/.mds_auth_${port}`);

    // Spawn instrumentation
    serverProcess = spawn(
      [
        "adb", "-s", deviceId, "shell", "am", "instrument", "-w", "-r",
        "-e", "class", "dev.uitreeserver.UITreeServer#startServer",
        "-e", "port", String(port),
        "dev.uitreeserver.test/androidx.test.runner.AndroidJUnitRunner",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    // Health poll
    await healthPoll(port, serverProcess);

    // Register
    setDevice({
      id: deviceId,
      platform: "android",
      port,
      authToken,
      serverProcess,
    });
  } catch (err) {
    // Cleanup on failure
    if (serverProcess) {
      try { serverProcess.kill(9); } catch { /* */ }
    }
    try { await runAdb(deviceId, "forward", "--remove", `tcp:${port}`); } catch { /* */ }
    if (cdpPort) {
      try { await runAdb(deviceId, "forward", "--remove", `tcp:${cdpPort}`); } catch { /* */ }
    }
    try { await runAdb(deviceId, "reverse", "--remove", "tcp:9222"); } catch { /* */ }
    try { await runAdb(deviceId, "shell", `rm -f /data/local/tmp/.mds_auth_${port}`); } catch { /* */ }
    throw err;
  } finally {
    releasePendingPort(port);
  }
}

async function cleanupStaleAndroid(deviceId: string): Promise<void> {
  // Kill any leftover instrumentation from a previous MCP instance
  await runAdb(deviceId, "shell", "am", "force-stop", "dev.uitreeserver.test");
  // Remove stale CDP reverse (device:9222 → host)
  try { await runAdb(deviceId, "reverse", "--remove", "tcp:9222"); } catch { /* no reverse to remove */ }
  // Remove all stale adb forwards for this device
  try {
    const proc = spawn(["adb", "-s", deviceId, "forward", "--list"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of output.split("\n")) {
      // adb forward --list returns ALL devices; only remove ours
      if (!line.startsWith(deviceId + " ")) continue;
      const match = line.match(/^\S+\s+(tcp:\d+)/);
      if (match) {
        await runAdb(deviceId, "forward", "--remove", match[1]);
      }
    }
  } catch { /* adb not available */ }
  // Clean up any leftover auth token files
  await runAdb(deviceId, "shell", "rm -f /data/local/tmp/.mds_auth_*");
}

async function setupCdpForwarding(deviceId: string): Promise<number> {
  // Let ADB pick a free host port (tcp:0) that tunnels to Chrome's abstract socket
  const fwdProc = spawn(
    ["adb", "-s", deviceId, "forward", "tcp:0", "localabstract:chrome_devtools_remote"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(fwdProc.stdout).text(),
    new Response(fwdProc.stderr).text(),
  ]);
  const exitCode = await fwdProc.exited;
  if (exitCode !== 0) {
    throw new Error(`adb forward (exit ${exitCode}): ${stderr}`);
  }
  const cdpPort = parseInt(stdout, 10);
  if (isNaN(cdpPort)) {
    throw new Error(`adb forward returned non-numeric stdout (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`);
  }
  // Reverse: device:9222 → host:cdpPort (so on-device CdpClient reaches Chrome)
  try {
    await runAdb(deviceId, "reverse", "tcp:9222", `tcp:${cdpPort}`);
  } catch (err) {
    try { await runAdb(deviceId, "forward", "--remove", `tcp:${cdpPort}`); } catch { /* */ }
    throw err;
  }
  return cdpPort;
}

async function runAdb(deviceId: string, ...args: string[]): Promise<void> {
  const proc = spawn(["adb", "-s", deviceId, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

// ── iOS bootstrap ──

async function bootstrapIOS(deviceId: string, deviceType: DeviceType): Promise<void> {
  // Clean up stale state from a previous MCP instance (e.g. after Claude Code restart)
  await cleanupStalePorts();

  const port = await allocateIOSPort();
  const authToken = randomBytes(32).toString("hex");
  addPendingPort(port);

  let serverProcess: Subproc | undefined;
  let tunnelProcess: Subproc | undefined;
  try {
    const result = spawnIOSServer(deviceId, deviceType, port, authToken);
    serverProcess = result.serverProcess;
    tunnelProcess = result.tunnelProcess;

    // Health poll
    await healthPoll(port, serverProcess);

    // Register
    setDevice({
      id: deviceId,
      platform: "ios",
      deviceType,
      port,
      authToken,
      serverProcess,
      tunnelProcess,
    });
  } catch (err) {
    // Cleanup on failure — kill the whole session tree: the runner launched
    // by xcodebuild survives a bare handle kill and would hold the port.
    if (serverProcess) killProcessTree(serverProcess);
    if (tunnelProcess) killProcessTree(tunnelProcess);
    unlockPort(port);
    throw err;
  } finally {
    releasePendingPort(port);
  }
}

/// Pump a long-lived child process's stdout/stderr into a log file.
/// The writer closes itself when the process dies and both streams EOF.
function teeProcessOutput(proc: Subproc, logPath: string): void {
  const streams = [proc.stdout, proc.stderr].filter(
    (s): s is ReadableStream<Uint8Array> => s !== null,
  );
  // Early-return before creating the file: mocked spawns in tests have no
  // streams — don't create empty log files on every test run.
  if (streams.length === 0) return;
  const writer = createWriteStream(logPath, { flags: "a" });
  writer.write(`\n── server output begins (pid ${proc.pid ?? "?"}) ──\n`);
  // WriteStream errors are delivered asynchronously via 'error'; without a
  // listener an unhandled error takes down the whole MCP host process.
  writer.on("error", (err) => {
    console.error(`[mobile-device-mcp] log writer failed for ${logPath}: ${err.message}`);
  });
  let open = streams.length;
  for (const stream of streams) {
    void (async () => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
      } catch {
        // Process killed mid-stream — nothing more to log.
      } finally {
        if (--open === 0) writer.end();
      }
    })();
  }
}

// ── iOS: one xcodebuild test session for simulators and real devices (spec §2.4) ──
// xcodebuild owns the runner's lifecycle: killing the session kills the server,
// and uninstalling the runner app kills it too. No ad-hoc processes.

function spawnIOSServer(
  deviceId: string, deviceType: DeviceType, port: number, authToken: string,
): { serverProcess: Subproc; tunnelProcess?: Subproc } {
  const driversDir = deviceType === "simulator" ? DRIVERS_IOS_SIM : DRIVERS_IOS_DEVICE;
  const xctestrunFile = readdirSync(driversDir).filter((f) => f.endsWith(".xctestrun")).sort()[0];
  if (!xctestrunFile) {
    throw new Error(`No .xctestrun driver found in ${driversDir}`);
  }

  const args = [
    "xcodebuild", "test-without-building",
    "-xctestrun", join(driversDir, xctestrunFile),
    "-destination",
    deviceType === "simulator" ? `platform=iOS Simulator,id=${deviceId}` : `platform=iOS,id=${deviceId}`,
    "-parallel-testing-enabled", "NO",
  ];
  if (deviceType !== "simulator") {
    args.push("-allowProvisioningUpdates");
  }

  const serverProcess = spawn(args, {
    // xcodebuild writes Logs/Test artifacts to cwd; don't pollute the MCP host's cwd.
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TEST_RUNNER_PORT: String(port),
      TEST_RUNNER_AUTH_TOKEN: authToken,
    },
  });

  // The on-device server's diagnostics ride xcodebuild's output stream. Append:
  // a re-bootstrap must not erase a dying server's final lines.
  const logDir = join(homedir(), ".mdms", "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  teeProcessOutput(serverProcess, join(logDir, `ios-${port}.log`));

  if (deviceType === "simulator") {
    return { serverProcess };
  }
  const tunnelProcess = spawn(
    ["iproxy", String(port), String(port), "-u", deviceId, "-l", "127.0.0.1"],
    { stdout: "ignore", stderr: "ignore" },
  );
  return { serverProcess, tunnelProcess };
}

// ── Health poll ──

async function healthPoll(port: number, serverProcess: Subproc): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // Connection not ready yet
    }
    // Check if the process died
    if (serverProcess.exitCode !== null) {
      throw new Error(`Server process exited with code ${serverProcess.exitCode} before becoming healthy`);
    }
    const delay = HEALTH_POLL_SCHEDULE[attempt] ?? HEALTH_POLL_INTERVAL;
    attempt++;
    await sleep(delay);
  }
  // Timeout: kill and throw
  killProcessTree(serverProcess);
  throw new Error(`Health check timed out after ${HEALTH_TIMEOUT}ms on port ${port}`);
}
