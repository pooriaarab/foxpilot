// Smoke test for `foxpilot mcp`: spawns the server, lists its tools, runs the
// flights goal, and exits 0 only when the run is verified.
//   node scripts/mcp-smoke.mjs [--headless]
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bin = fileURLToPath(new URL("../bin/foxpilot.mjs", import.meta.url));
const client = new Client({ name: "mcp-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin, "mcp", ...process.argv.slice(2)],
  stderr: "inherit",
});
let verified = false;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));
  const reply = await client.callTool({
    name: "run_task",
    arguments: {
      url: "https://www.google.com/travel/flights?hl=en",
      goal: "Find a one-way ticket from New York to San Francisco on October 9, 2026.",
    },
  }, undefined, { timeout: 600_000 });
  const text = reply.content[0]?.text ?? "";
  if (reply.isError) throw new Error(text);
  const result = JSON.parse(text);
  verified = result.verified === true;
  console.log(`${verified ? "PASS" : "FAIL"} ${result.status} · ${(result.totalMs / 1000).toFixed(1)} s · ${result.goal}`);
  console.log("verified:", verified);
  await client.callTool({ name: "close", arguments: {} });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await client.close().catch(() => {});
}
process.exit(verified ? 0 : 1);
