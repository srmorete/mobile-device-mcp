import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { cleanupAll } from "./devices.js";
import pkg from "../../package.json";

// ── Shutdown ──

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`Shutting down (${reason}), cleaning up devices...`);
  try {
    await cleanupAll();
  } catch (err) {
    console.error(`Cleanup failed: ${(err as Error).message}`);
  }
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

// MCP hosts (SDK StdioClientTransport.close) end stdin before signalling.
// Start teardown on EOF so we can use the host's full wait window
// (stdin-end → ~2s → SIGTERM → ~2s → SIGKILL) for a clean iOS XCTest exit
// instead of only the post-SIGTERM slice.
function watchStdinEOF(): void {
  if (!process.stdin || typeof process.stdin.on !== "function") return;
  const onEnd = () => { void shutdown("stdin-EOF"); };
  process.stdin.on("end", onEnd);
  process.stdin.on("close", onEnd);
}

// ── Main ──

async function main(): Promise<void> {
  const server = new McpServer(
    { name: pkg.name, version: pkg.version },
    { capabilities: { tools: {} } },
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  watchStdinEOF();
  console.error("MCP server running on stdio");
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await cleanupAll();
  process.exit(1);
});
