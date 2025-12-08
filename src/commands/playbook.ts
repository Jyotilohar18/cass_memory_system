import { loadConfig } from "../config.js";
import { loadMergedPlaybook, addBullet, deprecateBullet, savePlaybook, findBullet, getActiveBullets } from "../playbook.js";
import { error as logError } from "../utils.js";
import { withLock } from "../lock.js";
import { getEffectiveScore, getDecayedCounts } from "../scoring.js";
import { PlaybookBullet } from "../types.js";
import chalk from "chalk";

// Helper function to format a bullet for detailed display
function formatBulletDetails(bullet: PlaybookBullet, effectiveScore: number, decayedCounts: { decayedHelpful: number; decayedHarmful: number }): string {
  const lines: string[] = [];

  lines.push(chalk.bold(`BULLET: ${bullet.id}`));
  lines.push("");
  lines.push(`Content: ${bullet.content}`);
  lines.push(`Category: ${chalk.cyan(bullet.category)}`);
  lines.push(`Kind: ${bullet.kind}`);
  lines.push(`Maturity: ${chalk.yellow(bullet.maturity)}`);
  lines.push(`Scope: ${bullet.scope}`);

  lines.push("");
  lines.push(chalk.bold("Scores:"));

  const rawScore = bullet.helpfulCount - bullet.harmfulCount * 4;
  lines.push(`  Raw score: ${rawScore}`);
  lines.push(`  Effective score: ${effectiveScore.toFixed(2)} (with decay)`);
  lines.push(`  Decayed helpful: ${decayedCounts.decayedHelpful.toFixed(2)}`);
  lines.push(`  Decayed harmful: ${decayedCounts.decayedHarmful.toFixed(2)}`);
  lines.push(`  Positive feedback: ${bullet.helpfulCount}`);
  lines.push(`  Negative feedback: ${bullet.harmfulCount}`);

  lines.push("");
  lines.push(chalk.bold("History:"));
  lines.push(`  Created: ${bullet.createdAt}`);
  lines.push(`  Last updated: ${bullet.updatedAt}`);

  const ageMs = Date.now() - new Date(bullet.createdAt).getTime();
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  lines.push(`  Age: ${ageDays} days`);

  if (bullet.sourceSessions && bullet.sourceSessions.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Source sessions:"));
    for (const session of bullet.sourceSessions.slice(0, 5)) {
      lines.push(`  - ${session}`);
    }
    if (bullet.sourceSessions.length > 5) {
      lines.push(`  ... and ${bullet.sourceSessions.length - 5} more`);
    }
  }

  if (bullet.sourceAgents && bullet.sourceAgents.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Source agents:"));
    lines.push(`  ${bullet.sourceAgents.join(", ")}`);
  }

  if (bullet.tags && bullet.tags.length > 0) {
    lines.push("");
    lines.push(`Tags: [${bullet.tags.join(", ")}]`);
  }

  if (bullet.deprecated) {
    lines.push("");
    lines.push(chalk.red.bold("Status: DEPRECATED"));
    if (bullet.deprecationReason) {
      lines.push(`Reason: ${bullet.deprecationReason}`);
    }
    if (bullet.deprecatedAt) {
      lines.push(`Deprecated at: ${bullet.deprecatedAt}`);
    }
  }

  if (bullet.pinned) {
    lines.push("");
    lines.push(chalk.blue.bold("📌 PINNED"));
  }

  return lines.join("\n");
}

// Find similar bullet IDs for suggestions
function findSimilarIds(bullets: PlaybookBullet[], targetId: string, maxSuggestions = 3): string[] {
  const similar: Array<{ id: string; score: number }> = [];
  const targetLower = targetId.toLowerCase();

  for (const bullet of bullets) {
    const idLower = bullet.id.toLowerCase();
    // Simple substring match
    if (idLower.includes(targetLower) || targetLower.includes(idLower)) {
      similar.push({ id: bullet.id, score: 2 });
    } else if (idLower.startsWith(targetLower.slice(0, 3))) {
      // Prefix match
      similar.push({ id: bullet.id, score: 1 });
    }
  }

  return similar
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSuggestions)
    .map(s => s.id);
}

export async function playbookCommand(
  action: "list" | "add" | "remove" | "get",
  args: string[],
  flags: { category?: string; json?: boolean; hard?: boolean; reason?: string }
) {
  const config = await loadConfig();

  if (action === "get") {
    const id = args[0];
    if (!id) {
      logError("Bullet ID required for get");
      process.exit(1);
    }

    const playbook = await loadMergedPlaybook(config);
    const bullet = findBullet(playbook, id);

    if (!bullet) {
      const allBullets = playbook.bullets || [];
      const similar = findSimilarIds(allBullets, id);

      if (flags.json) {
        console.log(JSON.stringify({
          success: false,
          error: `Bullet '${id}' not found`,
          suggestions: similar.length > 0 ? similar : undefined
        }, null, 2));
      } else {
        logError(`Bullet '${id}' not found`);
        if (similar.length > 0) {
          console.log(chalk.yellow(`Did you mean: ${similar.join(", ")}?`));
        }
      }
      process.exit(1);
    }

    const effectiveScore = getEffectiveScore(bullet, config);
    const decayedCounts = getDecayedCounts(bullet, config);

    if (flags.json) {
      const ageMs = Date.now() - new Date(bullet.createdAt).getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

      console.log(JSON.stringify({
        success: true,
        bullet: {
          ...bullet,
          effectiveScore,
          decayedHelpful: decayedCounts.decayedHelpful,
          decayedHarmful: decayedCounts.decayedHarmful,
          ageDays
        }
      }, null, 2));
    } else {
      console.log(formatBulletDetails(bullet, effectiveScore, decayedCounts));
    }
    return;
  }

  if (action === "list") {
    const playbook = await loadMergedPlaybook(config);
    let bullets = getActiveBullets(playbook);
    
    if (flags.category) {
      bullets = bullets.filter((b: any) => b.category === flags.category);
    }

    if (flags.json) {
      console.log(JSON.stringify(bullets, null, 2));
    } else {
      console.log(chalk.bold(`PLAYBOOK RULES (${bullets.length}):`));
      bullets.forEach((b: any) => {
        console.log(`[${b.id}] ${chalk.cyan(b.category)}: ${b.content}`);
      });
    }
    return;
  }

  if (action === "add") {
    const content = args[0];
    if (!content) {
      logError("Content required for add");
      process.exit(1);
    }
    
    // Lock global playbook for writing
    await withLock(config.playbookPath, async () => {
        const { loadPlaybook } = await import("../playbook.js");
        const playbook = await loadPlaybook(config.playbookPath);
        
      const bullet = addBullet(
        playbook,
        {
          content,
          category: flags.category || "general",
          scope: "global",
          kind: "workflow_rule",
        },
        "manual-cli",
        config.scoring.decayHalfLifeDays
      );

        await savePlaybook(playbook, config.playbookPath);

        if (flags.json) {
          console.log(JSON.stringify({ success: true, bullet }, null, 2));
        } else {
          console.log(chalk.green(`✓ Added bullet ${bullet.id}`));
        }
    });
    return;
  }

  if (action === "remove") {
    const id = args[0];
    if (!id) {
      logError("ID required for remove");
      process.exit(1);
    }

    // Determine target first (read-only check)
    const { loadPlaybook } = await import("../playbook.js");
    let savePath = config.playbookPath;
    let checkPlaybook = await loadPlaybook(config.playbookPath);
    
    if (!findBullet(checkPlaybook, id)) {
        const repoPath = ".cass/playbook.yaml";
        const repoPlaybook = await loadPlaybook(repoPath);
        if (findBullet(repoPlaybook, id)) {
            savePath = repoPath;
        } else {
            logError(`Bullet ${id} not found`);
            process.exit(1);
        }
    }

    // Acquire lock on the target file
    await withLock(savePath, async () => {
        // Reload inside lock
        const playbook = await loadPlaybook(savePath);
        const bullet = findBullet(playbook, id);

        if (!bullet) {
             logError(`Bullet ${id} disappeared during lock acquisition`);
             process.exit(1);
        }

        if (flags.hard) {
          playbook.bullets = playbook.bullets.filter(b => b.id !== id);
        } else {
          deprecateBullet(playbook, id, flags.reason || "Removed via CLI");
        }

        await savePlaybook(playbook, savePath);

        if (flags.json) {
          console.log(JSON.stringify({ success: true, id, action: flags.hard ? "deleted" : "deprecated" }, null, 2));
        } else {
          console.log(chalk.green(`✓ ${flags.hard ? "Deleted" : "Deprecated"} bullet ${id}`));
        }
    });
  }
}
