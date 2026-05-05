import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./utils/logger";
import { getToolsToRegister } from "./tools";
import { createRequestHandler } from "react-router";

declare global {
  interface CloudflareEnvironment extends Env {
    CLOUDFLARE_ANALYTICS?: any;
    OPENAI_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    XAI_API_KEY?: string;
  }
}

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: CloudflareEnvironment;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

// Create CORS preflight response
const handleCorsPreflightRequest = (): Response => {
  return new Response(null, {
    status: 204, // No content
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400", // 24 hours
    },
  });
};

// Define our MCP agent with tools
export class MyMCPv2 extends McpAgent {
  server = new McpServer({
    name: "SFR MCP",
    version: "1.0.0",
  });

  async init() {
    const initStartTime = Date.now();

    // Bound DO SQL storage: each MCP session is its own DO and the SDK
    // never cleans them up. Self-destruct after 1h so storage doesn't
    // grow without bound.
    await this.schedule(60 * 60, "selfDestruct");

    logger.info("Starting MCP server initialization", {
      serverName: "SFR MCP",
      version: "1.0.0",
      initStartTime,
    });

    try {
      const toolRegistrationStartTime = Date.now();
      const tools = await getToolsToRegister(this.props.requestUrl as string);
      tools.forEach((tool) => {
        this.server.tool(
          tool.toolName,
          tool.toolDescription,
          tool.toolSchema,
          tool.toolCallback,
        );
      });

      const totalToolRegistrationDuration =
        Date.now() - toolRegistrationStartTime;
      const totalInitDuration = Date.now() - initStartTime;

      logger.info("MCP server initialization completed", {
        totalToolsFound: tools.length,
        toolRegistrationDuration: totalToolRegistrationDuration,
        totalInitDuration,
      });
    } catch (error) {
      const initDuration = Date.now() - initStartTime;
      logger.error("MCP server initialization failed", {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        initDuration,
      });
      throw error;
    }
  }

  async selfDestruct() {
    logger.info("Self-destructing idle MCP session");
    await this.destroy();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const requestStartTime = Date.now();

    logger.info("Incoming request", {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      userAgent: request.headers.get("User-Agent"),
      requestStartTime,
    });

    try {
      const url = new URL(request.url);
      logger.debug("Parsed request URL", {
        pathname: url.pathname,
        search: url.search,
        searchParams: Array.from(url.searchParams.entries()),
      });

      ctx.props.requestUrl = request.url;

      // Handle CORS preflight requests
      if (request.method === "OPTIONS") {
        return handleCorsPreflightRequest();
      }

      const isStreamMethod = request.headers
        .get("accept")
        ?.includes("text/event-stream");

      if (isStreamMethod) {
        return await MyMCPv2.serve("/*", {
          binding: "MCP_OBJECT_V2",
        }).fetch(request, env, ctx);
      }

      return requestHandler(request, {
        cloudflare: { env, ctx },
      });
    } catch (error) {
      const requestDuration = Date.now() - requestStartTime;
      logger.error("Request processing failed", {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        requestDuration,
      });

      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
