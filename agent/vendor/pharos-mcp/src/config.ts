export interface AppConfig {
  rpcUrl: string;
  chainId: number;
  nativeSymbol: string;
  transport: "stdio" | "http";
  host: string;
  port: number;
  authToken?: string;
  enableSendRawTransaction: boolean;
  rateLimitPerMinute: number;
  trustProxy: boolean;
  maxSessions: number;
  sessionTimeoutMinutes: number;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const transport = (env.MCP_TRANSPORT || "stdio").toLowerCase();
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("MCP_TRANSPORT must be stdio or http");
  }

  const rpcUrl = env.PHAROS_RPC_URL || "https://rpc.pharos.xyz";
  new URL(rpcUrl);

  return {
    rpcUrl,
    chainId: parsePositiveInteger(env.PHAROS_CHAIN_ID, 1672, "PHAROS_CHAIN_ID"),
    nativeSymbol: env.PHAROS_NATIVE_SYMBOL || "PROS",
    transport,
    host: env.MCP_HOST || "127.0.0.1",
    port: parsePositiveInteger(env.MCP_PORT, 3001, "MCP_PORT"),
    authToken: env.MCP_AUTH_TOKEN?.trim() || undefined,
    enableSendRawTransaction: parseBoolean(env.ENABLE_SEND_RAW_TRANSACTION, false),
    // 0 disables rate limiting. Defaults to 120 req/min per client IP.
    rateLimitPerMinute: parseNonNegativeInteger(env.RATE_LIMIT_PER_MINUTE, 120, "RATE_LIMIT_PER_MINUTE"),
    // Behind an ALB/ELB, trust X-Forwarded-For to get the real client IP.
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    // Hard ceiling on concurrent in-memory MCP sessions. Each session holds a
    // full McpServer instance, so an unauthenticated caller could otherwise
    // grow process memory without bound. 0 disables the cap.
    maxSessions: parseNonNegativeInteger(env.MAX_SESSIONS, 500, "MAX_SESSIONS"),
    // Idle sessions are evicted after this many minutes.
    sessionTimeoutMinutes: parseNonNegativeInteger(env.SESSION_TIMEOUT_MINUTES, 30, "SESSION_TIMEOUT_MINUTES"),
  };
}
