import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { 
  CassHit, 
  CassHitSchema, 
  Config,
  CassTimelineResult
} from "./types.js";
import { log, error } from "./utils.js";
import { sanitize, compileExtraPatterns } from "./sanitize.js";
import { getSanitizeConfig } from "./config.js";

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

// --- Health & Availability ---

export function cassAvailable(cassPath = "cass"): boolean {
  try {
    // Use spawnSync to avoid shell injection vulnerabilities
    const result = spawnSync(cassPath, ["--version"], { stdio: "pipe" });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function cassNeedsIndex(cassPath = "cass"): boolean {
  try {
    const result = spawnSync(cassPath, ["health"], { stdio: "pipe" });
    return result.status === 0 ? false : true;
  } catch (err: any) {
    // If execution fails entirely (e.g. command not found), assume we need index/setup
    return true;
  }
}

// --- Indexing ---

export async function cassIndex(
  cassPath = "cass", 
  options: { full?: boolean; incremental?: boolean } = {}
): Promise<void> {
  const args = ["index"];
  if (options.full) args.push("--full");
  if (options.incremental) args.push("--incremental");

  return new Promise((resolve, reject) => {
    const proc = spawn(cassPath, args, { stdio: "inherit" });
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
}

export async function cassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass",
  config?: Config 
): Promise<CassHit[]> {
  const args = ["search", query, "--robot"]; 
  
  if (options.limit) args.push("--limit", options.limit.toString());
  if (options.days) args.push("--days", options.days.toString());
  
  if (options.agent) {
    const agents = Array.isArray(options.agent) ? options.agent : [options.agent];
    agents.forEach(a => args.push("--agent", a));
  }
  
  if (options.workspace) args.push("--workspace", options.workspace);
  if (options.fields) args.push("--fields", options.fields.join(","));

  try {
    const { stdout } = await execFileAsync(cassPath, args, { 
      maxBuffer: 50 * 1024 * 1024, 
      timeout: (options.timeout || 30) * 1000 
    });
    
    const rawHits = JSON.parse(stdout);
    // Validate and parse with Zod
    let hits = rawHits.map((h: any) => CassHitSchema.parse(h));

    // Apply sanitization to search results if config provided
    if (config && config.sanitization.enabled) {
      const sanitizeConfig = getSanitizeConfig(config);
      const compiledPatterns = compileExtraPatterns(sanitizeConfig.extraPatterns || []);
      
      const runtimeSanitizeConfig = {
        enabled: true,
        extraPatterns: compiledPatterns,
        auditLog: sanitizeConfig.auditLog
      };

      hits = hits.map((hit: CassHit) => ({
        ...hit,
        snippet: sanitize(hit.snippet, runtimeSanitizeConfig)
      }));
    }

    return hits;
  } catch (err: any) {
    if (err.code === CASS_EXIT_CODES.NOT_FOUND) return [];
    throw err;
  }
}

// --- Safe Wrapper ---

export async function safeCassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass",
  config?: Config
): Promise<CassHit[]> {
  if (!cassAvailable(cassPath)) {
    log("cass not available, skipping search", true);
    return [];
  }

  try {
    return await cassSearch(query, options, cassPath, config);
  } catch (err: any) {
    const exitCode = err.code;
    
    if (exitCode === CASS_EXIT_CODES.INDEX_MISSING) {
      log("Index missing, rebuilding...", true);
      try {
        await cassIndex(cassPath);
        return await cassSearch(query, options, cassPath, config);
      } catch (retryErr) {
        error(`Recovery failed: ${retryErr}`);
        return [];
      }
    }
    
    if (exitCode === CASS_EXIT_CODES.TIMEOUT) {
      log("Search timed out, retrying with reduced limit...", true);
      const reducedOptions = { ...options, limit: Math.max(1, Math.floor((options.limit || 10) / 2)) };
      try {
        return await cassSearch(query, reducedOptions, cassPath, config);
      } catch {
        return [];
      }
    }
    
    error(`Cass search failed: ${err.message}`);
    return [];
  }
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
    
    if (config && config.sanitization.enabled) {
      const sanitizeConfig = getSanitizeConfig(config);
      const compiledPatterns = compileExtraPatterns(sanitizeConfig.extraPatterns || []);
      
      const runtimeSanitizeConfig = {
        enabled: true,
        extraPatterns: compiledPatterns,
        auditLog: sanitizeConfig.auditLog
      };
      
      return sanitize(stdout, runtimeSanitizeConfig);
    }

    return stdout;
  } catch (err: any) {
    if (err.code === CASS_EXIT_CODES.NOT_FOUND) return null;
    error(`Export failed: ${err.message}`);
    return null;
  }
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
    
    if (config && config.sanitization.enabled) {
      const sanitizeConfig = getSanitizeConfig(config);
      const compiledPatterns = compileExtraPatterns(sanitizeConfig.extraPatterns || []);
      
      const runtimeSanitizeConfig = {
        enabled: true,
        extraPatterns: compiledPatterns,
        auditLog: sanitizeConfig.auditLog
      };
      
      return sanitize(stdout, runtimeSanitizeConfig);
    }

    return stdout;
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