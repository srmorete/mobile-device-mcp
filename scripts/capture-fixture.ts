#!/usr/bin/env bun
/**
 * Captures raw uitree JSON from a device for use as test fixtures.
 * Usage: bun run scripts/capture-fixture.ts <device-id> <output-file>
 *
 * This bootstraps its own device server connection (separate from any running MCP server).
 */
import { ensureDevice } from "../src/server/bootstrap";
import { proxyGet } from "../src/server/proxy";
import { cleanupAll } from "../src/server/devices";

const [deviceId, outputFile] = process.argv.slice(2);
if (!deviceId || !outputFile) {
  console.error("Usage: bun run scripts/capture-fixture.ts <device-id> <output-file>");
  process.exit(1);
}

try {
  console.log(`Bootstrapping ${deviceId}...`);
  await ensureDevice(deviceId);
  console.log("Fetching uitree...");
  const raw = await proxyGet(deviceId, "/uitree");
  const parsed = JSON.parse(raw);
  console.log(`Got ${parsed.nodes?.length} top-level nodes, ${parsed.screenWidth}x${parsed.screenHeight}`);
  await Bun.write(outputFile, raw);
  console.log(`Saved to ${outputFile}`);
} finally {
  await cleanupAll();
}
