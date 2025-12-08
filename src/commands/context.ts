import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, getSanitizeConfig } from "../config.js";
import { sanitize } from "../sanitize.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { safeCassSearch } from "../cass.js";
import {
  extractKeywords,
  scoreBulletRelevance,
  checkDeprecatedPatterns,
  generateSuggestedQueries,
  warn,
  truncate,
  formatLastHelpful,
  extractBulletReasoning,
  ensureDir,
  expandPath
} from "../utils.js";
import { getEffectiveScore } from "../scoring.js";
import { ContextResult, ScoredBullet, Config, CassSearchHit } from "../types.js";
import chalk from "chalk";

// ============================================================================ 
// buildContextResult - Assemble final ContextResult output
// ============================================================================ 

/**
 * Build the final ContextResult from gathered components.
 */
export function buildContextResult(
  task: string,
  rules: ScoredBullet[],
  antiPatterns: ScoredBullet[],
  history: CassSearchHit[],
  warnings: string[],
  suggestedQueries: string[],
  config: Config
): ContextResult {
  // Apply size limits
  const maxBullets = config.maxBulletsInContext || 10;
  const maxHistory = config.maxHistoryInContext || 10;

  // Transform rules with additional metadata for LLM consumption
  const relevantBullets = rules.slice(0, maxBullets).map(b => ({
    ...b,
    lastHelpful: formatLastHelpful(b),
    reasoning: extractBulletReasoning(b)
  }));

  // Transform anti-patterns with additional metadata
  const transformedAntiPatterns = antiPatterns.slice(0, maxBullets).map(b => ({
    ...b,
    lastHelpful: formatLastHelpful(b),
    reasoning: extractBulletReasoning(b)
  }));

  // Transform history snippets - simplify structure, truncate long snippets
  const historySnippets = history.slice(0, maxHistory).map(h => ({
    ...h,
    snippet: truncate(h.snippet.trim().replace(/\n/g, " "), 300)
  }));

  return {
    task,
    relevantBullets,
    antiPatterns: transformedAntiPatterns,
    historySnippets,
    deprecatedWarnings: warnings,
    suggestedCassQueries: suggestedQueries
  };
}

export interface ContextFlags {
  json?: boolean;
  top?: number;
  history?: number;
  days?: number;
  workspace?: string;
  format?: "json" | "markdown";
  logContext?: boolean;
  session?: string;
}

export interface ContextComputation {
  result: ContextResult;
  rules: ScoredBullet[];
  antiPatterns: ScoredBullet[];
  cassHits: CassSearchHit[];
  warnings: string[];
  suggestedQueries: string[];
}

/**
 * Programmatic context builder (no console output).
 */
export async function generateContextResult(
  task: string,
  flags: ContextFlags
): Promise<ContextComputation> {
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);

  const keywords = extractKeywords(task);

  const activeBullets = getActiveBullets(playbook).filter((b) => {
    if (!flags.workspace) return true;
    if (b.scope !== "workspace") return true;
    return b.workspace === flags.workspace;
  });

  const scoredBullets: ScoredBullet[] = activeBullets.map(b => {
    const relevance = scoreBulletRelevance(b.content, b.tags, keywords);
    const effective = getEffectiveScore(b, config);
    const final = relevance * Math.max(0.1, effective);

    return {
      ...b,
      relevanceScore: relevance,
      effectiveScore: effective,
      finalScore: final
    };
  });

  scoredBullets.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));

  const topBullets = scoredBullets
    .filter(b => (b.finalScore || 0) > 0)
    .slice(0, flags.top || config.maxBulletsInContext);

  const rules = topBullets.filter(b => !b.isNegative && b.kind !== "anti_pattern");
  const antiPatterns = topBullets.filter(b => b.isNegative || b.kind === "anti_pattern");

  // Check cass availability first
  const { cassAvailable, handleCassUnavailable } = await import("../cass.js");
  const availability = await handleCassUnavailable({ cassPath: config.cassPath });
  
  let cassHits: CassSearchHit[] = [];
  
  if (availability.canContinue && availability.fallbackMode === "none") {
    const cassQuery = keywords.join(" ");
    // Pass config to safeCassSearch to enable sanitization of search results
    cassHits = await safeCassSearch(cassQuery, {
      limit: flags.history || config.maxHistoryInContext,
      days: flags.days || config.sessionLookbackDays,
      workspace: flags.workspace
    }, config.cassPath, config);
  } else {
    // Degraded mode
    if (!flags.json) { // Only log if not JSON output to keep stdout clean
       warn(availability.message);
    }
  }

  const warnings: string[] = [];
  const historyWarnings = checkDeprecatedPatterns(cassHits, playbook.deprecatedPatterns);
  warnings.push(...historyWarnings);

  for (const pattern of playbook.deprecatedPatterns) {
    if (new RegExp(pattern.pattern, "i").test(task)) {
      const reason = pattern.reason ? ` (Reason: ${pattern.reason})` : "";
      const replacement = pattern.replacement ? ` - use ${pattern.replacement} instead` : "";
      warnings.push(`Task matches deprecated pattern "${pattern.pattern}"${replacement}${reason}`);
    }
  }

  const suggestedQueries = generateSuggestedQueries(task, keywords, {
    maxSuggestions: 5
  });

  const result = buildContextResult(
    task,
    rules,
    antiPatterns,
    cassHits,
    warnings,
    suggestedQueries,
    config
  );

  const shouldLog =
    flags.logContext ||
    process.env.CASS_CONTEXT_LOG === "1" ||
    process.env.CASS_CONTEXT_LOG === "true";

  if (shouldLog) {
    await appendContextLog({
      task,
      ruleIds: rules.map((r) => r.id),
      antiPatternIds: antiPatterns.map((r) => r.id),
      workspace: flags.workspace,
      session: flags.session,
    });
  }

  return { result, rules, antiPatterns, cassHits, warnings, suggestedQueries };
}

import { loadConfig, getSanitizeConfig } from "../config.js";
import { sanitize } from "../sanitize.js";

// ... existing imports ...

async function appendContextLog(entry: {
  task: string;
  ruleIds: string[];
  antiPatternIds: string[];
  workspace?: string;
  session?: string;
}) {
  try {
    // Resolve log path: prefer repo-local .cass/ if available
    const repoLog = path.resolve(".cass", "context-log.jsonl");
    const repoDirExists = await fs
      .access(path.dirname(repoLog))
      .then(() => true)
      .catch(() => false);

    const logPath = repoDirExists
      ? repoLog
      : expandPath("~/.cass-memory/context-log.jsonl");

    await ensureDir(path.dirname(logPath));

    // Sanitize content before logging
    const config = await loadConfig();
    const sanitizeConfig = getSanitizeConfig(config);
    const safeTask = sanitize(entry.task, sanitizeConfig);

    const payload = {
      ...entry,
      task: safeTask,
      timestamp: new Date().toISOString(),
      source: "context",
    };
    
    // Simple append is sufficient for logs
    await fs.appendFile(logPath, JSON.stringify(payload) + "\n", "utf-8");
  } catch {
    // Best-effort logging; never block context generation
  }
}

/**
 * Graceful degradation when cass is unavailable - provide playbook-only context.
 */
export async function contextWithoutCass(
  task: string,
  config: Config,
  options: { workspace?: string; maxBullets?: number; reason?: string } = {}
): Promise<ContextResult> {
  const { workspace, maxBullets, reason } = options;

  warn(`cass unavailable - showing playbook only${reason ? ` (${reason})` : ""}`);

  try {
    const playbook = await loadMergedPlaybook(config);
    const keywords = extractKeywords(task);

    const activeBullets = getActiveBullets(playbook).filter((b) => {
      if (!workspace) return true;
      if (b.scope !== "workspace") return true;
      return b.workspace === workspace;
    });

    const scoredBullets: ScoredBullet[] = activeBullets.map(b => {
      const relevance = scoreBulletRelevance(b.content, b.tags, keywords);
      const effective = getEffectiveScore(b, config);
      const final = relevance * Math.max(0.1, effective);

      return {
        ...b,
        relevanceScore: relevance,
        effectiveScore: effective,
        finalScore: final
      };
    });

    scoredBullets.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));

    const topBullets = scoredBullets
      .filter(b => (b.finalScore || 0) > 0)
      .slice(0, maxBullets || config.maxBulletsInContext);

    const rules = topBullets.filter(b => !b.isNegative && b.kind !== "anti_pattern");
    const antiPatterns = topBullets.filter(b => b.isNegative || b.kind === "anti_pattern");

    const warnings: string[] = ["Context generated without historical data (cass unavailable)"];
    for (const pattern of playbook.deprecatedPatterns) {
      if (new RegExp(pattern.pattern, "i").test(task)) {
        const reasonSuffix = pattern.reason ? ` (Reason: ${pattern.reason})` : "";
        const replacement = pattern.replacement ? ` - use ${pattern.replacement} instead` : "";
        warnings.push(`Task matches deprecated pattern "${pattern.pattern}"${replacement}${reasonSuffix}`);
      }
    }

    return {
      task,
      relevantBullets: rules,
      antiPatterns,
      historySnippets: [],
      deprecatedWarnings: warnings,
      suggestedCassQueries: []
    };
  } catch (err) {
    warn(`Playbook also unavailable: ${err}`);
    return {
      task,
      relevantBullets: [],
      antiPatterns: [],
      historySnippets: [],
      deprecatedWarnings: ["Context unavailable - both cass and playbook failed to load"],
      suggestedCassQueries: []
    };
  }
}

// Legacy export wrapper
export async function getContext(
  task: string, 
  flags: ContextFlags = {}
) {
  const { result, rules, antiPatterns, cassHits, warnings, suggestedQueries } = await generateContextResult(task, flags);
  return { result, rules, antiPatterns, cassHits, warnings, suggestedQueries };
}

export async function contextCommand(
  task: string, 
  flags: ContextFlags
) {
  const { result, rules, antiPatterns, cassHits, warnings, suggestedQueries } = await generateContextResult(task, flags);

  const wantsJson = flags.format === "json" || flags.json;

  if (wantsJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Human Output
    console.log(chalk.bold(`═══════════════════════════════════════════════════════════════`));
    console.log(chalk.bold(`CONTEXT FOR: ${task}`));
    console.log(chalk.bold(`═══════════════════════════════════════════════════════════════
`));

    if (rules.length > 0) {
      console.log(chalk.blue.bold(`RELEVANT PLAYBOOK RULES (${rules.length}):
`));
      rules.forEach(b => {
        console.log(chalk.bold(`[${b.id}] ${b.category}/${b.kind} (score: ${b.effectiveScore.toFixed(1)})`));
        console.log(`  ${b.content}`);
        console.log("");
      });
    } else {
      console.log(chalk.gray("(No relevant playbook rules found)"));
      console.log(chalk.gray(`  💡 Run 'cm reflect' to start learning from your agent sessions.
`));
    }

    if (antiPatterns.length > 0) {
      console.log(chalk.red.bold(`PITFALLS TO AVOID (${antiPatterns.length}):
`));
      antiPatterns.forEach(b => {
        console.log(chalk.red(`[${b.id}] ${b.content}`));
      });
      console.log("");
    }

    if (cassHits.length > 0) {
      console.log(chalk.blue.bold(`HISTORICAL CONTEXT (${cassHits.length} sessions):
`));
      cassHits.slice(0, 3).forEach((h, i) => {
        console.log(`${i + 1}. ${h.source_path} (${h.agent || "unknown"})`);
        console.log(chalk.gray(`   "${h.snippet.trim().replace(/\n/g, " ")}"`));
        console.log("");
      });
    } else {
      console.log(chalk.gray("(No relevant history found)"));
      console.log(chalk.gray(`  💡 Use Claude Code, Cursor, or Codex to build session history.
`));
    }

    if (warnings.length > 0) {
      console.log(chalk.yellow.bold(`⚠️  WARNINGS:
`));
      warnings.forEach(w => console.log(chalk.yellow(`  • ${w}`)));
      console.log("");
    }

    console.log(chalk.blue.bold(`SUGGESTED SEARCHES:`));
    suggestedQueries.forEach(q => console.log(`  ${q}`));
  }
}
