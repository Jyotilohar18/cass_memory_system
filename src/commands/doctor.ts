import { loadConfig } from "../config.js";
import { cassAvailable, cassStats, cassSearch, safeCassSearch } from "../cass.js";
import { fileExists, resolveRepoDir, resolveGlobalDir, expandPath } from "../utils.js";
import { isLLMAvailable, getAvailableProviders, validateApiKey } from "../llm.js";
import { SECRET_PATTERNS, compileExtraPatterns } from "../sanitize.js";
import { loadPlaybook } from "../playbook.js";
import { Config } from "../types.js";
import chalk from "chalk";
import path from "node:path";

type CheckStatus = "pass" | "warn" | "fail";
type OverallStatus = "healthy" | "degraded" | "unhealthy";
type PatternMatch = { pattern: string; sample: string; replacement: string; suggestion?: string };

export interface HealthCheck {
  category: string;
  item: string;
  status: CheckStatus;
  message: string;
  details?: unknown;
}

function statusIcon(status: CheckStatus): string {
  if (status === "pass") return "✅";
  if (status === "warn") return "⚠️ ";
  return "❌";
}

function nextOverallStatus(current: OverallStatus, status: CheckStatus): OverallStatus {
  if (status === "fail") return "unhealthy";
  if (status === "warn" && current !== "unhealthy") return "degraded";
  return current;
}

function testPatternBreadth(
  patterns: Array<{ pattern: RegExp; replacement: string }>,
  samples: string[]
): { matches: PatternMatch[]; tested: number } {
  const matches: PatternMatch[] = [];
  const tested = patterns.length * samples.length;

  for (const { pattern, replacement } of patterns) {
    for (const sample of samples) {
      pattern.lastIndex = 0;
      if (pattern.test(sample)) {
        const patternStr = pattern.toString();
        const suggestion = patternStr.includes("token")
          ? "Consider anchoring token with delimiters, e.g. /token[\"\\s:=]+/i"
          : "Consider tightening with explicit delimiters around secrets";
        matches.push({ pattern: patternStr, sample, replacement, suggestion });
      }
    }
  }

  return { matches, tested };
}

/**
 * Run end-to-end smoke tests of core functionality.
 * Returns an array of HealthCheck results for integration into doctor command.
 */
export async function runSelfTest(config: Config): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  // 1. PLAYBOOK LOAD PERFORMANCE
  const playbookPath = expandPath(config.playbookPath);
  try {
    const start = Date.now();
    const playbook = await loadPlaybook(playbookPath);
    const loadTime = Date.now() - start;
    const bulletCount = playbook.bullets?.length ?? 0;

    if (loadTime > 500) {
      checks.push({
        category: "Self-Test",
        item: "Playbook Load",
        status: "warn",
        message: `Slow: ${loadTime}ms (consider optimization)`,
        details: { loadTime, bulletCount, path: playbookPath },
      });
    } else {
      checks.push({
        category: "Self-Test",
        item: "Playbook Load",
        status: "pass",
        message: `${loadTime}ms (${bulletCount} bullets)`,
        details: { loadTime, bulletCount, path: playbookPath },
      });
    }
  } catch (err: any) {
    checks.push({
      category: "Self-Test",
      item: "Playbook Load",
      status: "fail",
      message: `Failed: ${err.message}`,
      details: { error: err.message, path: playbookPath },
    });
  }

  // 2. CASS SEARCH LATENCY
  const cassOk = cassAvailable(config.cassPath);
  if (cassOk) {
    const start = Date.now();
    try {
      // Use safeCassSearch which handles errors gracefully
      const results = await safeCassSearch("self test query", { limit: 5 }, config.cassPath);
      const searchTime = Date.now() - start;

      if (searchTime > 5000) {
        checks.push({
          category: "Self-Test",
          item: "Cass Search",
          status: "fail",
          message: `Very slow: ${searchTime}ms`,
          details: { searchTime, resultCount: results.length },
        });
      } else if (searchTime > 2000) {
        checks.push({
          category: "Self-Test",
          item: "Cass Search",
          status: "warn",
          message: `Slow: ${searchTime}ms`,
          details: { searchTime, resultCount: results.length },
        });
      } else {
        checks.push({
          category: "Self-Test",
          item: "Cass Search",
          status: "pass",
          message: `${searchTime}ms`,
          details: { searchTime, resultCount: results.length },
        });
      }
    } catch (err: any) {
      checks.push({
        category: "Self-Test",
        item: "Cass Search",
        status: "fail",
        message: `Search failed: ${err.message}`,
        details: { error: err.message },
      });
    }
  } else {
    checks.push({
      category: "Self-Test",
      item: "Cass Search",
      status: "warn",
      message: "Skipped (cass not available)",
      details: { cassPath: config.cassPath },
    });
  }

  // 3. SANITIZATION PATTERN BREADTH
  const patternCount = SECRET_PATTERNS.length;
  const extraPatterns = config.sanitization?.extraPatterns || [];
  const compiledExtra = compileExtraPatterns(extraPatterns);
  const totalPatterns = patternCount + compiledExtra.length;

  if (!config.sanitization?.enabled) {
    checks.push({
      category: "Self-Test",
      item: "Sanitization",
      status: "warn",
      message: "Disabled",
      details: { enabled: false },
    });
  } else if (totalPatterns < 10) {
    checks.push({
      category: "Self-Test",
      item: "Sanitization",
      status: "warn",
      message: `Only ${totalPatterns} patterns (recommend ≥10)`,
      details: { builtIn: patternCount, custom: compiledExtra.length },
    });
  } else {
    checks.push({
      category: "Self-Test",
      item: "Sanitization",
      status: "pass",
      message: `${totalPatterns} patterns loaded`,
      details: { builtIn: patternCount, custom: compiledExtra.length },
    });
  }

  // 4. CONFIG VALIDATION
  const configIssues: string[] = [];

  // Check for deprecated options
  const deprecated = ["maxContextBullets", "enableEmbeddings"];
  for (const opt of deprecated) {
    if ((config as any)[opt] !== undefined) {
      configIssues.push(`Deprecated option: ${opt}`);
    }
  }

  // Check paths are absolute or use tilde expansion
  const pathFields = ["playbookPath", "diaryDir", "cassPath"];
  for (const field of pathFields) {
    const value = (config as any)[field];
    if (value && typeof value === "string") {
      if (!value.startsWith("/") && !value.startsWith("~") && value !== "cass") {
        configIssues.push(`${field} should be absolute path`);
      }
    }
  }

  // Validate threshold values
  if (config.dedupSimilarityThreshold < 0 || config.dedupSimilarityThreshold > 1) {
    configIssues.push("dedupSimilarityThreshold should be 0-1");
  }
  if (config.pruneHarmfulThreshold < 0) {
    configIssues.push("pruneHarmfulThreshold should be non-negative");
  }

  if (configIssues.length > 0) {
    checks.push({
      category: "Self-Test",
      item: "Config Validation",
      status: "warn",
      message: `${configIssues.length} issue(s) found`,
      details: { issues: configIssues },
    });
  } else {
    checks.push({
      category: "Self-Test",
      item: "Config Validation",
      status: "pass",
      message: "Config valid",
      details: { schemaVersion: config.schema_version },
    });
  }

  // 5. LLM/EMBEDDING SYSTEM
  const availableProviders = getAvailableProviders();
  const currentProvider = config.provider;
  const hasCurrentProvider = availableProviders.includes(currentProvider);

  if (availableProviders.length === 0) {
    checks.push({
      category: "Self-Test",
      item: "LLM System",
      status: "fail",
      message: "No API keys configured",
      details: { availableProviders: [], currentProvider },
    });
  } else if (!hasCurrentProvider) {
    checks.push({
      category: "Self-Test",
      item: "LLM System",
      status: "warn",
      message: `Current provider (${currentProvider}) not available, have: ${availableProviders.join(", ")}`,
      details: { availableProviders, currentProvider },
    });
  } else {
    // Check for API key validity (format check, not actual API call)
    try {
      validateApiKey(currentProvider);
      checks.push({
        category: "Self-Test",
        item: "LLM System",
        status: "pass",
        message: `${currentProvider} (${config.model})`,
        details: {
          availableProviders,
          currentProvider,
          model: config.model,
          semanticSearchEnabled: config.semanticSearchEnabled
        },
      });
    } catch (err: any) {
      checks.push({
        category: "Self-Test",
        item: "LLM System",
        status: "warn",
        message: `${currentProvider}: ${err.message}`,
        details: { availableProviders, currentProvider, error: err.message },
      });
    }
  }

  return checks;
}

export async function doctorCommand(options: { json?: boolean; fix?: boolean }): Promise<void> {
  const config = await loadConfig();
  const checks: Array<{ category: string; status: CheckStatus; message: string; details?: unknown }> = [];

  // 1) cass integration
  const cassOk = cassAvailable(config.cassPath);
  checks.push({
    category: "Cass Integration",
    status: cassOk ? "pass" : "fail",
    message: cassOk ? "cass CLI found" : "cass CLI not found",
    details: cassOk ? await cassStats(config.cassPath) : undefined,
  });

  // 2) Global Storage
  const globalDir = resolveGlobalDir();
  const globalPlaybookExists = await fileExists(path.join(globalDir, "playbook.yaml"));
  const globalConfigExists = await fileExists(path.join(globalDir, "config.json"));
  const globalDiaryExists = await fileExists(path.join(globalDir, "diary"));
  
  const missingGlobal: string[] = [];
  if (!globalPlaybookExists) missingGlobal.push("playbook.yaml");
  if (!globalConfigExists) missingGlobal.push("config.json");
  if (!globalDiaryExists) missingGlobal.push("diary/");

  checks.push({
    category: "Global Storage (~/.cass-memory)",
    status: missingGlobal.length === 0 ? "pass" : "warn",
    message: missingGlobal.length === 0 
      ? "All global files found" 
      : `Missing: ${missingGlobal.join(", ")}`,
  });

  // 3) LLM config
  const hasApiKey = isLLMAvailable(config.provider) || !!config.apiKey;
  checks.push({
    category: "LLM Configuration",
    status: hasApiKey ? "pass" : "fail",
    message: `Provider: ${config.provider}, API Key: ${hasApiKey ? "Set" : "Missing"}`,
  });

  // 4) Repo-level .cass/ structure (if in a git repo)
  const cassDir = await resolveRepoDir();
  if (cassDir) {
    const repoPlaybookExists = await fileExists(path.join(cassDir, "playbook.yaml"));
    const repoToxicExists = await fileExists(path.join(cassDir, "toxic.log"));

    const hasStructure = repoPlaybookExists || repoToxicExists;
    const isComplete = repoPlaybookExists && repoToxicExists;

    let status: CheckStatus = "pass";
    let message = "";

    if (!hasStructure) {
      status = "warn";
      message = "Not initialized. Run `cm init --repo` to enable project-level memory.";
    } else if (!isComplete) {
      status = "warn";
      const missing: string[] = [];
      if (!repoPlaybookExists) missing.push("playbook.yaml");
      if (!repoToxicExists) missing.push("toxic.log");
      message = `Partial setup. Missing: ${missing.join(", ")}. Run \`cm init --repo --force\` to complete.`;
    } else {
      message = "Complete (.cass/playbook.yaml and .cass/toxic.log present)";
    }

    checks.push({
      category: "Repo .cass/ Structure",
      status,
      message,
      details: {
        cassDir,
        playbookExists: repoPlaybookExists,
        toxicLogExists: repoToxicExists,
      },
    });
  } else {
    checks.push({
      category: "Repo .cass/ Structure",
      status: "warn",
      message: "Not in a git repository. Repo-level memory not available.",
    });
  }

  // 5) Sanitization breadth (detect over-broad regexes)
  if (!config.sanitization?.enabled) {
    checks.push({
      category: "Sanitization Pattern Health",
      status: "warn",
      message: "Sanitization disabled; breadth checks skipped",
    });
  } else {
    const benignSamples = [
      "The tokenizer splits text into tokens",
      "Bearer of bad news",
      "This is a password-protected file",
      "The API key concept is important",
    ];

    const builtInResult = testPatternBreadth(SECRET_PATTERNS, benignSamples);
    const extraPatterns = compileExtraPatterns(config.sanitization.extraPatterns);
    const extraResult = testPatternBreadth(
      extraPatterns.map((p) => ({ pattern: p, replacement: "[REDACTED_CUSTOM]" })),
      benignSamples
    );

    const totalMatches = builtInResult.matches.length + extraResult.matches.length;
    const totalTested = builtInResult.tested + extraResult.tested;
    const falsePositiveRate = totalTested > 0 ? totalMatches / totalTested : 0;

    checks.push({
      category: "Sanitization Pattern Health",
      status: totalMatches > 0 ? "warn" : "pass",
      message:
        totalMatches > 0
          ? `Potential broad patterns detected (${totalMatches} benign hits, ~${(falsePositiveRate * 100).toFixed(1)}% est. FP)`
          : "All patterns passed benign breadth checks",
      details: {
        benignSamples,
        builtInMatches: builtInResult.matches,
        extraMatches: extraResult.matches,
        falsePositiveRate,
      },
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }

  console.log(chalk.bold("\n🏥 System Health Check\n"));
  let overallStatus: OverallStatus = "healthy";
  for (const check of checks) {
    console.log(`${statusIcon(check.status)} ${chalk.bold(check.category)}: ${check.message}`);
    overallStatus = nextOverallStatus(overallStatus, check.status);

    if (check.category === "Sanitization Pattern Health" && check.details && (check.details as any).builtInMatches) {
      const details = check.details as {
        builtInMatches: PatternMatch[];
        extraMatches: PatternMatch[];
      };
      const allMatches = [...(details.builtInMatches || []), ...(details.extraMatches || [])];
      if (allMatches.length > 0) {
        console.log(chalk.yellow("  Potentially broad patterns:"));
        for (const m of allMatches) {
          console.log(chalk.yellow(`  - ${m.pattern} matched "${m.sample}" (replacement: ${m.replacement})`));
          if (m.suggestion) {
            console.log(chalk.yellow(`    Suggestion: ${m.suggestion}`));
          }
        }
      }
    }
  }

  console.log("");
  if (overallStatus === "healthy") console.log(chalk.green("System is healthy ready to rock! 🚀"));
  else if (overallStatus === "degraded") console.log(chalk.yellow("System is running in degraded mode."));
  else console.log(chalk.red("System has critical issues."));
}