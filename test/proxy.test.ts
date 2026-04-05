import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import type { Server } from "bun";
import { setDevice, removeDevice, allDevices } from "../src/server/devices";
import { proxyGet, proxyGetBinary, proxyPost, proxyPostBody, proxyRequest } from "../src/server/proxy";

const FAKE_TOKEN = "test-auth-token-12345";
const DEVICE_ID = "proxy-test-device";
let server: Server;
let requestCount = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requestCount++;
      const url = new URL(req.url);

      const auth = req.headers.get("Authorization");
      if (auth !== `Bearer ${FAKE_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      switch (url.pathname) {
        case "/text":
          return new Response("hello world");

        case "/binary":
          return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));

        case "/post-query": {
          const x = url.searchParams.get("x");
          const y = url.searchParams.get("y");
          return new Response(`x=${x},y=${y}`);
        }

        case "/post-body": {
          const body = await req.text();
          return new Response(`body=${body}`);
        }

        case "/echo-headers": {
          const ct = req.headers.get("Content-Type") ?? "none";
          return new Response(ct);
        }

        case "/error-500":
          return new Response("Internal server error", { status: 500 });

        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });
});

beforeEach(() => {
  requestCount = 0;
  // Ensure our test device is registered fresh each test
  removeDevice(DEVICE_ID);
  setDevice({
    id: DEVICE_ID,
    platform: "android",
    port: server.port,
    authToken: FAKE_TOKEN,
    serverProcess: { exitCode: null, kill: () => {}, pid: 0 } as any,
  });
});

afterEach(() => {
  // Clean up any extra devices tests may have added
  for (const d of allDevices()) {
    if (d.id !== DEVICE_ID) removeDevice(d.id);
  }
});

afterAll(() => {
  removeDevice(DEVICE_ID);
  server?.stop();
});

// --- Tests ---

describe("proxyGet", () => {
  test("returns text response", async () => {
    const result = await proxyGet(DEVICE_ID, "/text");
    expect(result).toBe("hello world");
  });
});

describe("proxyGetBinary", () => {
  test("returns Buffer with correct bytes", async () => {
    const result = await proxyGetBinary(DEVICE_ID, "/binary");
    expect(result).toBeInstanceOf(Buffer);
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
  });
});

describe("proxyPost", () => {
  test("encodes query params in URL", async () => {
    const result = await proxyPost(DEVICE_ID, "/post-query", { x: 100, y: 200 });
    expect(result).toBe("x=100,y=200");
  });
});

describe("proxyPostBody", () => {
  test("sends body as text/plain", async () => {
    const result = await proxyPostBody(DEVICE_ID, "/post-body", "console.log('hi')");
    expect(result).toBe("body=console.log('hi')");
  });

  test("sends Content-Type text/plain", async () => {
    const ct = await proxyPostBody(DEVICE_ID, "/echo-headers", "some code");
    expect(ct).toContain("text/plain");
  });
});

describe("error handling", () => {
  test("throws on non-OK response with status info", async () => {
    await expect(proxyGet(DEVICE_ID, "/error-500")).rejects.toThrow("500");
  });

  test("includes response body in error message", async () => {
    await expect(proxyGet(DEVICE_ID, "/error-500")).rejects.toThrow(
      "Internal server error",
    );
  });

  test("server error (500) does not retry — exactly one request", async () => {
    await proxyGet(DEVICE_ID, "/error-500").catch(() => {});
    expect(requestCount).toBe(1);
  });
});

describe("connection error", () => {
  test("throws when device server is unreachable", async () => {
    // Bind a server, grab its port, then stop it — guarantees nothing is listening
    const tmpServer = Bun.serve({ port: 0, fetch: () => new Response("") });
    const deadPort = tmpServer.port;
    tmpServer.stop(true);

    setDevice({
      id: "dead-device",
      platform: "android",
      port: deadPort,
      authToken: "tok",
      serverProcess: { exitCode: null, kill: () => {}, pid: 0 } as any,
    });

    await expect(
      proxyRequest("dead-device", { method: "GET", path: "/health" }),
    ).rejects.toThrow();
  });
});

describe("concurrency", () => {
  test("concurrent requests to same device all succeed", async () => {
    const results = await Promise.all([
      proxyGet(DEVICE_ID, "/text"),
      proxyGet(DEVICE_ID, "/text"),
      proxyGet(DEVICE_ID, "/text"),
    ]);
    for (const r of results) {
      expect(r).toBe("hello world");
    }
  });
});
