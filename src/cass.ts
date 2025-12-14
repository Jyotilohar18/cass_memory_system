import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  CassHit,
  CassHitSchema,
  CassTimelineGroup,
  CassTimelineResult,
  Config
} from "./types.js";
import { log, error, expandPath } from "./utils.js";
import { sanitize, compileExtraPatterns } from "./sanitize.js";
import { loadConfig, getSanitizeConfig } from "./config.js";

const execFileAsync = promisify(execFile);

// --- Constants ---

export const CASS_EXIT_CODES = {
  SUCCESS: 0,
  USAGE_ERROR: 2,
  INDEX_MISSING: 3,
  NOT_FOUND: 4,
  IDEMPOTENCY_MISMATCH: 5,
  UNKNOWN: 9,
  TIMEOUT: 10,
} as const;

export type CassFallbackMode = "none" | "playbook-only";

export interface CassAvailabilityResult {
  canContinue: boolean;
  fallbackMode: CassFallbackMode;
  message: string;
  resolvedCassPath?: string;
}

export type CassDegradedReason = "NOT_FOUND" | "INDEX_MISSING" | "TIMEOUT" | "OTHER";

export interface CassDegradedInfo {
  /** Whether cass-powered history is available for this operation. */
  available: boolean;
  reason: CassDegradedReason;
  message: string;
  suggestedFix?: string[];
}

export interface SafeCassSearchResult {
  hits: CassHit[];
  degraded?: CassDegradedInfo;
  resolvedCassPath?: string;
}

// --- Helpers ---

function coerceContent(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw;

  if (Array.isArray(raw)) {
    const parts = raw
      .map((p) => coerceContent(p))
      .filter((v): v is string => Boolean(v));
    return parts.length ? parts.join("\n") : null;
  }

  if (typeof raw === "object") {
    if (typeof raw.text === "string") return raw.text;
    if (typeof raw.content === "string") return raw.content;
    if (typeof raw.message === "string") return raw.message;
  }

  return null;
}

function formatSessionEntry(entry: any): string | null {
  const content = coerceContent(entry?.content ?? entry?.text ?? entry?.message ?? entry);
  if (!content) return null;
  const speaker = entry?.role || entry?.type || entry?.agent;
  return speaker ? `[${speaker}] ${content}` : content;
}

function joinMessages(entries: any[]): string | null {
  const parts = entries
    .map((e) => formatSessionEntry(e))
    .filter((v): v is string => Boolean(v));
  return parts.length ? parts.join("\n") : null;
}

// --- Health & Availability ---

export function cassAvailable(cassPath = "cass", opts: { quiet?: boolean } = {}): boolean {
  const resolved = expandPath(cassPath);
  try {
    const result = spawnSync(resolved, ["--version"], { stdio: "pipe" });
    if (result.error) {
        if (!opts.quiet) console.error("cassAvailable spawn error:", result.error);
        return false;
    }
    if (result.status !== 0) {
        if (!opts.quiet) console.error("cassAvailable non-zero status:", result.status, result.stderr.toString());
        return false;
    }
    return true;
  } catch (e) {
    if (!opts.quiet) console.error("cassAvailable exception:", e);
    return false;
  }
}

/**
 * Gracefully handle cass being unavailable.
 * Tries configured and common paths; returns fallback guidance.
 */
export async function handleCassUnavailable(
  options: { cassPath?: string; searchCommonPaths?: boolean } = {}
): Promise<CassAvailabilityResult> {
  const configuredPath = options.cassPath || process.env.CASS_PATH || "cass";
  const common = options.searchCommonPaths === false ? [] : [
    "/usr/local/bin/cass",
    "~/.cargo/bin/cass",
    "~/.local/bin/cass",
  ];

  const candidates = Array.from(new Set([configuredPath, ...common])).map(expandPath);

  for (const candidate of candidates) {
    if (cassAvailable(candidate, { quiet: true })) {
      const message = candidate === configuredPath
        ? `cass available at ${candidate}`
        : `cass found at ${candidate}. Set CASS_PATH=${candidate} or update config.cassPath.`;
      return {
        canContinue: true,
        fallbackMode: "none",
        message,
        resolvedCassPath: candidate,
      };
    }
  }

  const installMessage = [
    "cass binary not found. Falling back to playbook-only mode (history disabled).",
    "Install via `cargo install cass` or download a release binary:",
    "https://github.com/Dicklesworthstone/coding_agent_session_search",
    "Then set CASS_PATH or config.cassPath."
  ].join(" ");

  return {
    canContinue: true,
    fallbackMode: "playbook-only",
    message: installMessage,
  };
}

export function cassNeedsIndex(cassPath = "cass"): boolean {
  const resolved = expandPath(cassPath);
  try {
    const result = spawnSync(resolved, ["health"], { stdio: "pipe" });
    return result.status !== 0;
  } catch (err: any) {
    return true;
  }
}

// --- Indexing ---

export async function cassIndex(
  cassPath = "cass",
  options: { full?: boolean; incremental?: boolean } = {}
): Promise<void> {
  const resolved = expandPath(cassPath);
  const args = ["index"];
  if (options.full) args.push("--full");
  if (options.incremental) args.push("--incremental");

  return new Promise((resolve, reject) => {
    const proc = spawn(resolved, args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cass index failed with code ${code}`));
    });
    proc.on("error", (err) => reject(err));
  });
}

// --- Search ---

export interface CassSearchOptions {
  limit?: number;
  days?: number;
  agent?: string | string[];
  workspace?: string;
  fields?: string[];
  timeout?: number;
  /**
   * Skip the availability probe and attempt a search anyway.
   * Useful for test stubs where cassAvailable can be flaky.
   */
  force?: boolean;
}

export async function cassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass"
): Promise<CassHit[]> {
  const resolved = expandPath(cassPath);
  const args = ["search", query, "--robot"];

  if (options.limit) args.push("--limit", options.limit.toString());
  if (options.days) args.push("--days", options.days.toString());

  if (options.agent) {
    const agents = Array.isArray(options.agent) ? options.agent : [options.agent];
    agents.forEach(a => args.push("--agent", a));
  }

  if (options.workspace) args.push("--workspace", options.workspace);
  if (options.fields) args.push("--fields", options.fields.join(","));

  const parseCassOutput = (stdout: string): any => {
    // 1) Happy path JSON.parse
    try {
      return JSON.parse(stdout);
    } catch (parseErr) {
      // 2) Slice from first JSON-looking character (handles leading warnings)
      const firstArray = stdout.indexOf("[");
      const firstObject = stdout.indexOf("{");
      const start = [firstArray, firstObject].filter(i => i >= 0).sort((a, b) => a - b)[0];
      
      if (start !== undefined) {
        // Robustness: Try to find the *last* matching closing bracket to handle trailing garbage
        const isArray = start === firstArray;
        const lastIndex = stdout.lastIndexOf(isArray ? "]" : "}");
        
        if (lastIndex > start) {
          const slice = stdout.substring(start, lastIndex + 1);
          try {
            return JSON.parse(slice);
          } catch {
            // Fall through to NDJSON fallback if precise slicing fails
          }
        }
        
        // Fallback: try slicing to end if precise matching failed
        const slice = stdout.substring(start);
        try {
          return JSON.parse(slice);
        } catch {
          // continue to NDJSON fallback
        }
      }

      // 3) NDJSON / line-delimited objects (ignore non-JSON lines)
      const parsedLines: any[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
        try {
          const val = JSON.parse(trimmed);
          if (Array.isArray(val)) parsedLines.push(...val);
          else parsedLines.push(val);
        } catch {
          // ignore malformed lines, keep trying others
        }
      }
      if (parsedLines.length > 0) {
        return parsedLines;
      }

      throw parseErr;
    }
  };

  try {
    const { stdout } = await execFileAsync(resolved, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: (options.timeout || 30) * 1000
    });

    const rawHits = parseCassOutput(stdout);

    // Validate and parse with Zod
    return Array.isArray(rawHits) 
      ? rawHits.map((h: any) => CassHitSchema.parse(h))
      : [CassHitSchema.parse(rawHits)];

  } catch (err: any) {
    if (err.code === CASS_EXIT_CODES.NOT_FOUND) return [];
    if (err instanceof SyntaxError) {
        error(`Failed to parse cass output: ${err.message}`);
    }
    throw err;
  }
}

// --- Safe Wrapper ---

function normalizeCassErrorMessage(err: unknown): string {
  if (!err) return "Unknown error";
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function classifyCassSearchError(err: any, query: string): CassDegradedInfo {
  const rawMessage = normalizeCassErrorMessage(err);
  const msg = rawMessage.split("\n")[0]?.trim() || rawMessage;
  const code = err?.code;
  const lower = `${msg}`.toLowerCase();

  if (code === CASS_EXIT_CODES.INDEX_MISSING || lower.includes("index missing") || lower.includes("needs index")) {
    return {
      available: false,
      reason: "INDEX_MISSING",
      message: "cass index is missing; history is disabled until indexed.",
      suggestedFix: ["cass index", "cass health"],
    };
  }

  if (
    code === CASS_EXIT_CODES.TIMEOUT ||
    code === "ETIMEDOUT" ||
    err?.killed === true ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return {
      available: false,
      reason: "TIMEOUT",
      message: "cass search timed out; history may be incomplete.",
      suggestedFix: ["cass search \"<query>\" --robot --limit 5 --days 7", "cass health"],
    };
  }

  if (code === CASS_EXIT_CODES.NOT_FOUND || code === "ENOENT") {
    return {
      available: false,
      reason: "NOT_FOUND",
      message: "cass binary not found; falling back to playbook-only mode (history disabled).",
      suggestedFix: ["cargo install cass", "cass index"],
    };
  }

  return {
    available: false,
    reason: "OTHER",
    message: msg ? `cass search failed: ${msg}` : "cass search failed",
    suggestedFix: ["cm doctor", "cass health"],
  };
}

export async function safeCassSearchWithDegraded(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass",
  config?: Config
): Promise<SafeCassSearchResult> {
  if (!query || !query.trim()) {
    return { hits: [] };
  }

  const force = options.force || process.env.CM_FORCE_CASS_SEARCH === "1";
  const availability = await handleCassUnavailable({ cassPath });

  if (!force && availability.fallbackMode !== "none") {
    return {
      hits: [],
      degraded: {
        available: false,
        reason: "NOT_FOUND",
        message: availability.message,
        suggestedFix: ["cargo install cass", "cass index"],
      },
    };
  }

  const expandedCassPath = expandPath(cassPath);
  const resolvedCassPath = availability.resolvedCassPath || expandedCassPath;
  const resolvedCassPathForOutput =
    availability.resolvedCassPath && availability.resolvedCassPath !== expandedCassPath
      ? availability.resolvedCassPath
      : undefined;

  const activeConfig = config || await loadConfig();
  const sanitizeConfig = getSanitizeConfig(activeConfig);

  // Pre-compile patterns for performance (avoid recompilation per hit)
  const compiledConfig = {
    ...sanitizeConfig,
    extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns)
  };

  try {
    const hits = await cassSearch(query, options, resolvedCassPath);
    return {
      hits: hits.map(hit => ({
        ...hit,
        snippet: sanitize(hit.snippet, compiledConfig)
      })),
      resolvedCassPath: resolvedCassPathForOutput,
    };
  } catch (err: any) {
    const degraded = classifyCassSearchError(err, query);
    if (degraded.reason === "TIMEOUT") {
      degraded.suggestedFix = [
        `cass search "${query.replace(/"/g, '\\"')}" --robot --limit ${Math.max(1, Math.min(5, options.limit || 5))} --days ${Math.max(1, Math.min(30, options.days || 7))}`,
        "cass health",
      ];
    }

    // Best-effort fallback: if force flag set, attempt to parse whatever stdout we get.
    if (options.force) {
      try {
        const alt = spawnSync(resolvedCassPath, ["search", query, "--robot"], { encoding: "utf-8" });
        const text = alt.stdout || "";
        if (text.trim()) {
          const parsed = JSON.parse(text);
          const hitsArr = Array.isArray(parsed) ? parsed : [parsed];
          return {
            hits: hitsArr.map((hit: any) => ({
              ...CassHitSchema.parse(hit),
              snippet: sanitize(hit.snippet, compiledConfig)
            })),
            degraded,
            resolvedCassPath: resolvedCassPathForOutput,
          };
        }
      } catch (fallbackErr: any) {
        // Keep degraded info; return empty hits.
        log(`cass search force fallback failed: ${fallbackErr?.message || String(fallbackErr)}`, true);
      }
    }

    return { hits: [], degraded, resolvedCassPath: resolvedCassPathForOutput };
  }
}

export async function safeCassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass",
  config?: Config
): Promise<CassHit[]> {
  const { hits } = await safeCassSearchWithDegraded(query, options, cassPath, config);
  return hits;
}

// --- Export ---

export async function cassExport(
  sessionPath: string,
  format: "markdown" | "json" | "text" = "markdown",
  cassPath = "cass",
  config?: Config
): Promise<string | null> {
  const args = ["export", sessionPath, "--format", format];

  try {
    const { stdout } = await execFileAsync(cassPath, args, { maxBuffer: 50 * 1024 * 1024 });
    const activeConfig = config || await loadConfig();
    const sanitizeConfig = getSanitizeConfig(activeConfig);
    const compiledConfig = {
      ...sanitizeConfig,
      extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns)
    };
    return sanitize(stdout, compiledConfig);
  } catch (err: any) {
    const fallback = await handleSessionExportFailure(sessionPath, err, config);
    if (fallback !== null) return fallback;

    if (err.code === CASS_EXIT_CODES.NOT_FOUND) return null;
    error(`Export failed: ${err.message}`);
    return null;
  }
}

/**
 * Fallback parser when cass export fails. Attempts direct parsing of session
 * files (.jsonl, .json, .md) to salvage readable content.
 */
export async function handleSessionExportFailure(
  sessionPath: string,
  exportError: Error,
  config?: Config
): Promise<string | null> {
  log(`cass export failed for ${sessionPath}: ${exportError.message}. Attempting fallback parse...`, true);

  try {
    const fileContent = await fs.readFile(expandPath(sessionPath), "utf-8");
    const ext = path.extname(sessionPath).toLowerCase();
    const activeConfig = config || await loadConfig();
    const sanitizeConfig = getSanitizeConfig(activeConfig);
    const compiledConfig = {
      ...sanitizeConfig,
      extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns)
    };

    if (ext === ".jsonl") {
      const parsed = fileContent
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return line;
          }
        });
      const joined = joinMessages(parsed);
      return joined ? sanitize(joined, compiledConfig) : null;
    }

    if (ext === ".json") {
      try {
        const parsed = JSON.parse(fileContent);
        const messages = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.messages)
            ? parsed.messages
            : null;
        const joined = messages ? joinMessages(messages) : null;
        return joined ? sanitize(joined, compiledConfig) : null;
      } catch (parseErr: any) {
        log(`Fallback JSON parse failed for ${sessionPath}: ${parseErr.message}`, true);
        return null;
      }
    }

    if (ext === ".md") {
      return sanitize(fileContent, compiledConfig);
    }
  } catch (readErr: any) {
    log(`Fallback read failed for ${sessionPath}: ${readErr.message}`, true);
  }

  return null;
}

// --- Expand ---

export async function cassExpand(
  sessionPath: string,
  lineNumber: number,
  contextLines = 3,
  cassPath = "cass",
  config?: Config
): Promise<string | null> {
  const args = ["expand", sessionPath, "-n", lineNumber.toString(), "-C", contextLines.toString(), "--robot"];

  try {
    const { stdout } = await execFileAsync(cassPath, args);

    // Sanitize expanded output
    const activeConfig = config || await loadConfig();
    const sanitizeConfig = getSanitizeConfig(activeConfig);
    const compiledConfig = {
      ...sanitizeConfig,
      extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns)
    };
    return sanitize(stdout, compiledConfig);
  } catch (err: any) {
    return null;
  }
}

// --- Stats & Timeline ---

export async function cassStats(cassPath = "cass"): Promise<any | null> {
  try {
    const { stdout } = await execFileAsync(cassPath, ["stats", "--json"]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function cassTimeline(
  days: number,
  cassPath = "cass"
): Promise<CassTimelineResult> {
  try {
    const { stdout } = await execFileAsync(cassPath, ["timeline", "--days", days.toString(), "--json"]);
    return JSON.parse(stdout) as CassTimelineResult;
  } catch {
    return { groups: [] };
  }
}

export async function findUnprocessedSessions(
  processed: Set<string>,
  options: { days?: number; maxSessions?: number; agent?: string },
  cassPath = "cass"
): Promise<string[]> {
  const timeline = await cassTimeline(options.days || 7, cassPath);

  const allSessions = timeline.groups.flatMap((g) =>
    g.sessions.map((s) => ({ path: s.path, agent: s.agent }))
  );

  return allSessions
    .filter((s) => !processed.has(s.path))
    .filter((s) => !options.agent || s.agent === options.agent)
    .map((s) => s.path)
    .slice(0, options.maxSessions || 20);
}
