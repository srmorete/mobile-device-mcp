import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { allDevices } from "./devices.js";

const BASE_PORT_IOS = parseInt(process.env.MDMS_PORT_IOS || "19000", 10);
const BASE_PORT_ANDROID = parseInt(process.env.MDMS_PORT_ANDROID || "18000", 10);
const LOCK_DIR = join(homedir(), ".mdms", "ports");

// Pending ports: tracked during bootstrap, released after health check
const pendingPorts = new Set<number>();

export function addPendingPort(port: number): void {
  pendingPorts.add(port);
}

export function releasePendingPort(port: number): void {
  pendingPorts.delete(port);
}

function registryPorts(): Set<number> {
  const ports = new Set<number>();
  for (const device of allDevices()) {
    ports.add(device.port);
  }
  return ports;
}

// ── Android port allocation ──

async function getADBForwardedPorts(): Promise<Set<number>> {
  const ports = new Set<number>();
  try {
    const proc = Bun.spawn(["adb", "forward", "--list"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    // Lines: <serial> tcp:<hostPort> <deviceSpec>
    // Only track the host-side port (second column)
    for (const line of output.split("\n")) {
      const match = line.match(/^\S+\s+tcp:(\d+)/);
      if (match) {
        ports.add(parseInt(match[1], 10));
      }
    }
  } catch { /* adb not available */ }
  return ports;
}

export async function allocateAndroidPort(): Promise<number> {
  const adbPorts = await getADBForwardedPorts();
  const regPorts = registryPorts();
  const usedPorts = new Set([...pendingPorts, ...regPorts, ...adbPorts]);

  let port = BASE_PORT_ANDROID;
  while (usedPorts.has(port)) port++;

  if (port > 65535) {
    throw new Error("No available ports for Android device server");
  }
  return port;
}

// ── iOS port allocation ──

async function isPortListening(port: number): Promise<boolean> {
  try {
    const proc = Bun.spawn(["lsof", "-i", `TCP:${port}`, "-sTCP:LISTEN"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function ensureLockDir(): void {
  mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  // Always verify the result is not a symlink (prevents symlink attacks)
  const stat = lstatSync(LOCK_DIR);
  if (stat.isSymbolicLink()) {
    throw new Error(`Lock directory is a symlink — refusing to use it`);
  }
}

function tryLockPort(port: number): boolean {
  ensureLockDir();

  const lockFile = `${LOCK_DIR}/${port}`;
  try {
    // Try exclusive create
    writeFileSync(lockFile, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // File exists — check if the owning process is alive
    try {
      const pid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
      if (isNaN(pid)) {
        // Invalid content, reclaim
        unlinkSync(lockFile);
        writeFileSync(lockFile, String(process.pid), { flag: "wx" });
        return true;
      }
      try {
        process.kill(pid, 0); // check if alive
        return false; // alive, lock fails
      } catch {
        // Dead process, reclaim
        unlinkSync(lockFile);
        writeFileSync(lockFile, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch {
      return false;
    }
  }
}

export function unlockPort(port: number): void {
  try {
    unlinkSync(`${LOCK_DIR}/${port}`);
  } catch { /* file may not exist */ }
}

export async function allocateIOSPort(): Promise<number> {
  const regPorts = registryPorts();
  const usedPorts = new Set([...pendingPorts, ...regPorts]);

  let port = BASE_PORT_IOS;
  while (port <= 65535) {
    if (!usedPorts.has(port) && !(await isPortListening(port)) && tryLockPort(port)) {
      return port;
    }
    port++;
  }
  throw new Error("No available ports for iOS device server");
}

// ── Stale port cleanup ──

export async function killPortListener(port: number): Promise<void> {
  try {
    const proc = Bun.spawn(
      ["lsof", "-ti", `TCP:${port}`, "-sTCP:LISTEN"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of output.trim().split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (!isNaN(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
    }
  } catch { /* lsof not available */ }
}

export async function cleanupStalePorts(): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(LOCK_DIR);
  } catch {
    return; // lock dir doesn't exist yet
  }

  for (const file of files) {
    const port = parseInt(file, 10);
    if (isNaN(port)) continue;

    const lockFile = join(LOCK_DIR, file);
    let ownerAlive = false;
    try {
      const pid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          ownerAlive = true;
        } catch { /* dead */ }
      }
    } catch { continue; }

    if (ownerAlive) continue;

    // Owner MCP is dead — kill whatever is still listening on this port
    await killPortListener(port);
    try { unlinkSync(lockFile); } catch { /* */ }
  }
}
