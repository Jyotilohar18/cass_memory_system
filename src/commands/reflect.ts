import { loadConfig } from "../config.js";
import { loadMergedPlaybook, loadPlaybook, savePlaybook } from "../playbook.js";
import { ProcessedLog, getProcessedLogPath } from "../tracking.js";
import { findUnprocessedSessions, cassExport } from "../cass.js";
import { generateDiary } from "../diary.js";
import { reflectOnSession } from "../reflect.js";
import { validateDelta } from "../validate.js";
import { curatePlaybook } from "../curate.js";
import { expandPath, log, warn, error, now, fileExists } from "../utils.js";
import { withLock } from "../lock.js";
import { PlaybookDelta } from "../types.js";
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
    llm?: boolean;
    session?: string;
  } = {}
): Promise<void> {
  const config = await loadConfig();

  // Track costs before operation
  const statsBefore = await getUsageStats(config);
  
  const globalPath = expandPath(config.playbookPath);
  const repoPath = expandPath(".cass/playbook.yaml");
  const targetPlaybookPath = (await fileExists(repoPath)) ? repoPath : globalPath;
  const logPath = expandPath(getProcessedLogPath(options.workspace));

  // We must lock the entire reflect process to ensure we don't duplicate work 
  // or overwrite the playbook/processed log with stale data.
  await withLock(targetPlaybookPath, async () => {
    const processedLog = new ProcessedLog(logPath);
    await processedLog.load();

    // Load fresh playbook for context
    const initialPlaybook = await loadMergedPlaybook(config);

    let sessions: string[] = [];
    if (options.session) {
        sessions = [options.session];
    } else {
        log("Searching for new sessions...", !options.json);
        sessions = await findUnprocessedSessions(processedLog.getProcessedPaths(), { 
            days: options.days || config.sessionLookbackDays,
            maxSessions: options.maxSessions || 5,
            agent: options.agent
        }, config.cassPath);
    }

    const unprocessed = sessions.filter(s => !processedLog.has(s));

    if (unprocessed.length === 0) {
      if (!options.json) console.log(chalk.green("No new sessions to reflect on."));
      return;
    }

    if (!options.json) console.log(chalk.blue(`Found ${unprocessed.length} sessions to process.`));

    const allDeltas: PlaybookDelta[] = [];
    const CONCURRENCY = 1; // Keep at 1 for now to avoid race conditions within the loop or excessive LLM load
    
    // Helper for processing a single session
    const processSession = async (sessionPath: string) => {
      if (!options.json) console.log(chalk.dim(`Processing ${sessionPath}...`));
      try {
        const diary = await generateDiary(sessionPath, config);
        
        // Optimization: If we have a diary but it's empty/trivial, skip reflection?
        // For now, rely on reflectOnSession logic.

        const deltas = await reflectOnSession(diary, initialPlaybook, config);
        
        const validatedDeltas: PlaybookDelta[] = [];
        for (const delta of deltas) {
          const validation = await validateDelta(delta, config);
          if (validation.valid) {
            validatedDeltas.push(delta);
          } else {
            log(`Rejected delta: ${validation.gate?.reason || validation.result?.reason}`, !options.json);
          }
        }

        if (validatedDeltas.length > 0) {
          allDeltas.push(...validatedDeltas);
        }
        
        // Mark as processed immediately in memory, save later
        processedLog.add({
          sessionPath,
          processedAt: now(),
          diaryId: diary.id,
          deltasGenerated: validatedDeltas.length
        });

      } catch (err: any) {
        error(`Failed to process ${sessionPath}: ${err.message}`);
      }
    };

    // Process sequentially for safety/simplicity in V1
    for (const session of unprocessed) {
        await processSession(session);
    }

    if (options.dryRun) {
      console.log(JSON.stringify(allDeltas, null, 2));
      return;
    }

    if (allDeltas.length > 0) {
      // Reload fresh playbook again just in case
      const freshPlaybook = await loadPlaybook(targetPlaybookPath);
      
      // Pass freshPlaybook as target (mutable), initialPlaybook as context (readonly, merged)
      const curation = curatePlaybook(freshPlaybook, allDeltas, config, initialPlaybook);
      await savePlaybook(curation.playbook, targetPlaybookPath);
      
      await processedLog.save();

      if (options.json) {
          console.log(JSON.stringify(curation, null, 2));
      } else {
          console.log(chalk.green(`
Reflection complete!`));
          console.log(`Applied ${curation.applied} changes.`);
          console.log(`Skipped ${curation.skipped} (duplicates/conflicts).`);

          if (curation.inversions.length > 0) {
            console.log(chalk.yellow(`
Inverted ${curation.inversions.length} harmful rules:`));
            curation.inversions.forEach(inv => {
              console.log(`  ${inv.originalContent.slice(0,40)}... -> ANTI-PATTERN`);
            });
          }

          // Display cost summary
          const statsAfter = await getUsageStats(config);
          const operationCost = statsAfter.today - statsBefore.today;
          if (operationCost > 0) {
            console.log(chalk.dim(formatCostSummary(operationCost, statsAfter)));
          }
      }
    } else {
      await processedLog.save(); // Save progress even if no deltas
      if (!options.json) console.log("No new insights found.");

      // Display cost summary even if no deltas generated (LLM still ran)
      const statsAfter = await getUsageStats(config);
      const operationCost = statsAfter.today - statsBefore.today;
      if (operationCost > 0 && !options.json) {
        console.log(chalk.dim(formatCostSummary(operationCost, statsAfter)));
      }
    }
  });
}
