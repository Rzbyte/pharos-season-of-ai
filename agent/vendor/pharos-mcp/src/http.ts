import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import type { AppConfig } from "./config.js";
import { createPharosServer } from "./server.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startHttpServer(config: AppConfig): Promise<Server> {
  const app = express();
  app.disable("x-powered-by");
  // Trust exactly ONE proxy hop (the ALB). Express's boolean `true` would trust
  // the whole chain and take the LEFT-most X-Forwarded-For entry — which the ALB
  // appends to rather than overwrites, so any client could set that header and
  // hand itself a fresh rate-limit bucket on every request. The numeric form
  // walks the header right-to-left by one hop, yielding the address the ALB
  // itself observed, which a client cannot forge. Increase this if more trusted
  // layers (e.g. CloudFront) are ever put in front of the ALB.
  if (config.trustProxy) app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  const sessions = new Map<string, Session>();
  const sessionTimeoutMs = config.sessionTimeoutMinutes * 60 * 1000;

  // Fixed-window per-IP rate limiter. Zero disables it. No external dep:
  // a Map of ip -> { count, windowStart }, reset once the 60s window rolls.
  const rateWindowMs = 60_000;
  const rateBuckets = new Map<string, { count: number; windowStart: number }>();

  function rateLimit(req: Request, res: Response): boolean {
    if (config.rateLimitPerMinute <= 0) return true;
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart >= rateWindowMs) {
      rateBuckets.set(ip, { count: 1, windowStart: now });
      return true;
    }
    bucket.count += 1;
    if (bucket.count > config.rateLimitPerMinute) {
      const retryAfter = Math.ceil((bucket.windowStart + rateWindowMs - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(retryAfter, 1)));
      res.status(429).json({ error: "Too Many Requests" });
      return false;
    }
    return true;
  }

  function authenticate(req: Request, res: Response): boolean {
    if (!config.authToken) return true;
    const header = req.header("authorization") || "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!secureEqual(supplied, config.authToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  const cleanup = setInterval(async () => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastSeen > sessionTimeoutMs) {
        sessions.delete(sessionId);
        await session.transport.close().catch(() => undefined);
      }
    }
    // Evict stale rate-limit buckets so the Map can't grow unbounded.
    for (const [ip, bucket] of rateBuckets) {
      if (now - bucket.windowStart >= rateWindowMs) rateBuckets.delete(ip);
    }
  }, 60_000);
  cleanup.unref();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", chain: "Pharos", chainId: config.chainId, rpcUrl: config.rpcUrl });
  });

  app.post("/mcp", async (req, res) => {
    if (!rateLimit(req, res)) return;
    if (!authenticate(req, res)) return;
    try {
      const sessionId = req.header("mcp-session-id");
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        if (sessionId) {
          res.status(404).json({ error: "Unknown MCP session" });
          return;
        }
        // Each session pins an McpServer + transport in memory until it idles
        // out, so refuse new ones past the cap rather than growing unbounded.
        if (config.maxSessions > 0 && sessions.size >= config.maxSessions) {
          res.setHeader("Retry-After", "60");
          res.status(503).json({ error: "Server at session capacity, try again shortly" });
          return;
        }
        const mcpServer = createPharosServer(config);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, lastSeen: Date.now() });
          },
          onsessionclosed: (closedSessionId) => {
            sessions.delete(closedSessionId);
          },
        });
        await mcpServer.connect(transport);
        session = { transport, lastSeen: Date.now() };
      }

      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", async (req, res) => {
      if (!rateLimit(req, res)) return;
      if (!authenticate(req, res)) return;
      const sessionId = req.header("mcp-session-id");
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        res.status(404).json({ error: "Unknown MCP session" });
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res);
    });
  }

  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.on("error", reject);
  });
}
