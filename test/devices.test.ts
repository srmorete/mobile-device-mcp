import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import {
  getDevice, setDevice, removeDevice, allDevices,
  discoverDevices, detectPlatform, cleanupDevice, cleanupAll,
} from "../src/server/devices";
import { unlockPort } from "../src/server/ports";
import type { RegisteredDevice } from "../src/server/types";

function fakeDevice(id: string, overrides?: Partial<RegisteredDevice>): RegisteredDevice {
  return {
    id,
    platform: "android",
    port: 8080,
    authToken: "tok",
    serverProcess: { exitCode: null, kill: () => {}, pid: 0 } as any,
    ...overrides,
  };
}

afterEach(() => {
  // Clean up registry between tests
  for (const d of allDevices()) {
    removeDevice(d.id);
  }
});

describe("device registry", () => {
  test("getDevice returns undefined for unknown id", () => {
    expect(getDevice("nonexistent")).toBeUndefined();
  });

  test("setDevice + getDevice round-trip", () => {
    const dev = fakeDevice("dev-1");
    setDevice(dev);
    expect(getDevice("dev-1")).toBe(dev);
  });

  test("setDevice overwrites existing device", () => {
    setDevice(fakeDevice("dev-1", { port: 8080 }));
    const updated = fakeDevice("dev-1", { port: 9090 });
    setDevice(updated);
    expect(getDevice("dev-1")!.port).toBe(9090);
  });

  test("removeDevice returns the device and deletes it", () => {
    const dev = fakeDevice("dev-1");
    setDevice(dev);
    const removed = removeDevice("dev-1");
    expect(removed).toBe(dev);
    expect(getDevice("dev-1")).toBeUndefined();
  });

  test("removeDevice returns undefined for missing device", () => {
    expect(removeDevice("ghost")).toBeUndefined();
  });

  test("allDevices returns all registered devices", () => {
    setDevice(fakeDevice("a", { port: 8080 }));
    setDevice(fakeDevice("b", { port: 8081 }));
    setDevice(fakeDevice("c", { port: 8082 }));
    const ids = allDevices().map((d) => d.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  test("allDevices returns empty when registry is clear", () => {
    expect(allDevices()).toEqual([]);
  });

  test("multiple platforms coexist", () => {
    setDevice(fakeDevice("emu-5554", { platform: "android", port: 8080 }));
    setDevice(fakeDevice("ABCD-1234", { platform: "ios", port: 22087 }));
    expect(allDevices()).toHaveLength(2);
    expect(getDevice("emu-5554")!.platform).toBe("android");
    expect(getDevice("ABCD-1234")!.platform).toBe("ios");
  });
});

// --- Mock helpers ---

function mockSubprocess(stdout: string, exitCode = 0) {
  return {
    stdout: new Response(stdout).body,
    stderr: new Response("").body,
    exited: Promise.resolve(exitCode),
    exitCode,
    pid: 99999,
    kill: mock(() => {}),
  } as any;
}

// --- Discovery ---

describe("discoverDevices", () => {
  test("discovers Android, iOS sim, and iOS real devices", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb") && args.includes("devices")) {
        // Include a malformed line (only 1 part) to cover parts.length < 2 branch
        return mockSubprocess("List of devices attached\nmalformed\nemulator-5554\tdevice transport_id:1 model:Pixel_4\n");
      }
      if (args.includes("simctl") && args.includes("list")) {
        return mockSubprocess(JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
              { udid: "SIM-001", name: "iPhone 15", state: "Booted" },
              { udid: "SIM-002", name: "iPhone 14", state: "Shutdown" },
            ],
          },
        }));
      }
      if (args.includes("devicectl") && args.includes("list")) {
        return mockSubprocess(JSON.stringify({
          result: {
            devices: [
              { identifier: "DEV-001", deviceProperties: { name: "iPhone 13" }, connectionProperties: { transportType: "wired" } },
              { identifier: "DEV-002", deviceProperties: { name: "iPhone 12" }, connectionProperties: { transportType: "network" } },
            ],
          },
        }));
      }
      return mockSubprocess("");
    });

    const devices = await discoverDevices();

    const android = devices.find((d) => d.id === "emulator-5554");
    expect(android).toBeDefined();
    expect(android!.platform).toBe("android");
    expect(android!.name).toBe("Pixel_4");

    const sim = devices.find((d) => d.id === "SIM-001");
    expect(sim).toBeDefined();
    expect(sim!.deviceType).toBe("simulator");
    expect(devices.find((d) => d.id === "SIM-002")).toBeUndefined(); // shutdown

    const real = devices.find((d) => d.id === "DEV-001");
    expect(real).toBeDefined();
    expect(real!.deviceType).toBe("device");
    expect(devices.find((d) => d.id === "DEV-002")).toBeUndefined(); // network

    spawn.mockRestore();
  });

  test("returns empty when all discovery fails", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("command not found");
    });
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
    const devices = await discoverDevices();
    expect(devices).toEqual([]);
    spawn.mockRestore();
    consoleSpy.mockRestore();
  });

  test("android device without model uses serial as name", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb") && args.includes("devices")) {
        return mockSubprocess("List of devices attached\n192.168.1.5:5555\tdevice\n");
      }
      return mockSubprocess("{}");
    });
    const devices = await discoverDevices();
    const d = devices.find((d) => d.id === "192.168.1.5:5555");
    expect(d).toBeDefined();
    expect(d!.name).toBe("192.168.1.5:5555");
    spawn.mockRestore();
  });

  test("ios real device without name uses identifier", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb") && args.includes("devices")) {
        return mockSubprocess("List of devices attached\n");
      }
      if (args.includes("simctl")) {
        return mockSubprocess(JSON.stringify({ devices: {} }));
      }
      if (args.includes("devicectl")) {
        return mockSubprocess(JSON.stringify({
          result: {
            devices: [
              { identifier: "NO-NAME", connectionProperties: { transportType: "wired" } },
            ],
          },
        }));
      }
      return mockSubprocess("");
    });
    const devices = await discoverDevices();
    const d = devices.find((d) => d.id === "NO-NAME");
    expect(d).toBeDefined();
    expect(d!.name).toBe("NO-NAME");
    spawn.mockRestore();
  });
});

// --- detectPlatform ---

describe("detectPlatform", () => {
  test("detects Android device", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb devices")) {
        return mockSubprocess("List of devices attached\nemu-5554\tdevice\n");
      }
      return mockSubprocess("{}");
    });
    const result = await detectPlatform("emu-5554");
    expect(result.platform).toBe("android");
    spawn.mockRestore();
  });

  test("detects iOS simulator", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb devices")) {
        return mockSubprocess("List of devices attached\n");
      }
      if (args.includes("simctl") && args.includes("list")) {
        return mockSubprocess(JSON.stringify({
          devices: {
            "runtime": [{ udid: "SIM-XYZ", state: "Booted" }],
          },
        }));
      }
      return mockSubprocess(JSON.stringify({ result: { devices: [] } }));
    });
    const result = await detectPlatform("SIM-XYZ");
    expect(result).toEqual({ platform: "ios", deviceType: "simulator" });
    spawn.mockRestore();
  });

  test("detects iOS real device", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb devices")) {
        return mockSubprocess("List of devices attached\n");
      }
      if (args.includes("simctl")) {
        return mockSubprocess(JSON.stringify({ devices: {} }));
      }
      if (args.includes("devicectl")) {
        return mockSubprocess(JSON.stringify({
          result: {
            devices: [
              // Non-matching device first so the for-loop continues past closing }
              { identifier: "OTHER", connectionProperties: { transportType: "wired" } },
              { identifier: "DEV-ABC", connectionProperties: { transportType: "wired" } },
            ],
          },
        }));
      }
      return mockSubprocess("");
    });
    const result = await detectPlatform("DEV-ABC");
    expect(result).toEqual({ platform: "ios", deviceType: "device" });
    spawn.mockRestore();
  });

  test("throws when device not found anywhere", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb devices")) {
        return mockSubprocess("List of devices attached\n");
      }
      if (args.includes("simctl")) {
        return mockSubprocess(JSON.stringify({ devices: {} }));
      }
      if (args.includes("devicectl")) {
        return mockSubprocess(JSON.stringify({ result: { devices: [] } }));
      }
      return mockSubprocess("");
    });
    await expect(detectPlatform("UNKNOWN")).rejects.toThrow("not found");
    spawn.mockRestore();
  });

  test("handles adb not available gracefully", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb")) throw new Error("adb not found");
      if (args.includes("simctl")) {
        return mockSubprocess(JSON.stringify({
          devices: { "runtime": [{ udid: "SIM-1", state: "Booted" }] },
        }));
      }
      return mockSubprocess(JSON.stringify({ result: { devices: [] } }));
    });
    const result = await detectPlatform("SIM-1");
    expect(result.platform).toBe("ios");
    spawn.mockRestore();
  });

  test("handles simctl not available gracefully", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb devices")) return mockSubprocess("List of devices attached\n");
      if (args.includes("simctl")) throw new Error("simctl not found");
      if (args.includes("devicectl")) {
        return mockSubprocess(JSON.stringify({
          result: {
            devices: [
              { identifier: "DEV-Z", connectionProperties: { transportType: "wired" } },
            ],
          },
        }));
      }
      return mockSubprocess("");
    });
    const result = await detectPlatform("DEV-Z");
    expect(result).toEqual({ platform: "ios", deviceType: "device" });
    spawn.mockRestore();
  });
});

// --- cleanupDevice ---

describe("cleanupDevice", () => {
  test("kills Android device server and cleans up forwards", async () => {
    const spawnCalls: string[][] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = cmd as string[];
      spawnCalls.push(args);
      if (args.join(" ").includes("forward --list")) {
        return mockSubprocess("test-android tcp:8080 tcp:8080\nother-device tcp:9090 tcp:9090\n");
      }
      return mockSubprocess("");
    });
    const killMock = spyOn(process, "kill").mockImplementation(() => true);

    const dev: RegisteredDevice = {
      id: "test-android",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: mock(() => {}), pid: 1234 } as any,
    };
    await cleanupDevice(dev);

    expect(killMock).toHaveBeenCalledWith(-1234, "SIGKILL");
    expect(spawnCalls.some((c) => c.join(" ").includes("force-stop"))).toBe(true);
    expect(spawnCalls.some((c) => c.join(" ").includes("--remove") && c.join(" ").includes("tcp:8080"))).toBe(true);
    // Should NOT remove forwards for other devices
    expect(spawnCalls.some((c) => c.join(" ").includes("--remove") && c.join(" ").includes("tcp:9090"))).toBe(false);

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("falls back to direct kill when process group kill fails", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const killMock = spyOn(process, "kill").mockImplementation(() => {
      throw new Error("no process group");
    });

    const serverKill = mock(() => {});
    const dev: RegisteredDevice = {
      id: "test-fallback",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: serverKill, pid: 1234 } as any,
    };
    await cleanupDevice(dev);
    expect(serverKill).toHaveBeenCalledWith(9);

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("kills tunnel process for iOS real device", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const killMock = spyOn(process, "kill").mockImplementation(() => true);

    const dev: RegisteredDevice = {
      id: "test-ios-tunnel",
      platform: "ios",
      port: 22099,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: mock(() => {}), pid: 100 } as any,
      tunnelProcess: { exitCode: null, kill: mock(() => {}), pid: 200 } as any,
    };
    await cleanupDevice(dev);

    expect(killMock).toHaveBeenCalledWith(-200, "SIGKILL");

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("tunnel fallback to direct kill", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    let callCount = 0;
    const killMock = spyOn(process, "kill").mockImplementation(() => {
      callCount++;
      if (callCount === 1) return true; // server group kill succeeds
      throw new Error("no tunnel group"); // tunnel group kill fails
    });

    const tunnelKill = mock(() => {});
    const dev: RegisteredDevice = {
      id: "test-ios-tunnel-fallback",
      platform: "ios",
      port: 22098,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: mock(() => {}), pid: 100 } as any,
      tunnelProcess: { exitCode: null, kill: tunnelKill, pid: 200 } as any,
    };
    await cleanupDevice(dev);
    expect(tunnelKill).toHaveBeenCalledWith(9);

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("iOS cleanup deletes lock file", async () => {
    const lockDir = join(homedir(), ".mdms", "ports");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "22199");
    writeFileSync(lockPath, String(process.pid));

    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const killMock = spyOn(process, "kill").mockImplementation(() => true);

    const dev: RegisteredDevice = {
      id: "test-ios-lock",
      platform: "ios",
      port: 22199,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: mock(() => {}), pid: 300 } as any,
    };
    await cleanupDevice(dev);
    expect(existsSync(lockPath)).toBe(false);

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("iOS simulator cleanup calls killPortListener before deleting lock", async () => {
    const lockDir = join(homedir(), ".mdms", "ports");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "22197");
    writeFileSync(lockPath, String(process.pid));

    const spawnCalls: string[][] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      spawnCalls.push(cmd as string[]);
      return mockSubprocess("12345\n");
    });
    const killMock = spyOn(process, "kill").mockImplementation(() => true);

    const dev: RegisteredDevice = {
      id: "test-ios-sim-cleanup",
      platform: "ios",
      deviceType: "simulator",
      port: 22197,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: mock(() => {}), pid: 300 } as any,
    };
    await cleanupDevice(dev);

    // Should have spawned lsof to find the listener
    expect(spawnCalls.some((c) => c[0] === "lsof")).toBe(true);
    // Should have killed the listener PID
    expect(killMock).toHaveBeenCalledWith(12345, "SIGKILL");
    // Lock file should be deleted
    expect(existsSync(lockPath)).toBe(false);

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("skips kill when pid is 0", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const killMock = spyOn(process, "kill").mockImplementation(() => true);

    const serverKill = mock(() => {});
    const dev: RegisteredDevice = {
      id: "test-pid-zero",
      platform: "ios",
      port: 22198,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: serverKill, pid: 0 } as any,
    };
    await cleanupDevice(dev);
    // process.kill should NOT have been called (pid is 0)
    expect(killMock).not.toHaveBeenCalled();

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("android cleanup handles forward --list failure gracefully", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("forward --list")) throw new Error("adb gone");
      return mockSubprocess("");
    });
    const killMock = spyOn(process, "kill").mockImplementation(() => true);

    const dev: RegisteredDevice = {
      id: "test-fwd-fail",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: mock(() => {}), pid: 500 } as any,
    };
    // Should not throw
    await cleanupDevice(dev);

    spawn.mockRestore();
    killMock.mockRestore();
  });
});

// --- cleanupAll ---

describe("cleanupAll", () => {
  test("cleans up all registered devices and clears registry", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const killMock = spyOn(process, "kill").mockImplementation(() => true);

    setDevice({
      id: "dev-a",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: mock(() => {}), pid: 1 } as any,
    });
    setDevice({
      id: "dev-b",
      platform: "android",
      port: 8081,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: mock(() => {}), pid: 2 } as any,
    });

    await cleanupAll();
    expect(allDevices()).toHaveLength(0);

    spawn.mockRestore();
    killMock.mockRestore();
  });
});
