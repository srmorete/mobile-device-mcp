import { unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { RegisteredDevice, DiscoveredDevice, Platform, DeviceType } from "./types.js";
import { killPortListener } from "./ports.js";

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

async function runCommand(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

async function discoverAndroid(): Promise<DiscoveredDevice[]> {
  try {
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
  } catch (err) {
    console.error("Android discovery failed:", err);
    return [];
  }
}

async function discoverIOSSimulators(): Promise<DiscoveredDevice[]> {
  try {
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
  } catch (err) {
    console.error("iOS simulator discovery failed:", err);
    return [];
  }
}

async function discoverIOSRealDevices(): Promise<DiscoveredDevice[]> {
  try {
    const output = await runCommand(["xcrun", "devicectl", "list", "devices", "--json-output", "/dev/stdout"]);
    const json = JSON.parse(output);
    const devices: DiscoveredDevice[] = [];
    const result = json.result?.devices || [];
    for (const device of result) {
      // Only include USB-connected devices
      if (device.connectionProperties?.transportType !== "wired") continue;
      devices.push({
        id: device.identifier,
        platform: "ios",
        name: device.deviceProperties?.name || device.identifier,
        state: "connected",
        deviceType: "device",
      });
    }
    return devices;
  } catch (err) {
    console.error("iOS real device discovery failed:", err);
    return [];
  }
}

export async function discoverDevices(): Promise<DiscoveredDevice[]> {
  const [android, iosSim, iosDevice] = await Promise.all([
    discoverAndroid(),
    discoverIOSSimulators(),
    discoverIOSRealDevices(),
  ]);
  return [...android, ...iosSim, ...iosDevice];
}

export type DetectedPlatformInfo = {
  platform: Platform;
  deviceType?: DeviceType;
};

export async function detectPlatform(deviceId: string): Promise<DetectedPlatformInfo> {
  // Check Android first
  try {
    const output = await runCommand(["adb", "devices"]);
    for (const line of output.split("\n")) {
      const serial = line.split("\t")[0];
      if (serial === deviceId) {
        return { platform: "android" };
      }
    }
  } catch { /* adb not available */ }

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
  } catch { /* simctl not available */ }

  // Check iOS real devices
  try {
    const output = await runCommand(["xcrun", "devicectl", "list", "devices", "--json-output", "/dev/stdout"]);
    const json = JSON.parse(output);
    const result = json.result?.devices || [];
    for (const device of result) {
      if (device.identifier === deviceId && device.connectionProperties?.transportType === "wired") {
        return { platform: "ios", deviceType: "device" };
      }
    }
  } catch { /* devicectl not available */ }

  throw new Error(`Device ${deviceId} not found in adb, simctl, or devicectl`);
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
    const forceStop = Bun.spawn(["adb", "-s", device.id, "shell", "am", "force-stop", "dev.uitreeserver.test"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await forceStop.exited;

    // Remove auth token file from device
    const rmAuth = Bun.spawn(
      ["adb", "-s", device.id, "shell", `rm -f /data/local/tmp/.mds_auth_${device.port}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    await rmAuth.exited;

    // Remove CDP reverse (device:9222 → host)
    const rmReverse = Bun.spawn(
      ["adb", "-s", device.id, "reverse", "--remove", "tcp:9222"],
      { stdout: "ignore", stderr: "ignore" },
    );
    await rmReverse.exited;

    // Remove ALL ADB forwards for this device (not just registered ports)
    try {
      const listProc = Bun.spawn(["adb", "-s", device.id, "forward", "--list"], { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(listProc.stdout).text();
      await listProc.exited;
      const removes: Promise<number>[] = [];
      for (const line of output.split("\n")) {
        // adb forward --list returns ALL devices; only remove ours
        if (!line.startsWith(device.id + " ")) continue;
        const match = line.match(/^\S+\s+(tcp:\d+)/);
        if (match) {
          removes.push(
            Bun.spawn(["adb", "-s", device.id, "forward", "--remove", match[1]], {
              stdout: "ignore", stderr: "ignore",
            }).exited,
          );
        }
      }
      await Promise.allSettled(removes);
    } catch { /* adb not available */ }
  } else if (device.platform === "ios") {
    // For simulators, kill the actual server inside the simulator.
    // serverProcess is just the simctl spawn handle — the real server
    // runs under the simulator's launchd and survives handle death.
    if (device.deviceType === "simulator") {
      await killPortListener(device.port);
    }
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
