import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import {
  existsSync, readFileSync, mkdirSync, writeFileSync,
  symlinkSync, renameSync, rmdirSync, unlinkSync as fsUnlinkSync, lstatSync,
} from "fs";
import {
  allocateAndroidPort,
  allocateIOSPort,
  addPendingPort,
  releasePendingPort,
  unlockPort,
  killPortListener,
  cleanupStalePorts,
} from "../src/server/ports";
import { setDevice, removeDevice, allDevices } from "../src/server/devices";
import type { RegisteredDevice } from "../src/server/types";

const LOCK_DIR = join(homedir(), ".mdms", "ports");

function fakeDevice(id: string, port: number): RegisteredDevice {
  return {
    id,
    platform: "android",
    port,
    authToken: "tok",
    serverProcess: { exitCode: null, kill: () => {}, pid: 0 } as any,
  };
}

// Track ports/locks allocated during tests for cleanup
const allocatedLocks: number[] = [];
const addedPending: number[] = [];

afterEach(() => {
  for (const d of allDevices()) {
    removeDevice(d.id);
  }
  for (const p of allocatedLocks) {
    unlockPort(p);
  }
  allocatedLocks.length = 0;
  for (const p of addedPending) {
    releasePendingPort(p);
  }
  addedPending.length = 0;
});

// Helper: allocate iOS port and track for cleanup
async function allocateIOSPortTracked(): Promise<number> {
  const port = await allocateIOSPort();
  allocatedLocks.push(port);
  return port;
}

function trackPending(port: number): void {
  addPendingPort(port);
  addedPending.push(port);
}

// ── Android port allocation ──

describe("allocateAndroidPort", () => {
  test("returns a port >= 18000", async () => {
    const port = await allocateAndroidPort();
    expect(port).toBeGreaterThanOrEqual(18000);
  });

  test("adding a device to registry shifts allocation higher", async () => {
    const baseline = await allocateAndroidPort();
    setDevice(fakeDevice("x", baseline));
    const next = await allocateAndroidPort();
    expect(next).toBeGreaterThan(baseline);
  });

  test("skips multiple occupied ports", async () => {
    const p1 = await allocateAndroidPort();
    setDevice(fakeDevice("a", p1));
    const p2 = await allocateAndroidPort();
    setDevice(fakeDevice("b", p2));
    const p3 = await allocateAndroidPort();
    expect(p3).toBeGreaterThan(p2);
    expect(p3).toBeGreaterThan(p1);
  });

  test("skips pending ports", async () => {
    const baseline = await allocateAndroidPort();
    trackPending(baseline);
    const next = await allocateAndroidPort();
    expect(next).toBeGreaterThan(baseline);
  });

  test("skips both registry and pending", async () => {
    const baseline = await allocateAndroidPort();
    setDevice(fakeDevice("a", baseline));
    trackPending(baseline + 1);
    const port = await allocateAndroidPort();
    expect(port).toBeGreaterThan(baseline + 1);
  });

  test("consecutive allocations are unique when registry grows", async () => {
    const ports: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await allocateAndroidPort();
      setDevice(fakeDevice(`d${i}`, p));
      ports.push(p);
    }
    const unique = new Set(ports);
    expect(unique.size).toBe(5);
  });
});

// ── Pending ports ──

describe("pending ports", () => {
  test("addPendingPort blocks allocation, releasePendingPort frees it", async () => {
    const baseline = await allocateAndroidPort();
    trackPending(baseline);
    const shifted = await allocateAndroidPort();
    expect(shifted).toBeGreaterThan(baseline);
    releasePendingPort(baseline);
    addedPending.pop(); // already released
    const restored = await allocateAndroidPort();
    expect(restored).toBe(baseline);
  });
});

// ── iOS port allocation + lock files ──

describe("allocateIOSPort", () => {
  test("returns a port >= 19000", async () => {
    const port = await allocateIOSPortTracked();
    expect(port).toBeGreaterThanOrEqual(19000);
  });

  test("creates a lock file with our PID", async () => {
    const port = await allocateIOSPortTracked();
    const lockPath = join(LOCK_DIR, String(port));
    expect(existsSync(lockPath)).toBe(true);
    const pid = readFileSync(lockPath, "utf-8").trim();
    expect(parseInt(pid, 10)).toBe(process.pid);
  });

  test("consecutive allocations return different ports", async () => {
    const first = await allocateIOSPortTracked();
    const second = await allocateIOSPortTracked();
    expect(second).toBeGreaterThan(first);
  });

  test("skips ports in device registry", async () => {
    const baseline = await allocateIOSPortTracked();
    unlockPort(baseline); // free the lock so registry is the only blocker
    allocatedLocks.pop();
    setDevice(fakeDevice("ios-1", baseline));
    const next = await allocateIOSPortTracked();
    expect(next).toBeGreaterThan(baseline);
  });

  test("skips pending ports", async () => {
    const baseline = await allocateIOSPortTracked();
    unlockPort(baseline);
    allocatedLocks.pop();
    trackPending(baseline);
    const next = await allocateIOSPortTracked();
    expect(next).toBeGreaterThan(baseline);
  });
});

describe("unlockPort", () => {
  test("removes lock file", async () => {
    const port = await allocateIOSPortTracked();
    const lockPath = join(LOCK_DIR, String(port));
    expect(existsSync(lockPath)).toBe(true);
    unlockPort(port);
    allocatedLocks.pop(); // already unlocked
    expect(existsSync(lockPath)).toBe(false);
  });

  test("does not throw for non-existent lock", () => {
    expect(() => unlockPort(99999)).not.toThrow();
  });
});

describe("lock file reclaim", () => {
  test("reclaims lock from dead PID", async () => {
    // Find a free port first
    const probe = await allocateIOSPortTracked();
    unlockPort(probe);
    allocatedLocks.pop();

    // Plant a lock file with a dead PID
    mkdirSync(LOCK_DIR, { recursive: true });
    writeFileSync(join(LOCK_DIR, String(probe)), "999999999", { flag: "w" });

    const port = await allocateIOSPortTracked();
    expect(port).toBe(probe);
    const pid = readFileSync(join(LOCK_DIR, String(probe)), "utf-8").trim();
    expect(parseInt(pid, 10)).toBe(process.pid);
  });

  test("reclaims lock with invalid content", async () => {
    const probe = await allocateIOSPortTracked();
    unlockPort(probe);
    allocatedLocks.pop();

    mkdirSync(LOCK_DIR, { recursive: true });
    writeFileSync(join(LOCK_DIR, String(probe)), "not-a-pid", { flag: "w" });

    const port = await allocateIOSPortTracked();
    expect(port).toBe(probe);
  });

  test("returns false when lock path is a directory (line 112 catch)", async () => {
    const probe = await allocateIOSPortTracked();
    // Keep probe locked so allocator can't use it

    // Block all ports below probe so allocator starts at probe
    for (let p = 19000; p < probe; p++) {
      trackPending(p);
    }

    // Create a directory at probe+1's lock path — readFileSync will throw EISDIR
    const lockPath = join(LOCK_DIR, String(probe + 1));
    mkdirSync(lockPath, { recursive: true });

    // Mock lsof so isPortListening returns false (port not in use)
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      exitCode: 0,
      pid: 1,
      kill: () => {},
    } as any));

    try {
      const port = await allocateIOSPortTracked();
      // Should skip probe (locked) and probe+1 (directory), so port >= probe+2
      expect(port).toBeGreaterThan(probe + 1);
    } finally {
      spawn.mockRestore();
      try { rmdirSync(lockPath); } catch {}
    }
  });
});

describe("isPortListening error handling", () => {
  test("treats lsof failure as port-not-listening (line 71-72)", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
      const args = Array.isArray(cmd) ? cmd : [];
      if (args[0] === "lsof") {
        throw new Error("lsof not found");
      }
      return {
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        exitCode: 0,
        pid: 1,
        kill: () => {},
      } as any;
    });

    try {
      const port = await allocateIOSPortTracked();
      expect(port).toBeGreaterThanOrEqual(19000);
    } finally {
      spawn.mockRestore();
    }
  });
});

describe("symlink protection", () => {
  test("throws when lock directory is a symlink (line 81)", async () => {
    const realLockDir = join(homedir(), ".mdms", "ports");
    const backupDir = join(homedir(), ".mdms", "ports_test_backup");
    const targetDir = join(homedir(), ".mdms", "ports_symlink_target");

    mkdirSync(targetDir, { recursive: true });

    let hadLockDir = false;
    try { renameSync(realLockDir, backupDir); hadLockDir = true; } catch {}
    symlinkSync(targetDir, realLockDir);

    try {
      await expect(allocateIOSPort()).rejects.toThrow("symlink");
    } finally {
      try { fsUnlinkSync(realLockDir); } catch {}
      if (hadLockDir) {
        try { renameSync(backupDir, realLockDir); } catch {}
      }
      try { rmdirSync(targetDir); } catch {}
    }
  });
});

describe("port exhaustion", () => {
  test("throws when all iOS ports are pending", async () => {
    for (let p = 19000; p <= 65535; p++) {
      addPendingPort(p);
      addedPending.push(p);
    }
    await expect(allocateIOSPort()).rejects.toThrow("No available ports");
  });

  test("throws when all Android ports are occupied", async () => {
    for (let p = 18000; p <= 65535; p++) {
      addPendingPort(p);
      addedPending.push(p);
    }
    await expect(allocateAndroidPort()).rejects.toThrow("No available ports");
  });
});

describe("getADBForwardedPorts (via allocateAndroidPort)", () => {
  test("skips ports found in adb forward --list", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
      stdout: new Response("emulator-5554 tcp:18000 tcp:18000\nemulator-5554 tcp:18001 tcp:18001\n").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      exitCode: 0,
      pid: 1,
      kill: () => {},
    } as any));

    try {
      const port = await allocateAndroidPort();
      expect(port).toBe(18002);
    } finally {
      spawn.mockRestore();
    }
  });
});

describe("killPortListener", () => {
  test("kills process found by lsof", async () => {
    const killMock = spyOn(process, "kill").mockImplementation(() => true);
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
      stdout: new Response("12345\n").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    } as any));

    try {
      await killPortListener(19099);
      expect(killMock).toHaveBeenCalledWith(12345, "SIGKILL");
    } finally {
      spawn.mockRestore();
      killMock.mockRestore();
    }
  });

  test("handles empty lsof output (no listener)", async () => {
    const killMock = spyOn(process, "kill").mockImplementation(() => true);
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: Promise.resolve(1),
    } as any));

    try {
      await killPortListener(19099);
      expect(killMock).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      killMock.mockRestore();
    }
  });

  test("handles lsof spawn failure gracefully", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("lsof missing");
    });

    try {
      await expect(killPortListener(19099)).resolves.toBeUndefined();
    } finally {
      spawn.mockRestore();
    }
  });
});

describe("cleanupStalePorts", () => {
  test("returns early when lock dir does not exist", async () => {
    const realLockDir = join(homedir(), ".mdms", "ports");
    const backupDir = join(homedir(), ".mdms", "ports_stale_backup");
    let hadDir = false;
    try { renameSync(realLockDir, backupDir); hadDir = true; } catch {}

    try {
      await expect(cleanupStalePorts()).resolves.toBeUndefined();
    } finally {
      if (hadDir) {
        try { renameSync(backupDir, realLockDir); } catch {}
      }
    }
  });

  test("skips ports with alive owner", async () => {
    mkdirSync(LOCK_DIR, { recursive: true });
    const testPort = 19600;
    const lockFile = join(LOCK_DIR, String(testPort));
    writeFileSync(lockFile, String(process.pid)); // our PID = alive

    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    } as any));

    try {
      await cleanupStalePorts();
      expect(existsSync(lockFile)).toBe(true);
    } finally {
      try { fsUnlinkSync(lockFile); } catch {}
      spawn.mockRestore();
    }
  });

  test("kills listener and removes lock for dead owner", async () => {
    mkdirSync(LOCK_DIR, { recursive: true });
    const testPort = 19601;
    const lockFile = join(LOCK_DIR, String(testPort));
    writeFileSync(lockFile, "999999999"); // dead PID

    const killMock = spyOn(process, "kill").mockImplementation((pid: number, signal?: any) => {
      if (signal === 0) {
        if (pid === process.pid) return true; // our process is alive
        throw new Error("ESRCH"); // all others dead
      }
      return true; // SIGKILL succeeds
    });
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
      stdout: new Response("54321\n").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    } as any));

    try {
      await cleanupStalePorts();
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      try { fsUnlinkSync(lockFile); } catch {}
      spawn.mockRestore();
      killMock.mockRestore();
    }
  });

  test("skips non-numeric filenames in lock dir", async () => {
    mkdirSync(LOCK_DIR, { recursive: true });
    const junkFile = join(LOCK_DIR, "not-a-port");
    writeFileSync(junkFile, "junk");

    try {
      await expect(cleanupStalePorts()).resolves.toBeUndefined();
    } finally {
      try { fsUnlinkSync(junkFile); } catch {}
    }
  });
});
