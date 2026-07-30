import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import type { RegisteredDevice, DiscoveredDevice, Platform, DeviceType } from "./types.js";
import { spawn } from "./proc.js";

const LOCK_DIR = join(homedir(), ".mdms", "ports");

// ── Device registry ──

const registry = new Map<string, RegisteredDevice>();

export function getDevice(id: string): RegisteredDevice | undefined {
  return registry.get(id);
}

export function setDevice(device: RegisteredDevice): void {
  registry.set(device.id, device);
}

export function removeDevice(id: string): RegisteredDevice | undefined {
  const device = registry.get(id);
  if (device) registry.delete(id);
  return device;
}

export function allDevices(): RegisteredDevice[] {
  return Array.from(registry.values());
}

// ── Discovery ──

export async function runCommand(cmd: string[]): Promise<string> {
  const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  // Drain stdio in parallel with exit; sequential awaits deadlock once the OS
  // pipe buffer (~64KB) fills (e.g. devicectl JSON, `adb forward --list`).
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // spawnError is assigned before `exited` resolves (see proc.ts), so it's
  // observable here. Node's message already includes the binary name.
  if (proc.spawnError) {
    throw new Error(proc.spawnError.message);
  }
  if (exitCode !== 0) {
    throw new Error(`${cmd[0]} (exit ${exitCode}): ${stderr}`);
  }
  return stdout;
}

async function discoverAndroid(): Promise<DiscoveredDevice[]> {
  const output = await runCommand(["adb", "devices", "-l"]);
  const devices: DiscoveredDevice[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of")) continue;
    // Format: <serial> <state> <info...>
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const id = parts[0];
    const state = parts[1];
    let name = id;
    for (const part of parts.slice(2)) {
      if (part.startsWith("model:")) {
        name = part.slice("model:".length);
        break;
      }
    }
    devices.push({ id, platform: "android", name, state });
  }
  return devices;
}

async function discoverIOSSimulators(): Promise<DiscoveredDevice[]> {
  const output = await runCommand(["xcrun", "simctl", "list", "devices", "booted", "-j"]);
  const json = JSON.parse(output);
  const devices: DiscoveredDevice[] = [];
  const runtimes = json.devices || {};
  for (const runtime of Object.keys(runtimes)) {
    for (const device of runtimes[runtime]) {
      if (device.state !== "Booted") continue;
      devices.push({
        id: device.udid,
        platform: "ios",
        name: device.name,
        state: device.state,
        deviceType: "simulator",
      });
    }
  }
  return devices;
}

async function listIOSRealDevicesJson(): Promise<any> {
  // devicectl writes JSON only to the --json-output path; stdout is human text
  // (e.g. "No devices found."). Using /dev/stdout therefore fails JSON.parse
  // with "Unexpected non-whitespace character after JSON". Always use a temp file.
  const dir = mkdtempSync(join(tmpdir(), "mdms-devicectl-"));
  const jsonPath = join(dir, "devices.json");
  try {
    await runCommand(["xcrun", "devicectl", "list", "devices", "--json-output", jsonPath]);
    return JSON.parse(readFileSync(jsonPath, "utf-8"));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  }
}

async function discoverIOSRealDevices(): Promise<DiscoveredDevice[]> {
  const json = await listIOSRealDevicesJson();
  const devices: DiscoveredDevice[] = [];
  const result = json.result?.devices || [];
  for (const device of result) {
    devices.push({
      id: device.identifier,
      platform: "ios",
      name: device.deviceProperties?.name || device.identifier,
      state: device.connectionProperties.transportType,
      deviceType: "device",
    });
  }
  return devices;
}

export async function discoverDevices(): Promise<{
  devices: DiscoveredDevice[];
  errors: Array<{ platform: string; message: string }>;
}> {
  const platforms = ["android", "ios-simulator", "ios-device"] as const;
  const results = await Promise.allSettled([
    discoverAndroid(),
    discoverIOSSimulators(),
    discoverIOSRealDevices(),
  ]);
  const devices: DiscoveredDevice[] = [];
  const errors: Array<{ platform: string; message: string }> = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") devices.push(...r.value);
    else errors.push({ platform: platforms[i], message: (r.reason as Error).message });
  });
  return { devices, errors };
}

export type DetectedPlatformInfo = {
  platform: Platform;
  deviceType?: DeviceType;
};

export async function detectPlatform(deviceId: string): Promise<DetectedPlatformInfo> {
  const errors: string[] = [];

  // Check Android first
  try {
    const output = await runCommand(["adb", "devices"]);
    for (const line of output.split("\n")) {
      const serial = line.split("\t")[0];
      if (serial === deviceId) {
        return { platform: "android" };
      }
    }
  } catch (err) {
    errors.push(`adb: ${(err as Error).message}`);
  }

  // Check iOS simulators
  try {
    const output = await runCommand(["xcrun", "simctl", "list", "devices", "booted", "-j"]);
    const json = JSON.parse(output);
    const runtimes = json.devices || {};
    for (const runtime of Object.keys(runtimes)) {
      for (const device of runtimes[runtime]) {
        if (device.udid === deviceId && device.state === "Booted") {
          return { platform: "ios", deviceType: "simulator" };
        }
      }
    }
  } catch (err) {
    errors.push(`simctl: ${(err as Error).message}`);
  }

  // Check iOS real devices
  try {
    const json = await listIOSRealDevicesJson();
    const result = json.result?.devices || [];
    for (const device of result) {
      if (device.identifier === deviceId) {
        return { platform: "ios", deviceType: "device" };
      }
    }
  } catch (err) {
    errors.push(`devicectl: ${(err as Error).message}`);
  }

  const detail = errors.length ? `: ${errors.join("; ")}` : "";
  throw new Error(`Device ${deviceId} not found in adb, simctl, or devicectl ${detail}`);
}

// ── Cleanup ──

export async function cleanupDevice(device: RegisteredDevice): Promise<void> {
  // Kill server process (SIGKILL, try process group first)
  try {
    if (device.serverProcess.pid && device.serverProcess.pid > 0) {
      process.kill(-device.serverProcess.pid, "SIGKILL");
    }
  } catch {
    try {
      device.serverProcess.kill(9);
    } catch { /* already dead */ }
  }

  // Kill tunnel process if present (iOS real devices)
  if (device.tunnelProcess) {
    try {
      if (device.tunnelProcess.pid && device.tunnelProcess.pid > 0) {
        process.kill(-device.tunnelProcess.pid, "SIGKILL");
      }
    } catch {
      try {
        device.tunnelProcess.kill(9);
      } catch { /* already dead */ }
    }
  }

  // Platform-specific cleanup
  if (device.platform === "android") {
    // Force-stop the test package
    const forceStop = spawn(["adb", "-s", device.id, "shell", "am", "force-stop", "dev.uitreeserver.test"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await forceStop.exited;

    // Remove auth token file from device
    const rmAuth = spawn(
      ["adb", "-s", device.id, "shell", `rm -f /data/local/tmp/.mds_auth_${device.port}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    await rmAuth.exited;

    // Remove CDP reverse (device:9222 → host)
    const rmReverse = spawn(
      ["adb", "-s", device.id, "reverse", "--remove", "tcp:9222"],
      { stdout: "ignore", stderr: "ignore" },
    );
    await rmReverse.exited;

    // Remove ALL ADB forwards for this device (not just registered ports)
    try {
      const listProc = spawn(["adb", "-s", device.id, "forward", "--list"], { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(listProc.stdout).text();
      await listProc.exited;
      const removes: Promise<number>[] = [];
      for (const line of output.split("\n")) {
        // adb forward --list returns ALL devices; only remove ours
        if (!line.startsWith(device.id + " ")) continue;
        const match = line.match(/^\S+\s+(tcp:\d+)/);
        if (match) {
          removes.push(
            spawn(["adb", "-s", device.id, "forward", "--remove", match[1]], {
              stdout: "ignore", stderr: "ignore",
            }).exited,
          );
        }
      }
      await Promise.allSettled(removes);
    } catch { /* adb not available */ }
  } else if (device.platform === "ios") {
    // Delete port lock file
    try {
      unlinkSync(join(LOCK_DIR, String(device.port)));
    } catch { /* file may not exist */ }
  }
}

export async function cleanupAll(): Promise<void> {
  const devices = allDevices();
  await Promise.allSettled(devices.map((device) => cleanupDevice(device)));
  for (const device of devices) {
    registry.delete(device.id);
  }
}
