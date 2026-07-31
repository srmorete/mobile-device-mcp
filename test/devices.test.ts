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

// devicectl writes JSON only to --json-output; mocks must do the same.
function mockDevicectl(cmd: string[], json: unknown, exitCode = 0) {
  const flagIdx = cmd.indexOf("--json-output");
  const jsonPath = flagIdx >= 0 ? cmd[flagIdx + 1] : undefined;
  if (jsonPath && jsonPath !== "/dev/stdout") {
    writeFileSync(jsonPath, JSON.stringify(json));
  }
  return mockSubprocess(
    jsonPath === "/dev/stdout" ? JSON.stringify(json) : "No devices found.\n",
    exitCode,
  );
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
        return mockDevicectl(cmd as string[], {
          result: {
            devices: [
              { identifier: "DEV-001", deviceProperties: { name: "iPhone 13" }, connectionProperties: { transportType: "wired" } },
              { identifier: "DEV-002", deviceProperties: { name: "iPhone 12" }, connectionProperties: { transportType: "network" } },
            ],
          },
        });
      }
      return mockSubprocess("");
    });

    const { devices } = await discoverDevices();

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
    expect(real!.state).toBe("wired");
    const network = devices.find((d) => d.id === "DEV-002");
    expect(network).toBeDefined();
    expect(network!.state).toBe("network");

    spawn.mockRestore();
  });

  test("surfaces errors when all discovery fails", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("command not found");
    });
    const { devices, errors } = await discoverDevices();
    expect(devices).toEqual([]);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.platform).sort()).toEqual(["android", "ios-device", "ios-simulator"]);
    expect(errors.every((e) => e.message.includes("command not found"))).toBe(true);
    spawn.mockRestore();
  });

  test("surfaces async spawn errors (Node ENOENT path)", async () => {
    // Simulates the Node child_process.spawn failure mode where spawn returns
    // a Subproc that exits non-zero with `spawnError` set, instead of throwing
    // synchronously. This is the case d4rkmen hit when adb wasn't on PATH.
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => ({
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: Promise.resolve(1),
      exitCode: 1,
      spawnError: new Error(`spawn ${(cmd as string[])[0]} ENOENT`),
      pid: undefined,
      kill: mock(() => {}),
    }) as any);
    const { devices, errors } = await discoverDevices();
    expect(devices).toEqual([]);
    expect(errors).toHaveLength(3);
    expect(errors.find((e) => e.platform === "android")!.message).toBe("spawn adb ENOENT");
    expect(errors.find((e) => e.platform === "ios-simulator")!.message).toBe("spawn xcrun ENOENT");
    expect(errors.find((e) => e.platform === "ios-device")!.message).toBe("spawn xcrun ENOENT");
    spawn.mockRestore();
  });

  test("android device without model uses serial as name", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb") && args.includes("devices")) {
        return mockSubprocess("List of devices attached\n192.168.1.5:5555\tdevice\n");
      }
      if (args.includes("simctl")) {
        return mockSubprocess(JSON.stringify({ devices: {} }));
      }
      if (args.includes("devicectl")) {
        return mockDevicectl(cmd as string[], { result: { devices: [] } });
      }
      return mockSubprocess("");
    });
    const { devices } = await discoverDevices();
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
        return mockDevicectl(cmd as string[], {
          result: {
            devices: [
              { identifier: "NO-NAME", connectionProperties: { transportType: "wired" } },
            ],
          },
        });
      }
      return mockSubprocess("");
    });
    const { devices } = await discoverDevices();
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
      if (args.includes("devicectl")) {
        return mockDevicectl(cmd as string[], { result: { devices: [] } });
      }
      return mockSubprocess("");
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
        return mockDevicectl(cmd as string[], {
          result: {
            devices: [
              // Non-matching device first so the for-loop continues past closing }
              { identifier: "OTHER", connectionProperties: { transportType: "wired" } },
              { identifier: "DEV-ABC", connectionProperties: { transportType: "wired" } },
            ],
          },
        });
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
        return mockDevicectl(cmd as string[], { result: { devices: [] } });
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
      if (args.includes("devicectl")) {
        return mockDevicectl(cmd as string[], { result: { devices: [] } });
      }
      return mockSubprocess("");
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
        return mockDevicectl(cmd as string[], {
          result: {
            devices: [
              { identifier: "DEV-Z", connectionProperties: { transportType: "wired" } },
            ],
          },
        });
      }
      return mockSubprocess("");
    });
    const result = await detectPlatform("DEV-Z");
    expect(result).toEqual({ platform: "ios", deviceType: "device" });
    spawn.mockRestore();
  });
});

// --- cleanupDevice ---

/** Android server mock: first group SIGTERM marks it exited. */
function androidExitingServer(pid: number) {
  const proc = {
    pid,
    exitCode: null as number | null,
    exited: Promise.resolve(0),
    kill(_signal?: NodeJS.Signals | number) {
      this.exitCode = 0;
    },
  };
  return proc;
}

/** iOS server mock: marks exited when HTTP /shutdown is "accepted". */
function iosServer(pid: number) {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const proc = {
    pid,
    exitCode: null as number | null,
    exited,
    kill(_signal?: NodeJS.Signals | number) {
      /* signals still possible as last resort */
    },
    /** Simulate xcodebuild exiting after FlyingFox stop. */
    markExited() {
      this.exitCode = 0;
      resolveExit(0);
    },
  };
  return proc;
}

function mockShutdownFetch(onShutdown: () => void) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("/shutdown") && init?.method === "POST") {
      onShutdown();
      return new Response("OK", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("cleanupDevice", () => {
  test("stops Android device server gracefully then cleans up forwards", async () => {
    const spawnCalls: string[][] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = cmd as string[];
      spawnCalls.push(args);
      if (args.join(" ").includes("forward --list")) {
        return mockSubprocess("test-android tcp:8080 tcp:8080\nother-device tcp:9090 tcp:9090\n");
      }
      return mockSubprocess("");
    });
    const proc = androidExitingServer(1234);
    const killMock = spyOn(process, "kill").mockImplementation((pid: any, signal?: any) => {
      if (pid === -1234 && (signal === "SIGTERM" || signal === 15)) {
        proc.exitCode = 0;
      }
      return true;
    });

    const dev: RegisteredDevice = {
      id: "test-android",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: proc as any,
    };
    await cleanupDevice(dev);

    expect(killMock).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(killMock).not.toHaveBeenCalledWith(-1234, "SIGKILL");
    expect(spawnCalls.some((c) => c.join(" ").includes("force-stop"))).toBe(true);
    expect(spawnCalls.some((c) => c.join(" ").includes("--remove") && c.join(" ").includes("tcp:8080"))).toBe(true);
    // Should NOT remove forwards for other devices
    expect(spawnCalls.some((c) => c.join(" ").includes("--remove") && c.join(" ").includes("tcp:9090"))).toBe(false);

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("escalates to SIGKILL when the Android server ignores SIGTERM", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const killMock = spyOn(process, "kill").mockImplementation((_pid: any, signal?: any) => {
      signals.push(signal);
      return true;
    });

    const proc = {
      pid: 1234,
      exitCode: null as number | null,
      exited: new Promise<number>(() => {}),
      kill: mock(() => {}),
    };
    const dev: RegisteredDevice = {
      id: "test-escalate",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: proc as any,
    };
    await cleanupDevice(dev);
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("falls back to direct signal when process group signal fails", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const killMock = spyOn(process, "kill").mockImplementation(() => {
      throw new Error("no process group");
    });

    const serverProc = {
      pid: 1234,
      exitCode: null as number | null,
      exited: Promise.resolve(0),
      kill(signal?: NodeJS.Signals | number) {
        if (signal === "SIGTERM" || signal === 15) this.exitCode = 0;
      },
    };
    const serverKill = spyOn(serverProc, "kill");
    const dev: RegisteredDevice = {
      id: "test-fallback",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: serverProc as any,
    };
    await cleanupDevice(dev);
    expect(serverKill).toHaveBeenCalledWith("SIGTERM");

    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("iOS cleanup POSTs /shutdown and skips SIGTERM when xcodebuild exits", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const killMock = spyOn(process, "kill").mockImplementation(() => true);
    const proc = iosServer(100);
    const restoreFetch = mockShutdownFetch(() => proc.markExited());

    const dev: RegisteredDevice = {
      id: "test-ios-http-shutdown",
      platform: "ios",
      port: 22099,
      authToken: "tok",
      serverProcess: proc as any,
    };
    await cleanupDevice(dev);

    // Clean HTTP path — no process-group signals needed.
    expect(killMock).not.toHaveBeenCalled();
    expect(proc.exitCode).toBe(0);

    restoreFetch();
    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("kills tunnel process hard for iOS real device (after graceful server stop)", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const killMock = spyOn(process, "kill").mockImplementation(() => true);
    const proc = iosServer(100);
    const restoreFetch = mockShutdownFetch(() => proc.markExited());

    const dev: RegisteredDevice = {
      id: "test-ios-tunnel",
      platform: "ios",
      port: 22099,
      authToken: "tok",
      serverProcess: proc as any,
      tunnelProcess: { exitCode: null, kill: mock(() => {}), pid: 200, exited: Promise.resolve(0) } as any,
    };
    await cleanupDevice(dev);

    expect(killMock).not.toHaveBeenCalledWith(-100, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(-200, "SIGKILL");

    restoreFetch();
    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("tunnel fallback to direct kill", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const proc = iosServer(100);
    const restoreFetch = mockShutdownFetch(() => proc.markExited());
    const killMock = spyOn(process, "kill").mockImplementation((pid: any) => {
      if (pid === -200) throw new Error("no tunnel group");
      return true;
    });

    const tunnelKill = mock(() => {});
    const dev: RegisteredDevice = {
      id: "test-ios-tunnel-fallback",
      platform: "ios",
      port: 22098,
      authToken: "tok",
      serverProcess: proc as any,
      tunnelProcess: { exitCode: null, kill: tunnelKill, pid: 200, exited: Promise.resolve(0) } as any,
    };
    await cleanupDevice(dev);
    // killProcessTree escalates tunnel via handle.kill(SIGKILL)
    expect(tunnelKill).toHaveBeenCalledWith("SIGKILL");

    restoreFetch();
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
    const proc = iosServer(300);
    const restoreFetch = mockShutdownFetch(() => proc.markExited());

    const dev: RegisteredDevice = {
      id: "test-ios-lock",
      platform: "ios",
      port: 22199,
      authToken: "tok",
      serverProcess: proc as any,
    };
    await cleanupDevice(dev);
    expect(existsSync(lockPath)).toBe(false);

    restoreFetch();
    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("iOS simulator cleanup deletes lock file without touching the port listener", async () => {
    // Spec §2.6: iOS cleanup = stop managed xcodebuild session + delete lock.
    // No lsof-based port kill (that hack existed only because simctl-spawned
    // servers survived their handle).
    const lockDir = join(homedir(), ".mdms", "ports");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "22197");
    writeFileSync(lockPath, String(process.pid));

    const spawnCalls: string[][] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      spawnCalls.push(cmd as string[]);
      return mockSubprocess("");
    });
    const killMock = spyOn(process, "kill").mockImplementation(() => true);
    const proc = iosServer(300);
    const restoreFetch = mockShutdownFetch(() => proc.markExited());

    const dev: RegisteredDevice = {
      id: "test-ios-sim-cleanup",
      platform: "ios",
      deviceType: "simulator",
      port: 22197,
      authToken: "tok",
      serverProcess: proc as any,
    };
    await cleanupDevice(dev);

    expect(spawnCalls.some((c) => c[0] === "lsof")).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    // Clean HTTP shutdown — no signal cascade
    expect(killMock).not.toHaveBeenCalled();

    restoreFetch();
    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("iOS escalates to SIGTERM when /shutdown fails and process stays up", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const killMock = spyOn(process, "kill").mockImplementation((_pid: any, signal?: any) => {
      signals.push(signal);
      return true;
    });

    // Server never exits → wait times out → stopProcessTree escalates.
    const proc = {
      pid: 400,
      exitCode: null as number | null,
      exited: new Promise<number>(() => {}),
      kill: mock(() => {}),
    };
    const dev: RegisteredDevice = {
      id: "test-ios-shutdown-fail",
      platform: "ios",
      port: 22100,
      authToken: "tok",
      serverProcess: proc as any,
    };
    await cleanupDevice(dev);

    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");

    globalThis.fetch = original;
    spawn.mockRestore();
    killMock.mockRestore();
  }, 15_000);

  test("skips group kill when pid is 0 after clean HTTP shutdown", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => mockSubprocess(""));
    const killMock = spyOn(process, "kill").mockImplementation(() => true);
    const proc = iosServer(0);
    const restoreFetch = mockShutdownFetch(() => proc.markExited());

    const dev: RegisteredDevice = {
      id: "test-pid-zero",
      platform: "ios",
      port: 22198,
      authToken: "tok",
      serverProcess: proc as any,
    };
    await cleanupDevice(dev);
    expect(killMock).not.toHaveBeenCalled();
    expect(proc.exitCode).toBe(0);

    restoreFetch();
    spawn.mockRestore();
    killMock.mockRestore();
  });

  test("android cleanup handles forward --list failure gracefully", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("forward --list")) throw new Error("adb gone");
      return mockSubprocess("");
    });
    const proc = androidExitingServer(500);
    const killMock = spyOn(process, "kill").mockImplementation((pid: any, signal?: any) => {
      if (pid === -500 && (signal === "SIGTERM" || signal === 15)) {
        proc.exitCode = 0;
      }
      return true;
    });

    const dev: RegisteredDevice = {
      id: "test-fwd-fail",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: proc as any,
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
