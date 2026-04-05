import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { cleanupAll } from "./devices.js";
import pkg from "../../package.json";

// ── Shutdown ──

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("Shutting down, cleaning up devices...");
  await cleanupAll();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Main ──

async function main(): Promise<void> {
  const server = new McpServer(
    { name: pkg.name, version: pkg.version },
    { capabilities: { tools: {} } },
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await cleanupAll();
  process.exit(1);
});
