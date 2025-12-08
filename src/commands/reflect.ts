import { loadConfig } from "../config.js";
import { orchestrateReflection } from "../orchestrator.js";
import { getUsageStats, formatCostSummary } from "../cost.js";
import chalk from "chalk";

export async function reflectCommand(
  options: {
    days?: number;
    maxSessions?: number;
    agent?: string;
    workspace?: string;
    dryRun?: boolean;
    json?: boolean;
    llm?: boolean; // Ignored, always uses LLM if validation enabled
    session?: string;
  } = {}
): Promise<void> {
  const config = await loadConfig();
  const statsBefore = await getUsageStats(config);

  if (!options.json) {
    console.log(chalk.blue(`Starting reflection (workspace: ${options.workspace || "global"})...`));
  }

  const result = await orchestrateReflection(config, options);

  if (result.errors.length > 0 && !options.json) {
    result.errors.forEach(e => console.error(chalk.red(e)));
  }

  if (options.dryRun) {
    if (options.json) {
      console.log(JSON.stringify(result.dryRunDeltas, null, 2));
    } else {
      console.log(JSON.stringify(result.dryRunDeltas, null, 2));
    }
    return;
  }

  if (options.json) {
    console.log(JSON.stringify({
      global: result.globalResult,
      repo: result.repoResult,
      errors: result.errors
    }, null, 2));
    return;
  }

  // CLI Output
  if (result.sessionsProcessed === 0 && result.errors.length === 0) {
    console.log(chalk.green("No new sessions to reflect on."));
  } else {
    console.log(chalk.green(`\nReflection complete! Processed ${result.sessionsProcessed} sessions.`));

    if (result.globalResult) {
      console.log(chalk.bold(`Global Updates:`));
      console.log(`  Applied: ${result.globalResult.applied}, Skipped: ${result.globalResult.skipped}`);
      if (result.globalResult.inversions.length > 0) {
        console.log(chalk.yellow(`  Inverted ${result.globalResult.inversions.length} harmful rules.`));
      }
    }

    if (result.repoResult) {
      console.log(chalk.bold(`Repo Updates:`));
      console.log(`  Applied: ${result.repoResult.applied}, Skipped: ${result.repoResult.skipped}`);
      if (result.repoResult.inversions.length > 0) {
        console.log(chalk.yellow(`  Inverted ${result.repoResult.inversions.length} harmful rules.`));
      }
    }
  }

  const statsAfter = await getUsageStats(config);
  const operationCost = statsAfter.today - statsBefore.today;
  if (operationCost > 0) {
    console.log(chalk.dim(formatCostSummary(operationCost, statsAfter)));
  }
}
