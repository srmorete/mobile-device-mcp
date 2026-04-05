import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import type { Server } from "bun";
import { setDevice, removeDevice } from "../src/server/devices";

const FAKE_TOKEN = "tools-test-token";
const DEVICE_ID = "tools-test-device";

// Track last request received by fake server
let lastRequest: {
  method: string;
  path: string;
  params: Record<string, string>;
  body: string;
} | null = null;

// Per-path response overrides for fake server
let serverResponses: Record<string, { status?: number; body: any; binary?: boolean }> = {};

// --- Fake server + tool registration ---

type ToolHandler = (params: any) => Promise<any>;
const toolMap = new Map<string, ToolHandler>();
let server: Server;

function callTool(name: string, params: any = {}): Promise<any> {
  const handler = toolMap.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(params);
}

function setDevicePlatform(platform: "android" | "ios") {
  removeDevice(DEVICE_ID);
  setDevice({
    id: DEVICE_ID,
    platform,
    port: server.port,
    authToken: FAKE_TOKEN,
    serverProcess: { exitCode: null, kill: () => {}, pid: 0 } as any,
  });
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const params: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { params[k] = v; });
      const body = req.method === "POST" ? await req.text() : "";

      lastRequest = { method: req.method, path: url.pathname, params, body };

      const auth = req.headers.get("Authorization");
      if (auth !== `Bearer ${FAKE_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const resp = serverResponses[url.pathname];
      if (resp) {
        const status = resp.status ?? 200;
        if (resp.binary) return new Response(resp.body, { status });
        if (typeof resp.body === "object") return Response.json(resp.body, { status });
        return new Response(String(resp.body), { status });
      }
      return new Response("OK");
    },
  });

  setDevicePlatform("android");

  const { registerTools } = await import("../src/server/tools.js");
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      toolMap.set(name, handler);
    },
  };
  registerTools(fakeServer as any);
});

afterAll(() => {
  removeDevice(DEVICE_ID);
  server?.stop();
});

beforeEach(() => {
  lastRequest = null;
  serverResponses = {};
  setDevicePlatform("android");
});

// --- Fixtures ---

const UITREE_RESPONSE = {
  screenWidth: 1080,
  screenHeight: 1920,
  nodes: [
    {
      className: "android.widget.Button", text: "Login",
      hintText: null, contentDesc: null, resourceId: null, packageName: null,
      bounds: { left: 100, top: 200, right: 300, bottom: 260 },
      checkable: false, checked: false, clickable: true, enabled: true,
      focusable: true, focused: false, scrollable: false,
      longClickable: false, password: false, selected: false,
      visibleToUser: true, children: [],
    },
    {
      className: "android.widget.TextView", text: "Welcome",
      hintText: null, contentDesc: null, resourceId: null, packageName: null,
      bounds: { left: 50, top: 100, right: 500, bottom: 150 },
      checkable: false, checked: false, clickable: false, enabled: true,
      focusable: false, focused: false, scrollable: false,
      longClickable: false, password: false, selected: false,
      visibleToUser: true, children: [],
    },
    {
      className: "android.widget.EditText", text: "user@example.com",
      hintText: "Email", contentDesc: null, resourceId: null, packageName: null,
      bounds: { left: 100, top: 300, right: 500, bottom: 360 },
      checkable: false, checked: false, clickable: false, enabled: true,
      focusable: true, focused: true, scrollable: false,
      longClickable: false, password: false, selected: false,
      visibleToUser: true, children: [],
    },
  ],
};

// --- Tests ---

describe("screenshot", () => {
  test("detects JPEG from magic bytes", async () => {
    serverResponses["/screenshot"] = {
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      binary: true,
    };
    const result = await callTool("screenshot", { device_id: DEVICE_ID });
    expect(result.content[0].type).toBe("image");
    expect(result.content[0].mimeType).toBe("image/jpeg");
  });

  test("detects PNG from magic bytes", async () => {
    serverResponses["/screenshot"] = {
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
      binary: true,
    };
    const result = await callTool("screenshot", { device_id: DEVICE_ID });
    expect(result.content[0].mimeType).toBe("image/png");
  });

  test("returns error for empty screenshot", async () => {
    serverResponses["/screenshot"] = {
      body: new Uint8Array(0),
      binary: true,
    };
    const result = await callTool("screenshot", { device_id: DEVICE_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Empty screenshot");
  });

  test("returns base64 encoded data", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    serverResponses["/screenshot"] = { body: bytes, binary: true };
    const result = await callTool("screenshot", { device_id: DEVICE_ID });
    expect(result.content[0].data).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("uitree", () => {
  test("returns filtered JSONL", async () => {
    serverResponses["/uitree"] = { body: UITREE_RESPONSE };
    const result = await callTool("uitree", { device_id: DEVICE_ID });
    const lines = result.content[0].text.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("text");
      expect(parsed).toHaveProperty("bounds");
      expect(parsed).toHaveProperty("center");
      expect(parsed).toHaveProperty("type");
    }
  });

  test("search filters by text (case-insensitive)", async () => {
    serverResponses["/uitree"] = { body: UITREE_RESPONSE };
    const result = await callTool("uitree", { device_id: DEVICE_ID, search: "login" });
    const lines = result.content[0].text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).text).toBe("Login");
  });

  test("limit truncates and adds suffix", async () => {
    serverResponses["/uitree"] = { body: UITREE_RESPONSE };
    const result = await callTool("uitree", { device_id: DEVICE_ID, limit: 1 });
    const text = result.content[0].text;
    expect(text).toContain("showing 1 of 3 elements");
    const firstLine = text.split("\n")[0];
    expect(() => JSON.parse(firstLine)).not.toThrow();
  });

  test("limit not applied when total <= limit", async () => {
    serverResponses["/uitree"] = { body: UITREE_RESPONSE };
    const result = await callTool("uitree", { device_id: DEVICE_ID, limit: 10 });
    expect(result.content[0].text).not.toContain("showing");
  });
});

describe("launch_app", () => {
  test("uses packageName for Android", async () => {
    setDevicePlatform("android");
    await callTool("launch_app", { device_id: DEVICE_ID, app_id: "com.example.app" });
    expect(lastRequest!.path).toBe("/launchApp");
    expect(lastRequest!.params.packageName).toBe("com.example.app");
    expect(lastRequest!.params.bundleId).toBeUndefined();
  });

  test("uses bundleId for iOS", async () => {
    setDevicePlatform("ios");
    await callTool("launch_app", { device_id: DEVICE_ID, app_id: "com.example.app" });
    expect(lastRequest!.params.bundleId).toBe("com.example.app");
    expect(lastRequest!.params.packageName).toBeUndefined();
  });
});

describe("terminate_app", () => {
  test("uses packageName for Android", async () => {
    await callTool("terminate_app", { device_id: DEVICE_ID, app_id: "com.example.app" });
    expect(lastRequest!.path).toBe("/terminateApp");
    expect(lastRequest!.params.packageName).toBe("com.example.app");
  });

  test("uses bundleId for iOS", async () => {
    setDevicePlatform("ios");
    await callTool("terminate_app", { device_id: DEVICE_ID, app_id: "com.example.app" });
    expect(lastRequest!.params.bundleId).toBe("com.example.app");
  });
});

describe("tap", () => {
  test("sends x,y as query params", async () => {
    await callTool("tap", { device_id: DEVICE_ID, x: 100, y: 200 });
    expect(lastRequest!.path).toBe("/tap");
    expect(lastRequest!.params.x).toBe("100");
    expect(lastRequest!.params.y).toBe("200");
  });
});

describe("run_code", () => {
  test("sends code as body to /exec", async () => {
    serverResponses["/exec"] = { body: '{"result":"42","logs":[]}' };
    const result = await callTool("run_code", { device_id: DEVICE_ID, code: "1 + 1" });
    expect(lastRequest!.path).toBe("/exec");
    expect(lastRequest!.body).toBe("1 + 1");
    expect(result.content[0].text).toContain('"result":"42"');
  });
});

describe("list_devices", () => {
  test("returns valid JSON array", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      exitCode: 0,
      pid: 1,
      kill: () => {},
    } as any));
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
    const result = await callTool("list_devices", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    spawn.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe("double_tap", () => {
  test("sends request to /doubleTap", async () => {
    await callTool("double_tap", { device_id: DEVICE_ID, x: 150, y: 250 });
    expect(lastRequest!.path).toBe("/doubleTap");
    expect(lastRequest!.params.x).toBe("150");
    expect(lastRequest!.params.y).toBe("250");
  });
});

describe("long_press", () => {
  test("sends request without duration", async () => {
    await callTool("long_press", { device_id: DEVICE_ID, x: 100, y: 200 });
    expect(lastRequest!.path).toBe("/longPress");
    expect(lastRequest!.params.x).toBe("100");
    expect(lastRequest!.params.duration).toBeUndefined();
  });

  test("sends request with duration", async () => {
    await callTool("long_press", { device_id: DEVICE_ID, x: 100, y: 200, duration: 2000 });
    expect(lastRequest!.path).toBe("/longPress");
    expect(lastRequest!.params.duration).toBe("2000");
  });
});

describe("scroll", () => {
  test("sends scroll coordinates", async () => {
    await callTool("scroll", {
      device_id: DEVICE_ID, startX: 100, startY: 500, endX: 100, endY: 100,
    });
    expect(lastRequest!.path).toBe("/scroll");
    expect(lastRequest!.params.startX).toBe("100");
    expect(lastRequest!.params.endY).toBe("100");
  });
});

describe("type_text", () => {
  test("sends text to /type", async () => {
    await callTool("type_text", { device_id: DEVICE_ID, text: "hello world" });
    expect(lastRequest!.path).toBe("/type");
    expect(lastRequest!.params.text).toBe("hello world");
  });
});

describe("press_button", () => {
  test("sends button to /press", async () => {
    await callTool("press_button", { device_id: DEVICE_ID, button: "home" });
    expect(lastRequest!.path).toBe("/press");
    expect(lastRequest!.params.button).toBe("home");
  });
});

describe("list_apps", () => {
  test("returns app list from /listApps", async () => {
    serverResponses["/listApps"] = { body: '[{"packageName":"com.example"}]' };
    const result = await callTool("list_apps", { device_id: DEVICE_ID });
    expect(result.content[0].text).toContain("com.example");
  });
});

describe("error handling", () => {
  test("returns isError on server error", async () => {
    serverResponses["/tap"] = { body: "Internal error", status: 500 };
    const result = await callTool("tap", { device_id: DEVICE_ID, x: 100, y: 200 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("500");
  });

  test("screenshot error returns isError", async () => {
    serverResponses["/screenshot"] = { body: "Device error", status: 500 };
    const result = await callTool("screenshot", { device_id: DEVICE_ID });
    expect(result.isError).toBe(true);
  });

  test("uitree error returns isError", async () => {
    serverResponses["/uitree"] = { body: "Timeout", status: 500 };
    const result = await callTool("uitree", { device_id: DEVICE_ID });
    expect(result.isError).toBe(true);
  });

  test("double_tap error returns isError", async () => {
    serverResponses["/doubleTap"] = { body: "fail", status: 500 };
    const result = await callTool("double_tap", { device_id: DEVICE_ID, x: 1, y: 1 });
    expect(result.isError).toBe(true);
  });

  test("long_press error returns isError", async () => {
    serverResponses["/longPress"] = { body: "fail", status: 500 };
    const result = await callTool("long_press", { device_id: DEVICE_ID, x: 1, y: 1 });
    expect(result.isError).toBe(true);
  });

  test("scroll error returns isError", async () => {
    serverResponses["/scroll"] = { body: "fail", status: 500 };
    const result = await callTool("scroll", {
      device_id: DEVICE_ID, startX: 0, startY: 0, endX: 0, endY: 0,
    });
    expect(result.isError).toBe(true);
  });

  test("type_text error returns isError", async () => {
    serverResponses["/type"] = { body: "fail", status: 500 };
    const result = await callTool("type_text", { device_id: DEVICE_ID, text: "t" });
    expect(result.isError).toBe(true);
  });

  test("press_button error returns isError", async () => {
    serverResponses["/press"] = { body: "fail", status: 500 };
    const result = await callTool("press_button", { device_id: DEVICE_ID, button: "back" });
    expect(result.isError).toBe(true);
  });

  test("launch_app error returns isError", async () => {
    serverResponses["/launchApp"] = { body: "App not found", status: 500 };
    const result = await callTool("launch_app", { device_id: DEVICE_ID, app_id: "com.bad" });
    expect(result.isError).toBe(true);
  });

  test("terminate_app error returns isError", async () => {
    serverResponses["/terminateApp"] = { body: "Not running", status: 500 };
    const result = await callTool("terminate_app", { device_id: DEVICE_ID, app_id: "com.bad" });
    expect(result.isError).toBe(true);
  });

  test("list_apps error returns isError", async () => {
    serverResponses["/listApps"] = { body: "fail", status: 500 };
    const result = await callTool("list_apps", { device_id: DEVICE_ID });
    expect(result.isError).toBe(true);
  });

  test("run_code error returns isError", async () => {
    serverResponses["/exec"] = { body: "fail", status: 500 };
    const result = await callTool("run_code", { device_id: DEVICE_ID, code: "x" });
    expect(result.isError).toBe(true);
  });
});
