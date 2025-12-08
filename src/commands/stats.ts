import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import {
  analyzeScoreDistribution,
  getEffectiveScore,
  isStale
} from "../scoring.js";
import { jaccardSimilarity } from "../utils.js";
import chalk from "chalk";

export async function statsCommand(options: { json?: boolean }): Promise<void> {
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);
  const bullets = playbook.bullets;

  const distribution = analyzeScoreDistribution(getActiveBullets(playbook), config);
  const total = bullets.length;

  const byScope = countBy(bullets, (b) => b.scope ?? "unknown");
  const byState = countBy(bullets, (b) => b.state ?? "unknown");
  const byKind = countBy(bullets, (b) => b.kind ?? "unknown");

  const scores = bullets.map((b) => ({
    bullet: b,
    score: getEffectiveScore(b, config)
  }));

  const topPerformers = scores
    .filter((s) => !isNaN(s.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ bullet, score }) => ({
      id: bullet.id,
      content: bullet.content,
      score,
      helpfulCount: bullet.helpfulCount || 0
    }));

  const mostHelpful = [...bullets]
    .sort((a, b) => (b.helpfulCount || 0) - (a.helpfulCount || 0))
    .slice(0, 5)
    .map((b) => ({ id: b.id, content: b.content, helpfulCount: b.helpfulCount || 0 }));

  const atRisk = scores.filter((s) => s.score < 0).map((s) => s.bullet);
  const stale = bullets.filter((b) => isStale(b, 90));

  const mergeCandidates = findMergeCandidates(bullets, 0.8, 5);

  const stats = {
    total,
    byScope,
    byState,
    byKind,
    scoreDistribution: distribution,
    topPerformers,
    mostHelpful,
    atRiskCount: atRisk.length,
    staleCount: stale.length,
    mergeCandidates
  };

  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  printHumanStats(stats);
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function findMergeCandidates(
  bullets: any[],
  threshold: number,
  limit: number
): Array<{ a: string; b: string; similarity: number }> {
  const pairs: Array<{ a: string; b: string; similarity: number }> = [];
  for (let i = 0; i < bullets.length; i++) {
    for (let j = i + 1; j < bullets.length; j++) {
      const sim = jaccardSimilarity(bullets[i].content, bullets[j].content);
      if (sim >= threshold) {
        pairs.push({
          a: bullets[i].id,
          b: bullets[j].id,
          similarity: Number(sim.toFixed(2))
        });
      }
      if (pairs.length >= limit) break;
    }
    if (pairs.length >= limit) break;
  }
  return pairs;
}

function printHumanStats(stats: {
  total: number;
  byScope: Record<string, number>;
  byState: Record<string, number>;
  byKind: Record<string, number>;
  scoreDistribution: ReturnType<typeof analyzeScoreDistribution>;
  topPerformers: Array<{ id: string; content: string; score: number; helpfulCount?: number }>;
  mostHelpful: Array<{ id: string; content: string; helpfulCount: number }>;
  atRiskCount: number;
  staleCount: number;
  mergeCandidates: Array<{ a: string; b: string; similarity: number }>;
}) {
  console.log(chalk.bold("\n📊 Playbook Health Dashboard"));
  console.log(`Total Bullets: ${stats.total}`);

  console.log(chalk.bold("\nBy Scope:"));
  for (const [scope, count] of Object.entries(stats.byScope)) {
    console.log(`  ${scope}: ${count}`);
  }

  console.log(chalk.bold("\nBy State:"));
  for (const [state, count] of Object.entries(stats.byState)) {
    console.log(`  ${state}: ${count}`);
  }

  console.log(chalk.bold("\nBy Kind:"));
  for (const [kind, count] of Object.entries(stats.byKind)) {
    console.log(`  ${kind}: ${count}`);
  }

  console.log(chalk.bold("\nScore Distribution:"));
  console.log(`  🌟 Excellent (>10): ${stats.scoreDistribution.excellent}`);
  console.log(`  ✅ Good (5-10):    ${stats.scoreDistribution.good}`);
  console.log(`  ⚪ Neutral (0-5):  ${stats.scoreDistribution.neutral}`);
  console.log(`  ⚠️  At Risk (<0):   ${stats.scoreDistribution.atRisk}`);

  if (stats.topPerformers.length > 0) {
    console.log(chalk.bold("\n🏆 Top Performers (effective score):"));
    stats.topPerformers.forEach((b, i) => {
      console.log(`  ${i + 1}. [${b.id}] ${b.content.slice(0, 60)}... (${b.score.toFixed(1)})`);
    });
  }

  if (stats.mostHelpful.length > 0) {
    console.log(chalk.bold("\n👍 Most Helpful (feedback count):"));
    stats.mostHelpful.forEach((b, i) => {
      console.log(`  ${i + 1}. [${b.id}] ${b.content.slice(0, 60)}... (${b.helpfulCount})`);
    });
  }

  console.log(chalk.bold(`\n⚠️  At Risk: ${stats.atRiskCount}`));
  console.log(chalk.bold(`🕐 Stale (90d+): ${stats.staleCount}`));

  if (stats.mergeCandidates.length > 0) {
    console.log(chalk.bold("\n🔄 Merge Candidates (similarity ≥ 0.8):"));
    stats.mergeCandidates.forEach((p) => {
      console.log(`  - ${p.a} ↔ ${p.b} (sim ${p.similarity})`);
    });
  }
}