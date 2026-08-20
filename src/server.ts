import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import dotenv from "dotenv";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { runScraper } from "../tools/runScraper.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-zoning-scraper",
    version: "1.0.0"
  });

  server.registerTool(
    "runScraper",
    {
      description: "Scrape zoning and telecom rules and push them to Base44",
      inputSchema: {}
    },
    async () => {
      try {
        const result = await runScraper();
        const response = { ok: true, result };

        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
          structuredContent: response
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
          isError: true
        };
      }
    }
  );

  return server;
}

async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Zoning Scraper running on stdio");
}

function isAuthorized(request: Request, token: string): boolean {
  const provided = request.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);

  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

function startHttpServer(port: number, authToken: string): void {
  const app = createMcpExpressApp();

  app.get("/health", (_request: Request, response: Response) => {
    response.status(200).json({ ok: true, service: "mcp-zoning-scraper" });
  });

  app.post("/mcp", async (request: Request, response: Response) => {
    if (!isAuthorized(request, authToken)) {
      response.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null
      });
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  app.get("/mcp", (_request: Request, response: Response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null
    });
  });

  app.delete("/mcp", (_request: Request, response: Response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null
    });
  });

  app.listen(port, "0.0.0.0", () => {
    console.log(`MCP Zoning Scraper listening on port ${port}`);
  });
}

async function main(): Promise<void> {
  const railwayPort = process.env.PORT;
  if (railwayPort) {
    const port = Number.parseInt(railwayPort, 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid PORT value: ${railwayPort}`);
    }
    const authToken = process.env.MCP_AUTH_TOKEN?.trim();
    if (!authToken) {
      throw new Error("Missing required environment variable: MCP_AUTH_TOKEN");
    }
    startHttpServer(port, authToken);
    return;
  }

  await startStdioServer();
}

main().catch((error: unknown) => {
  console.error("MCP server failed to start:", error);
  process.exit(1);
});
