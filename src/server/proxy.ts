import type { RegisteredDevice } from "./types.js";
import { ensureDevice } from "./bootstrap.js";
import { removeDevice, cleanupDevice } from "./devices.js";

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("fetch failed") ||
    msg.includes("socket") ||
    msg.includes("Unable to connect") ||
    msg.includes("timed out") ||
    msg.includes("ETIMEDOUT")
  );
}

function buildUrl(port: number, path: string, queryParams?: Record<string, string | number>): string {
  let url = `http://127.0.0.1:${port}${path}`;
  if (queryParams && Object.keys(queryParams).length > 0) {
    const parts = Object.entries(queryParams).map(
      ([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`,
    );
    url += `?${parts.join("&")}`;
  }
  return url;
}

type ProxyRequest =
  | { method: "GET"; path: string; binary?: false }
  | { method: "GET"; path: string; binary: true }
  | { method: "POST"; path: string; queryParams: Record<string, string | number> }
  | { method: "POST"; path: string; body: string };

function authHeaders(device: RegisteredDevice): Record<string, string> {
  return { "Authorization": `Bearer ${device.authToken}` };
}

// Deliberately no client-side request timeout: an abort does not cancel
// server-side work, so a timeout here only orphans in-flight work and poisons
// the next request.
// Detection coverage: a dead server fails fast (refused connection, closed
// socket, exitCode in ensureDevice). A live-but-stuck server is not covered —
// it relies on XCTest's internal bounds (~60s) and on XCTest killing hung
// tests, which converts stuck into dead.
async function executeRequest(device: RegisteredDevice, req: ProxyRequest): Promise<Response> {
  const headers = authHeaders(device);
  if (req.method === "GET") {
    return fetch(buildUrl(device.port, req.path), { headers });
  }
  if ("queryParams" in req) {
    return fetch(buildUrl(device.port, req.path, req.queryParams), { method: "POST", headers });
  }
  // POST with body
  return fetch(buildUrl(device.port, req.path), {
    method: "POST",
    headers: { ...headers, "Content-Type": "text/plain" },
    body: req.body,
  });
}

export async function proxyRequest(
  deviceId: string,
  req: ProxyRequest,
): Promise<string | Buffer> {
  let device = await ensureDevice(deviceId);

  const attempt = async (dev: RegisteredDevice): Promise<string | Buffer> => {
    const res = await executeRequest(dev, req);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `${req.method} ${req.path} failed: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
      );
    }
    if (req.method === "GET" && "binary" in req && req.binary) {
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    return res.text();
  };

  try {
    return await attempt(device);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    // Spec §2.3: on connection error, remove the device, re-bootstrap, retry once.
    const old = removeDevice(deviceId);
    if (old) await cleanupDevice(old);
    device = await ensureDevice(deviceId);
    return attempt(device);
  }
}

// Convenience wrappers

export async function proxyGet(deviceId: string, path: string): Promise<string> {
  return proxyRequest(deviceId, { method: "GET", path }) as Promise<string>;
}

export async function proxyGetBinary(deviceId: string, path: string): Promise<Buffer> {
  return proxyRequest(deviceId, { method: "GET", path, binary: true }) as Promise<Buffer>;
}

export async function proxyPost(
  deviceId: string,
  path: string,
  queryParams: Record<string, string | number>,
): Promise<string> {
  return proxyRequest(deviceId, { method: "POST", path, queryParams }) as Promise<string>;
}

export async function proxyPostBody(
  deviceId: string,
  path: string,
  body: string,
): Promise<string> {
  return proxyRequest(deviceId, { method: "POST", path, body }) as Promise<string>;
}
