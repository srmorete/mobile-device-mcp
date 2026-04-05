import { readdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { Subprocess } from "bun";
import type { RegisteredDevice, DeviceType } from "./types.js";
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
  killPortListener,
} from "./ports.js";

const HEALTH_POLL_INTERVAL = 500;
const HEALTH_TIMEOUT = 45_000;

// Drivers root relative to project
const PROJECT_ROOT = join(import.meta.dirname ?? import.meta.dir, "..", "..");
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
  await next;

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

  let serverProcess: Subprocess | undefined;
  let cdpPort: number | undefined;
  try {
    // Install APKs
    const apks = readdirSync(DRIVERS_ANDROID).filter((f) => f.endsWith(".apk"));
    for (const apk of apks) {
      const proc = Bun.spawn(["adb", "-s", deviceId, "install", "-r", "-g", join(DRIVERS_ANDROID, apk)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    }

    // Forward host port to device server
    await runAdb(deviceId, "forward", `tcp:${port}`, `tcp:${port}`);

    // CDP forwarding: route device:9222 → host:cdpPort → device Chrome abstract socket
    // ADB daemon bypasses SELinux app-to-app restrictions (CdpBridge.kt couldn't)
    cdpPort = await setupCdpForwarding(deviceId);

    // Write auth token to device file (avoids exposing in process args / ps output)
    await runAdb(deviceId, "shell", `echo -n ${authToken} > /data/local/tmp/.mds_auth_${port}`);

    // Spawn instrumentation
    serverProcess = Bun.spawn(
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
    const proc = Bun.spawn(["adb", "-s", deviceId, "forward", "--list"], { stdout: "pipe", stderr: "pipe" });
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
  const fwdProc = Bun.spawn(
    ["adb", "-s", deviceId, "forward", "tcp:0", "localabstract:chrome_devtools_remote"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const cdpPort = parseInt((await new Response(fwdProc.stdout).text()).trim(), 10);
  await fwdProc.exited;
  if (isNaN(cdpPort)) {
    throw new Error("Failed to allocate CDP forward port");
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
  const proc = Bun.spawn(["adb", "-s", deviceId, ...args], {
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

  let serverProcess: Subprocess | undefined;
  let tunnelProcess: Subprocess | undefined;
  try {
    if (deviceType === "simulator") {
      serverProcess = await bootstrapIOSSimulator(deviceId, port, authToken);
    } else {
      const result = await bootstrapIOSDevice(deviceId, port, authToken);
      serverProcess = result.serverProcess;
      tunnelProcess = result.tunnelProcess;
    }

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
    // Cleanup on failure
    if (serverProcess) {
      try { serverProcess.kill(9); } catch { /* */ }
    }
    if (tunnelProcess) {
      try { tunnelProcess.kill(9); } catch { /* */ }
    }
    // For simulators, the spawn handle kill above doesn't kill the real server —
    // kill whatever is actually listening on the port to prevent orphans.
    if (deviceType === "simulator") {
      await killPortListener(port);
    }
    unlockPort(port);
    throw err;
  } finally {
    releasePendingPort(port);
  }
}

// ── iOS simulator: simctl install + spawn (bypasses xcodebuild orchestration) ──

async function bootstrapIOSSimulator(deviceId: string, port: number, authToken: string): Promise<Subprocess> {
  const buildDir = join(DRIVERS_IOS_SIM, "Debug-iphonesimulator");
  const runnerApp = readdirSync(buildDir).find((f) => f.endsWith("-Runner.app"));
  if (!runnerApp) {
    throw new Error("No Runner.app found in iOS simulator drivers");
  }
  const runnerAppPath = join(buildDir, runnerApp);
  const binaryName = runnerApp.replace(/\.app$/, "");

  // Read bundle ID from Info.plist
  const plistProc = Bun.spawn(
    ["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", join(runnerAppPath, "Info.plist")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const bundleId = (await new Response(plistProc.stdout).text()).trim();
  await plistProc.exited;
  if (!bundleId) {
    throw new Error("Could not read bundle ID from Runner.app Info.plist");
  }

  // Install the app on the simulator
  const installProc = Bun.spawn(
    ["xcrun", "simctl", "install", deviceId, runnerAppPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const installExit = await installProc.exited;
  if (installExit !== 0) {
    const stderr = await new Response(installProc.stderr).text();
    throw new Error(`simctl install failed: ${stderr}`);
  }

  // Get installed app container path
  const containerProc = Bun.spawn(
    ["xcrun", "simctl", "get_app_container", deviceId, bundleId],
    { stdout: "pipe", stderr: "pipe" },
  );
  const containerPath = (await new Response(containerProc.stdout).text()).trim();
  await containerProc.exited;
  if (!containerPath) {
    throw new Error("Could not get app container path after install");
  }

  // Spawn the runner binary inside the simulator (no foreground, no SpringBoard)
  return Bun.spawn(
    ["xcrun", "simctl", "spawn", deviceId, join(containerPath, binaryName)],
    {
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        SIMCTL_CHILD_PORT: String(port),
        SIMCTL_CHILD_AUTH_TOKEN: authToken,
      },
    },
  );
}

// ── iOS real device: xcodebuild (still required for testmanagerd handshake) ──

async function bootstrapIOSDevice(
  deviceId: string, port: number, authToken: string,
): Promise<{ serverProcess: Subprocess; tunnelProcess: Subprocess }> {
  const xctestrunFile = readdirSync(DRIVERS_IOS_DEVICE).find((f) => f.endsWith(".xctestrun"));
  if (!xctestrunFile) {
    throw new Error("No .xctestrun driver found for iOS device");
  }

  const serverProcess = Bun.spawn(
    [
      "xcodebuild", "test-without-building",
      "-xctestrun", join(DRIVERS_IOS_DEVICE, xctestrunFile),
      "-destination", `platform=iOS,id=${deviceId}`,
      "-parallel-testing-enabled", "NO",
      "-allowProvisioningUpdates",
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        TEST_RUNNER_PORT: String(port),
        TEST_RUNNER_AUTH_TOKEN: authToken,
      },
    },
  );

  const tunnelProcess = Bun.spawn(
    ["iproxy", String(port), String(port), "-u", deviceId, "-l", "127.0.0.1"],
    { stdout: "ignore", stderr: "ignore" },
  );

  return { serverProcess, tunnelProcess };
}

// ── Health poll ──

async function healthPoll(port: number, serverProcess: Subprocess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT;
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
    await Bun.sleep(HEALTH_POLL_INTERVAL);
  }
  // Timeout: kill and throw
  try { serverProcess.kill(9); } catch { /* */ }
  throw new Error(`Health check timed out after ${HEALTH_TIMEOUT}ms on port ${port}`);
}
