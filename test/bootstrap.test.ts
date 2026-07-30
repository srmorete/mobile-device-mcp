import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { writeFileSync, unlinkSync as fsUnlink, existsSync, readdirSync } from "fs";
import * as fs from "fs";
import { join } from "path";
import { getDevice, setDevice, removeDevice, allDevices } from "../src/server/devices";
import { releasePendingPort, unlockPort } from "../src/server/ports";
import { ensureDevice } from "../src/server/bootstrap";
import type { RegisteredDevice } from "../src/server/types";

// Path to ios-device drivers (empty dir — we create temp .xctestrun files as needed)
const IOS_DEVICE_DRIVERS = join(import.meta.dir, "..", "drivers", "ios-device");
const DUMMY_XCTESTRUN = join(IOS_DEVICE_DRIVERS, "TestDriver.xctestrun");

// --- Mock helpers ---

function mockSubprocess(stdout: string, exitCode: number | null = 0) {
  return {
    stdout: new Response(stdout).body,
    stderr: new Response("").body,
    exited: exitCode !== null ? Promise.resolve(exitCode) : new Promise<number>(() => {}),
    exitCode,
    pid: 54321,
    kill: mock(() => {}),
  } as any;
}

// devicectl writes JSON only to --json-output; mocks must do the same.
function mockDevicectl(cmd: string[], json: unknown, exitCode: number | null = 0) {
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

function mockServerProcess() {
  return {
    stdout: null,
    stderr: null,
    exited: new Promise<number>(() => {}), // never resolves — server stays running
    exitCode: null,
    pid: 54321,
    kill: mock(() => {}),
  } as any;
}

// Build a Bun.spawn mock for Android bootstrap flows
function androidSpawnMock(deviceId: string) {
  return (cmd: any, _opts?: any) => {
    const args = (cmd as string[]).join(" ");
    // detectPlatform: adb devices
    if (args.includes("adb") && args.includes("devices") && !args.includes("-s")) {
      return mockSubprocess(`List of devices attached\n${deviceId}\tdevice\n`);
    }
    // adb forward --list (for allocateAndroidPort and cleanupStaleAndroid)
    if (args.includes("forward --list")) {
      return mockSubprocess("");
    }
    // adb forward tcp:0 localabstract:chrome_devtools_remote (CDP port allocation)
    if (args.includes("forward tcp:0")) {
      return mockSubprocess("19222\n");
    }
    // am instrument (server process)
    if (args.includes("instrument")) {
      return mockServerProcess();
    }
    // All other adb commands (install, forward, reverse, shell echo, force-stop, rm)
    return mockSubprocess("");
  };
}

// Build a Bun.spawn mock for iOS bootstrap flows
function iosSpawnMock(deviceId: string, deviceType: "simulator" | "device") {
  return (cmd: any, _opts?: any) => {
    const args = (cmd as string[]).join(" ");
    // adb devices — not found
    if (args.includes("adb") && args.includes("devices")) {
      return mockSubprocess("List of devices attached\n");
    }
    // simctl list
    if (args.includes("simctl") && args.includes("list")) {
      if (deviceType === "simulator") {
        return mockSubprocess(JSON.stringify({
          devices: { "runtime": [{ udid: deviceId, state: "Booted" }] },
        }));
      }
      return mockSubprocess(JSON.stringify({ devices: {} }));
    }
    // devicectl list
    if (args.includes("devicectl") && args.includes("list")) {
      if (deviceType === "device") {
        return mockDevicectl(cmd as string[], {
          result: {
            devices: [
              { identifier: deviceId, connectionProperties: { transportType: "wired" } },
            ],
          },
        });
      }
      return mockDevicectl(cmd as string[], { result: { devices: [] } });
    }
    // lsof (for isPortListening in allocateIOSPort)
    if (args.includes("lsof")) {
      return mockSubprocess(""); // port not in use
    }
    // xcodebuild (server process, simulator and real device)
    if (args.includes("xcodebuild")) {
      return mockServerProcess();
    }
    // iproxy (tunnel process for real devices)
    if (args.includes("iproxy")) {
      return mockServerProcess();
    }
    return mockSubprocess("");
  };
}

// --- Lifecycle ---

let spawnSpy: ReturnType<typeof spyOn> | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let sleepSpy: ReturnType<typeof spyOn> | undefined;
let processKillSpy: ReturnType<typeof spyOn> | undefined;

afterEach(async () => {
  spawnSpy?.mockRestore();
  fetchSpy?.mockRestore();
  sleepSpy?.mockRestore();
  processKillSpy?.mockRestore();
  // Clean up registry
  for (const d of allDevices()) {
    removeDevice(d.id);
  }
});

function mockHealthy() {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response("OK", { status: 200 }),
  );
  sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());
}

// --- Tests ---

describe("ensureDevice", () => {
  test("returns existing device if server is alive", async () => {
    const dev: RegisteredDevice = {
      id: "alive-dev",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: () => {}, pid: 1 } as any,
    };
    setDevice(dev);
    const result = await ensureDevice("alive-dev");
    expect(result).toBe(dev);
  });

  test("re-bootstraps when server process has exited", async () => {
    // Register a device with exited server process
    setDevice({
      id: "dead-dev",
      platform: "android",
      port: 8080,
      authToken: "tok",
      serverProcess: { exitCode: 1, kill: mock(() => {}), pid: 1 } as any,
    });

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(androidSpawnMock("dead-dev"));
    processKillSpy = spyOn(process, "kill").mockImplementation(() => true);
    mockHealthy();

    const result = await ensureDevice("dead-dev");
    expect(result.id).toBe("dead-dev");
    expect(result.platform).toBe("android");
    // Should be a new device with new port/token
    expect(result.authToken).not.toBe("tok");
  });

  test("throws when bootstrap fails to register device", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb") && args.includes("devices")) {
        return mockSubprocess(`List of devices attached\nfail-dev\tdevice\n`);
      }
      if (args.includes("forward --list")) return mockSubprocess("");
      if (args.includes("forward tcp:0")) return mockSubprocess("19222\n");
      // Instrument process exits immediately (simulates crash)
      if (args.includes("instrument")) {
        return {
          stdout: null, stderr: null,
          exited: Promise.resolve(1),
          exitCode: 1,
          pid: 100,
          kill: mock(() => {}),
        } as any;
      }
      return mockSubprocess("");
    });

    // Health poll: always fail (server crashed)
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());

    await expect(ensureDevice("fail-dev")).rejects.toThrow();
  });

  test("recovers after prior bootstrap failure (exercises chain .catch)", async () => {
    // First call: fails
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb") && args.includes("devices") && !args.includes("-s")) {
        return mockSubprocess(`List of devices attached\nretry-dev\tdevice\n`);
      }
      if (args.includes("forward --list")) return mockSubprocess("");
      if (args.includes("forward tcp:0")) return mockSubprocess("19222\n");
      if (args.includes("instrument")) {
        return { stdout: null, stderr: null, exited: Promise.resolve(1), exitCode: 1, pid: 1, kill: mock(() => {}) } as any;
      }
      return mockSubprocess("");
    });
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());

    await expect(ensureDevice("retry-dev")).rejects.toThrow();

    // Second call: succeeds (prior chain rejection is swallowed by .catch)
    spawnSpy.mockRestore();
    fetchSpy.mockRestore();
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(androidSpawnMock("retry-dev"));
    processKillSpy = spyOn(process, "kill").mockImplementation(() => true);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("OK", { status: 200 }),
    );

    const dev = await ensureDevice("retry-dev");
    expect(dev.id).toBe("retry-dev");
  });

  test("serializes concurrent bootstrap calls for same device", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(androidSpawnMock("serial-dev"));
    processKillSpy = spyOn(process, "kill").mockImplementation(() => true);
    mockHealthy();

    // Launch two concurrent ensureDevice calls
    const [a, b] = await Promise.all([
      ensureDevice("serial-dev"),
      ensureDevice("serial-dev"),
    ]);
    // Both should return the same device (second call reuses first's result)
    expect(a.id).toBe("serial-dev");
    expect(b.id).toBe("serial-dev");
    expect(a).toBe(b);
  });
});

describe("bootstrapAndroid", () => {
  test("installs APKs, sets up port forward, spawns server", async () => {
    const spawnCalls: string[][] = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any, opts?: any) => {
      const args = cmd as string[];
      spawnCalls.push(args);
      return androidSpawnMock("android-test")(cmd, opts);
    });
    processKillSpy = spyOn(process, "kill").mockImplementation(() => true);
    mockHealthy();

    const dev = await ensureDevice("android-test");
    expect(dev.platform).toBe("android");
    expect(dev.port).toBeGreaterThanOrEqual(18000);
    expect(dev.authToken).toHaveLength(64); // 32 random bytes → 64 hex chars

    // Verify APK installs happened
    const installCalls = spawnCalls.filter((c) => c.join(" ").includes("install"));
    expect(installCalls.length).toBeGreaterThan(0);

    // Verify port forward was set up
    const forwardCalls = spawnCalls.filter(
      (c) => c.join(" ").includes("forward") && c.join(" ").includes(`tcp:${dev.port}`),
    );
    expect(forwardCalls.length).toBeGreaterThan(0);

    // Verify instrument was spawned
    const instrumentCalls = spawnCalls.filter((c) => c.join(" ").includes("instrument"));
    expect(instrumentCalls).toHaveLength(1);

    // Verify CDP forwarding was set up
    const cdpForward = spawnCalls.filter((c) => c.join(" ").includes("forward tcp:0 localabstract:chrome_devtools_remote"));
    expect(cdpForward).toHaveLength(1);
    const cdpReverse = spawnCalls.filter((c) => c.join(" ").includes("reverse tcp:9222 tcp:19222"));
    expect(cdpReverse).toHaveLength(1);
  });

  test("throws when CDP forward port allocation fails", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb") && args.includes("devices") && !args.includes("-s")) {
        return mockSubprocess(`List of devices attached\ncdp-fail\tdevice\n`);
      }
      if (args.includes("forward --list")) return mockSubprocess("");
      // CDP forward returns empty (simulates adb failure)
      if (args.includes("forward tcp:0")) return mockSubprocess("");
      return mockSubprocess("");
    });
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());

    await expect(ensureDevice("cdp-fail")).rejects.toThrow("adb forward returned non-numeric stdout");
  });

  test("cleans up CDP forward when reverse fails", async () => {
    const spawnCalls: string[][] = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = cmd as string[];
      spawnCalls.push(args);
      const argsStr = args.join(" ");
      if (argsStr.includes("adb") && argsStr.includes("devices") && !argsStr.includes("-s")) {
        return mockSubprocess(`List of devices attached\ncdp-rev-fail\tdevice\n`);
      }
      if (argsStr.includes("forward --list")) return mockSubprocess("");
      if (argsStr.includes("forward tcp:0")) return mockSubprocess("19222\n");
      // Simulate reverse failure (Bun.spawn throws on system error)
      if (argsStr.includes("reverse tcp:9222 tcp:19222")) {
        throw new Error("adb reverse failed");
      }
      return mockSubprocess("");
    });
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());

    await expect(ensureDevice("cdp-rev-fail")).rejects.toThrow();

    // Verify the CDP forward was cleaned up after reverse failure
    const cleanupCalls = spawnCalls.filter(
      (c) => c.join(" ").includes("forward --remove tcp:19222"),
    );
    expect(cleanupCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("cleans up on failure (install succeeds, health fails)", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb") && args.includes("devices") && !args.includes("-s")) {
        return mockSubprocess(`List of devices attached\nfail-android\tdevice\n`);
      }
      if (args.includes("forward --list")) return mockSubprocess("");
      if (args.includes("forward tcp:0")) return mockSubprocess("19222\n");
      if (args.includes("instrument")) {
        return mockServerProcess();
      }
      return mockSubprocess("");
    });

    // Health poll: connection refused + time out
    const originalDateNow = Date.now;
    let fakeTime = originalDateNow.call(Date);
    const dateNowSpy = spyOn(Date, "now" as any).mockImplementation(() => fakeTime);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      fakeTime += 50_000; // jump past 45s timeout
      throw new Error("ECONNREFUSED");
    });
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());

    await expect(ensureDevice("fail-android")).rejects.toThrow("timed out");

    dateNowSpy.mockRestore();
  });
});

describe("bootstrapIOS", () => {
  test("bootstraps iOS simulator", async () => {
    const spawnCalls: string[][] = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any, opts?: any) => {
      const args = cmd as string[];
      spawnCalls.push(args);
      return iosSpawnMock("ios-sim-test", "simulator")(cmd, opts);
    });
    mockHealthy();

    const dev = await ensureDevice("ios-sim-test");
    expect(dev.platform).toBe("ios");
    expect(dev.deviceType).toBe("simulator");
    expect(dev.port).toBeGreaterThanOrEqual(19000);

    // Spec §2.4: simulators bootstrap through xcodebuild, like real devices
    const xcBuild = spawnCalls.find((c) => c[0] === "xcodebuild");
    expect(xcBuild).toBeDefined();
    expect(xcBuild!.join(" ")).toContain(`platform=iOS Simulator,id=ios-sim-test`);
    expect(xcBuild!.includes("-allowProvisioningUpdates")).toBe(false);
    // -xctestrun must come from drivers/ios (trailing slash excludes drivers/ios-device)
    const xctestrunArg = xcBuild![xcBuild!.indexOf("-xctestrun") + 1];
    expect(xctestrunArg).toContain(join("drivers", "ios") + "/");
    expect(spawnCalls.some((c) => c.join(" ").includes("simctl install"))).toBe(false);
    expect(spawnCalls.some((c) => c.join(" ").includes("simctl spawn"))).toBe(false);
    // No iproxy for simulator
    expect(spawnCalls.some((c) => c[0] === "iproxy")).toBe(false);
    // Tunnel process should not be set
    expect(dev.tunnelProcess).toBeUndefined();

    // Clean up iOS lock file
    unlockPort(dev.port);
  });

  test("bootstraps iOS real device with iproxy tunnel", async () => {
    // ios-device dir is empty — create a temp .xctestrun for this test
    writeFileSync(DUMMY_XCTESTRUN, "dummy");

    const spawnCalls: string[][] = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any, opts?: any) => {
      const args = cmd as string[];
      spawnCalls.push(args);
      return iosSpawnMock("ios-device-test", "device")(cmd, opts);
    });
    mockHealthy();

    try {
      const dev = await ensureDevice("ios-device-test");
      expect(dev.platform).toBe("ios");
      expect(dev.deviceType).toBe("device");

      // Verify iproxy was spawned for real device
      expect(spawnCalls.some((c) => c[0] === "iproxy")).toBe(true);
      // Verify xcodebuild includes -allowProvisioningUpdates
      const xcBuild = spawnCalls.find((c) => c[0] === "xcodebuild");
      expect(xcBuild).toBeDefined();
      expect(xcBuild!.includes("-allowProvisioningUpdates")).toBe(true);
      // Tunnel process should be set
      expect(dev.tunnelProcess).toBeDefined();

      unlockPort(dev.port);
    } finally {
      try { fsUnlink(DUMMY_XCTESTRUN); } catch {}
    }
  });

  test("cleans up on iOS failure (kills server and tunnel, unlocks port)", async () => {
    // Create temp .xctestrun for real device
    writeFileSync(DUMMY_XCTESTRUN, "dummy");

    const serverKill = mock(() => {});
    const tunnelKill = mock(() => {});
    let xcodebuildCalled = false;

    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
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
              { identifier: "ios-fail", connectionProperties: { transportType: "wired" } },
            ],
          },
        });
      }
      if (args.includes("lsof")) return mockSubprocess("");
      if (args.includes("xcodebuild")) {
        xcodebuildCalled = true;
        return {
          stdout: null, stderr: null,
          exited: new Promise<number>(() => {}),
          exitCode: null,
          pid: 777,
          kill: serverKill,
        } as any;
      }
      if (args.includes("iproxy")) {
        return {
          stdout: null, stderr: null,
          exited: new Promise<number>(() => {}),
          exitCode: null,
          pid: 888,
          kill: tunnelKill,
        } as any;
      }
      return mockSubprocess("");
    });

    // Health poll timeout
    const originalDateNow = Date.now;
    let fakeTime = originalDateNow.call(Date);
    const dateNowSpy = spyOn(Date, "now" as any).mockImplementation(() => fakeTime);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      fakeTime += 50_000;
      throw new Error("ECONNREFUSED");
    });
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());

    try {
      await expect(ensureDevice("ios-fail")).rejects.toThrow();
      expect(xcodebuildCalled).toBe(true);
      expect(serverKill).toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
      try { fsUnlink(DUMMY_XCTESTRUN); } catch {}
    }
  });

  test("throws when no .xctestrun driver found for iOS simulator", async () => {
    const originalReaddir = fs.readdirSync;
    const readdirSpy = spyOn(fs, "readdirSync").mockImplementation((path: any, opts?: any) => {
      // Return empty dir for the iOS simulator drivers directory
      if (String(path).endsWith(join("drivers", "ios"))) return [] as any;
      return originalReaddir(path, opts as any);
    });

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(iosSpawnMock("no-runner", "simulator"));
    mockHealthy();

    try {
      await expect(ensureDevice("no-runner")).rejects.toThrow("No .xctestrun driver");
    } finally {
      readdirSpy.mockRestore();
    }
  });

  test("throws when no xctestrun driver found for iOS device", async () => {
    // ios-device directory is empty — no .xctestrun file
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
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
              { identifier: "no-driver-dev", connectionProperties: { transportType: "wired" } },
            ],
          },
        });
      }
      if (args.includes("lsof")) return mockSubprocess("");
      return mockSubprocess("");
    });

    await expect(ensureDevice("no-driver-dev")).rejects.toThrow("No .xctestrun driver");
  });
});

describe("healthPoll", () => {
  test("succeeds when health endpoint returns OK", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(androidSpawnMock("health-ok"));
    processKillSpy = spyOn(process, "kill").mockImplementation(() => true);
    mockHealthy();

    const dev = await ensureDevice("health-ok");
    expect(dev.id).toBe("health-ok");
  });

  test("retries until server responds", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(androidSpawnMock("health-retry"));
    processKillSpy = spyOn(process, "kill").mockImplementation(() => true);

    let healthCount = 0;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      healthCount++;
      if (healthCount < 3) throw new Error("ECONNREFUSED");
      return new Response("OK", { status: 200 });
    });
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());

    const dev = await ensureDevice("health-retry");
    expect(dev.id).toBe("health-retry");
    expect(healthCount).toBe(3);
  });

  test("throws when server process dies during health poll", async () => {
    const serverProc = {
      stdout: null, stderr: null,
      exited: new Promise<number>(() => {}),
      exitCode: null as number | null,
      pid: 999,
      kill: mock(() => {}),
    };

    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = (cmd as string[]).join(" ");
      if (args.includes("adb") && args.includes("devices") && !args.includes("-s")) {
        return mockSubprocess(`List of devices attached\ndying-dev\tdevice\n`);
      }
      if (args.includes("forward --list")) return mockSubprocess("");
      if (args.includes("forward tcp:0")) return mockSubprocess("19222\n");
      if (args.includes("instrument")) return serverProc as any;
      return mockSubprocess("");
    });

    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      // Simulate process dying after first health check
      serverProc.exitCode = 1;
      throw new Error("ECONNREFUSED");
    });
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());

    await expect(ensureDevice("dying-dev")).rejects.toThrow("exited with code 1");
  });

  test("times out after HEALTH_TIMEOUT", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(androidSpawnMock("timeout-dev"));

    const originalDateNow = Date.now;
    let fakeTime = originalDateNow.call(Date);
    const dateNowSpy = spyOn(Date, "now" as any).mockImplementation(() => fakeTime);

    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      fakeTime += 50_000; // jump past deadline
      throw new Error("ECONNREFUSED");
    });
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());

    await expect(ensureDevice("timeout-dev")).rejects.toThrow("timed out");

    dateNowSpy.mockRestore();
  });
});

describe("cleanupStaleAndroid", () => {
  test("kills stale instrumentation and removes forwards", async () => {
    const spawnCalls: string[][] = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any, opts?: any) => {
      const args = cmd as string[];
      spawnCalls.push(args);
      const argsStr = args.join(" ");
      // detectPlatform: adb devices (no -s flag)
      if (argsStr.includes("adb") && argsStr.includes("devices") && !argsStr.includes("-s")) {
        return mockSubprocess(`List of devices attached\nstale-dev\tdevice\n`);
      }
      // cleanupStaleAndroid: adb -s stale-dev forward --list
      if (argsStr.includes("-s stale-dev") && argsStr.includes("forward --list")) {
        return mockSubprocess("stale-dev tcp:9999 tcp:9999\nstale-dev tcp:8888 tcp:8888\n");
      }
      // allocateAndroidPort: adb forward --list (global, no -s)
      if (argsStr.includes("forward --list")) {
        return mockSubprocess("");
      }
      // CDP port allocation
      if (argsStr.includes("forward tcp:0")) {
        return mockSubprocess("19222\n");
      }
      if (argsStr.includes("instrument")) return mockServerProcess();
      return mockSubprocess("");
    });
    processKillSpy = spyOn(process, "kill").mockImplementation(() => true);
    mockHealthy();

    await ensureDevice("stale-dev");

    // force-stop should have been called
    expect(spawnCalls.some((c) => c.join(" ").includes("force-stop"))).toBe(true);
    // stale forwards should have been removed
    expect(spawnCalls.some((c) => c.join(" ").includes("--remove") && c.join(" ").includes("tcp:9999"))).toBe(true);
    expect(spawnCalls.some((c) => c.join(" ").includes("--remove") && c.join(" ").includes("tcp:8888"))).toBe(true);
    // stale auth tokens should be cleaned
    expect(spawnCalls.some((c) => c.join(" ").includes("rm -f") && c.join(" ").includes(".mds_auth_"))).toBe(true);
  });
});
