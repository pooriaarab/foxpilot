// foxpilot MCP server on stdio. One warm Firefox session serves every tool
// call: it starts on the first call, and GLiNER2 loads once.
// stdout carries the protocol, so every log line goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { launch, preflight } from "./firefox.mjs";

export async function serve({ headless = false } = {}) {
  let starting = null;
  let tabId = null;
  const warm = () => (starting ??= (async () => {
    const missing = preflight();
    if (missing) throw new Error(missing);
    const session = await launch({ headless });
    const { modelLoadMs } = await session.ready();
    console.error(`model loaded in ${(modelLoadMs / 1000).toFixed(1)} s`);
    return session;
  })().catch((error) => {
    starting = null;
    throw error;
  }));
  // Calls run one at a time: the panel runs one goal at a time.
  let queue = Promise.resolve();
  const tool = (work) => (args) => {
    const next = queue.then(async () => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await work(await warm(), args)) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    });
    queue = next;
    return next;
  };

  const server = new McpServer({ name: "foxpilot", version: "0.1.0" });
  server.registerTool("run_task", {
    description: "Open a URL and run a goal on it in Firefox. Returns the RunResult: verified, status, answer, checks, steps, totalMs.",
    inputSchema: { url: z.string(), goal: z.string(), llm: z.boolean().optional() },
  }, tool(async (session, { url, goal, llm }) => {
    tabId = await session.openTask(url);
    return session.run(goal, { tabId, llm: Boolean(llm) });
  }));
  server.registerTool("open_url", {
    description: "Open a URL in the task tab.",
    inputSchema: { url: z.string() },
  }, tool(async (session, { url }) => {
    tabId = await session.openTask(url);
    return { tabId, url };
  }));
  server.registerTool("snapshot", {
    description: "List the controls the agent sees on the current task tab.",
    inputSchema: {},
  }, tool(async (session) => {
    if (tabId == null) throw new Error("No task tab yet. Call open_url or run_task first.");
    return session.snapshot(tabId);
  }));
  server.registerTool("close", {
    description: "Close Firefox. The next tool call starts a new session.",
    inputSchema: {},
  }, tool(async (session) => {
    await session.close();
    starting = null;
    tabId = null;
    return { closed: true };
  }));

  await server.connect(new StdioServerTransport());
  console.error("foxpilot MCP server ready");
  const stop = async () => {
    if (starting) await (await starting.catch(() => null))?.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("close", stop);
}
