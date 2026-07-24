import { z } from "zod";
import { statSync } from "fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { discoverDevices, detectPlatform, getDevice, runCommand } from "./devices.js";
import { proxyGet, proxyGetBinary, proxyPost, proxyPostBody } from "./proxy.js";
import { ensureDevice } from "./bootstrap.js";
import { filterUITree } from "../filter/filter.js";
import type { FilteredElement } from "../filter/types.js";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function imageResult(base64: string, mimeType: string): CallToolResult {
  return { content: [{ type: "image", data: base64, mimeType }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function registerTools(server: McpServer): void {
  // ── 2.2.1 list_devices ──
  server.tool(
    "list_devices",
    "Lists available mobile devices",
    {},
    async () => {
      const result = await discoverDevices();
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  // ── 2.2.2 tap ──
  server.tool(
    "tap",
    "Taps at coordinates on the device screen",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      x: z.number(),
      y: z.number(),
    },
    async ({ device_id, x, y }) => {
      try {
        const text = await proxyPost(device_id, "/tap", { x, y });
        return textResult(text);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.3 double_tap ──
  server.tool(
    "double_tap",
    "Double-taps at coordinates on the device screen",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      x: z.number(),
      y: z.number(),
    },
    async ({ device_id, x, y }) => {
      try {
        const text = await proxyPost(device_id, "/doubleTap", { x, y });
        return textResult(text);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.4 long_press ──
  server.tool(
    "long_press",
    "Long-presses at coordinates on the device screen",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      x: z.number(),
      y: z.number(),
      duration: z.number().min(1).max(10000).optional(),
    },
    async ({ device_id, x, y, duration }) => {
      try {
        const params: Record<string, string | number> = { x, y };
        if (duration !== undefined) {
          params.duration = duration;
        }
        const text = await proxyPost(device_id, "/longPress", params);
        return textResult(text);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.5 scroll ──
  server.tool(
    "scroll",
    "Scrolls on the device screen from start to end coordinates",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      startX: z.number(),
      startY: z.number(),
      endX: z.number(),
      endY: z.number(),
    },
    async ({ device_id, startX, startY, endX, endY }) => {
      try {
        const text = await proxyPost(device_id, "/scroll", { startX, startY, endX, endY });
        return textResult(text);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.6 type_text ──
  server.tool(
    "type_text",
    "Types text on the device",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      text: z.string().max(10_000),
    },
    async ({ device_id, text }) => {
      try {
        const result = await proxyPost(device_id, "/type", { text });
        return textResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.7 press_button ──
  server.tool(
    "press_button",
    "Presses a hardware/navigation button on the device",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      button: z.enum([
        "home",
        "back",
        "volumeUp",
        "volumeDown",
        "enter",
        "dpadUp",
        "dpadDown",
        "dpadLeft",
        "dpadRight",
        "dpadCenter",
      ]),
    },
    async ({ device_id, button }) => {
      try {
        const text = await proxyPost(device_id, "/press", { button });
        return textResult(text);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.8 screenshot ──
  server.tool(
    "screenshot",
    "Takes a screenshot of the device screen",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
    },
    async ({ device_id }) => {
      try {
        const buf = await proxyGetBinary(device_id, "/screenshot");
        if (buf.length === 0) {
          return errorResult("Empty screenshot response from device");
        }
        return imageResult(buf.toString("base64"), "image/jpeg");
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.9 uitree ──
  server.tool(
    "uitree",
    "Returns the UI element tree of the device screen",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      search: z.string().optional(),
      limit: z.number().int().min(1).optional(),
    },
    async ({ device_id, search, limit }) => {
      try {
        // 1. GET /uitree and parse
        const rawJson = await proxyGet(device_id, "/uitree");
        const rawTree = JSON.parse(rawJson);

        // 2. Filter through UI tree filter
        let elements: FilteredElement[] = filterUITree(rawTree);

        // 3. Search: case-insensitive substring on text
        if (search) {
          const lower = search.toLowerCase();
          elements = elements.filter((el) => (el.text ?? "").toLowerCase().includes(lower));
        }

        // 4. Limit
        const total = elements.length;
        let suffix = "";
        if (limit !== undefined && total > limit) {
          elements = elements.slice(0, limit);
          suffix = `\n(showing ${limit} of ${total} elements, use 'search' to narrow results)`;
        }

        // 5. Serialize as JSONL
        const jsonl = elements.map((el) => JSON.stringify(el)).join("\n") + suffix;
        return textResult(jsonl);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.10 launch_app ──
  server.tool(
    "launch_app",
    "Launches an app on the device",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      app_id: z.string().regex(/^[\w\-.:]{1,256}$/),
    },
    async ({ device_id, app_id }) => {
      try {
        const device = await ensureDevice(device_id);
        const paramKey = device.platform === "ios" ? "bundleId" : "packageName";
        const text = await proxyPost(device_id, "/launchApp", { [paramKey]: app_id });
        return textResult(text);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.11 terminate_app ──
  server.tool(
    "terminate_app",
    "Terminates an app on the device",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      app_id: z.string().regex(/^[\w\-.:]{1,256}$/),
    },
    async ({ device_id, app_id }) => {
      try {
        const device = await ensureDevice(device_id);
        const paramKey = device.platform === "ios" ? "bundleId" : "packageName";
        const text = await proxyPost(device_id, "/terminateApp", { [paramKey]: app_id });
        return textResult(text);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.12 list_apps ──
  server.tool(
    "list_apps",
    "Lists installed apps on the device",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
    },
    async ({ device_id }) => {
      try {
        const text = await proxyGet(device_id, "/listApps");
        return textResult(text);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.14 install_app ──
  // Host-tooling operation: installs straight through adb/simctl/devicectl,
  // exactly like bootstrap installs our own driver. Does NOT require the
  // on-device server, so no ensureDevice/bootstrap here.
  server.tool(
    "install_app",
    "Installs an app on the device from a file on the host: .apk for Android, .app bundle for iOS simulator, .app or .ipa for iOS real device. Replaces existing installs.",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      app_path: z.string().min(1).max(4096),
    },
    async ({ device_id, app_path }) => {
      try {
        const { platform, deviceType } = await detectPlatform(device_id);

        // Validate the artifact before invoking host tooling. No shell is
        // involved (spawn arrays), so path characters need no escaping.
        const stat = statSync(app_path, { throwIfNoEntry: false });
        if (!stat) {
          return errorResult(`No such file on the host: ${app_path}`);
        }

        let output: string;
        if (platform === "android") {
          if (!app_path.endsWith(".apk") || !stat.isFile()) {
            return errorResult(`Android installs require an .apk file, got: ${app_path}`);
          }
          output = await runCommand(["adb", "-s", device_id, "install", "-r", app_path]);
        } else if (deviceType === "simulator") {
          if (!app_path.endsWith(".app") || !stat.isDirectory()) {
            return errorResult(`iOS simulator installs require a .app bundle directory, got: ${app_path}`);
          }
          output = await runCommand(["xcrun", "simctl", "install", device_id, app_path]);
        } else {
          if (!/\.(app|ipa)$/.test(app_path)) {
            return errorResult(`iOS device installs require a .app bundle or .ipa file, got: ${app_path}`);
          }
          output = await runCommand([
            "xcrun", "devicectl", "device", "install", "app", "--device", device_id, app_path,
          ]);
        }

        const trimmed = output.trim();
        return textResult(trimmed || `Installed ${app_path} on ${device_id}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ── 2.2.13 run_code ──
  server.tool(
    "run_code",
    "Execute test automation code on the device",
    {
      device_id: z.string().regex(/^[\w\-.:]{1,256}$/),
      code: z.string().max(100_000),
    },
    async ({ device_id, code }) => {
      try {
        const text = await proxyPostBody(device_id, "/exec", code);
        return textResult(text);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

}
