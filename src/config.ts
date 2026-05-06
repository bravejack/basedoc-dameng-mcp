export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  host: string;
  port: number;
  user: string;
  password: string;
  schema?: string;
  queryTimeoutMs: number;
  maxRows: number;
  poolMin: number;
  poolMax: number;
  docsRoot?: string;
  docsInclude: string[];
  docsExclude: string[];
}

const REQUIRED = ["DAMENG_HOST", "DAMENG_PORT", "DAMENG_USER", "DAMENG_PASSWORD"] as const;

export function loadConfig(env: Record<string, string | undefined>): Config {
  for (const key of REQUIRED) {
    if (!env[key] || env[key]!.length === 0) {
      throw new ConfigError(`Missing required env var: ${key}`);
    }
  }

  const port = parsePositiveInt(env.DAMENG_PORT, "DAMENG_PORT");
  const queryTimeoutMs = env.DAMENG_QUERY_TIMEOUT_MS
    ? parsePositiveInt(env.DAMENG_QUERY_TIMEOUT_MS, "DAMENG_QUERY_TIMEOUT_MS")
    : 10_000;
  const maxRows = env.DAMENG_MAX_ROWS
    ? parsePositiveInt(env.DAMENG_MAX_ROWS, "DAMENG_MAX_ROWS")
    : 1000;
  const poolMin = env.DAMENG_POOL_MIN
    ? parsePositiveInt(env.DAMENG_POOL_MIN, "DAMENG_POOL_MIN")
    : 1;
  const poolMax = env.DAMENG_POOL_MAX
    ? parsePositiveInt(env.DAMENG_POOL_MAX, "DAMENG_POOL_MAX")
    : 4;

  let docsRoot: string | undefined;
  if (env.DAMENG_DOCS_ROOT) {
    if (!env.DAMENG_DOCS_ROOT.startsWith("/")) {
      throw new ConfigError(
        `DAMENG_DOCS_ROOT must be an absolute path, got "${env.DAMENG_DOCS_ROOT}"`,
      );
    }
    docsRoot = env.DAMENG_DOCS_ROOT.replace(/\/+$/, "");
  }

  const docsInclude = parsePatternList(env.DAMENG_DOCS_INCLUDE);
  const docsExclude = parsePatternList(env.DAMENG_DOCS_EXCLUDE);

  return {
    host: env.DAMENG_HOST!,
    port,
    user: env.DAMENG_USER!,
    password: env.DAMENG_PASSWORD!,
    schema: env.DAMENG_SCHEMA,
    queryTimeoutMs,
    maxRows,
    poolMin,
    poolMax,
    docsRoot,
    docsInclude,
    docsExclude,
  };
}

function parsePatternList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parsePositiveInt(raw: string | undefined, name: string): number {
  if (!raw) {
    throw new ConfigError(`${name} is required`);
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be > 0, got ${n}`);
  }
  return n;
}
