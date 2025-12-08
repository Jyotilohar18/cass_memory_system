import fs from "node:fs/promises";
import path from "node:path";
import { Config } from "./types.js";
import { expandPath, ensureDir, fileExists, now } from "./utils.js";
import { sanitize } from "./security.js";
import { getSanitizeConfig } from "./config.js";
import { loadPlaybook, savePlaybook, findBullet } from "./playbook.js";
import { calculateMaturityState } from "./scoring.js";

export type OutcomeStatus = "success" | "failure" | "partial";

export interface OutcomeInput {
  sessionId: string;
  outcome: OutcomeStatus;
  rulesUsed?: string[];
  notes?: string;
  durationSec?: number;
  task?: string;
}

export interface OutcomeRecord extends OutcomeInput {
  recordedAt: string;
  path: string;
}

export async function resolveOutcomeLogPath(): Promise<string> {
  const repoPath = expandPath(".cass/outcomes.jsonl");
  const repoDirExists = await fileExists(expandPath(".cass"));

  if (repoDirExists) {
    return repoPath;
  }

  return expandPath("~/.cass-memory/outcomes.jsonl");
}

export async function recordOutcome(
  input: OutcomeInput,
  config: Config
): Promise<OutcomeRecord> {
  const targetPath = await resolveOutcomeLogPath();
  const sanitizeConfig = getSanitizeConfig(config);
  const normalizedSanitizeConfig = {
    ...sanitizeConfig,
    extraPatterns: (sanitizeConfig.extraPatterns || []).map((p) =>
      typeof p === "string" ? new RegExp(p, "g") : p
    )
  };

  const cleanedNotes = input.notes
    ? sanitize(input.notes, normalizedSanitizeConfig)
    : undefined;

  const record: OutcomeRecord = {
    ...input,
    rulesUsed: input.rulesUsed || [],
    notes: cleanedNotes,
    recordedAt: new Date().toISOString(),
    path: targetPath
  };

  await ensureDir(path.dirname(targetPath));
  await fs.appendFile(targetPath, JSON.stringify(record) + "\n", "utf-8");

  return record;
}

export async function loadOutcomes(
  config: Config,
  limit = 100
): Promise<OutcomeRecord[]> {
  const targetPath = await resolveOutcomeLogPath();
  if (!(await fileExists(targetPath))) return [];

  const content = await fs.readFile(targetPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const parsed = lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as OutcomeRecord;
      } catch {
        return null;
      }
    })
    .filter((x): x is OutcomeRecord => Boolean(x));

  // Sanitize again on read for safety
  const sanitizeConfig = getSanitizeConfig(config);
  const normalizedSanitizeConfig = {
    ...sanitizeConfig,
    extraPatterns: (sanitizeConfig.extraPatterns || []).map((p) =>
      typeof p === "string" ? new RegExp(p, "g") : p
    )
  };

  return parsed.map((o) => ({
    ...o,
    notes: o.notes ? sanitize(o.notes, normalizedSanitizeConfig) : o.notes
  }));
}

function outcomeToFeedback(outcome: OutcomeRecord): { type: "helpful" | "harmful"; weight: number; context: string } {
  switch (outcome.outcome) {
    case "success":
      return { type: "helpful", weight: 0.5, context: "outcome:success" };
    case "partial":
      return { type: "helpful", weight: 0.2, context: "outcome:partial" };
    case "failure":
    default:
      return { type: "harmful", weight: 0.5, context: "outcome:failure" };
  }
}

export async function applyOutcomeFeedback(
  outcomes: OutcomeRecord | OutcomeRecord[],
  config: Config
): Promise<{ applied: number; missing: string[] }> {
  const list = Array.isArray(outcomes) ? outcomes : [outcomes];

  const globalPath = expandPath(config.playbookPath);
  const repoPath = expandPath(".cass/playbook.yaml");

  const playbooks: Record<"global" | "repo", { path: string; loaded: any | null; dirty: boolean }> = {
    global: { path: globalPath, loaded: null, dirty: false },
    repo: { path: repoPath, loaded: null, dirty: false },
  };

  // Lazy load when first needed
  async function getPlaybook(scope: "global" | "repo") {
    const entry = playbooks[scope];
    if (entry.loaded) return entry.loaded;
    if (!(await fileExists(entry.path))) return null;
    entry.loaded = await loadPlaybook(entry.path);
    return entry.loaded;
  }

  let applied = 0;
  const missing: string[] = [];

  for (const outcome of list) {
    if (!outcome.rulesUsed || outcome.rulesUsed.length === 0) continue;
    const fb = outcomeToFeedback(outcome);

    for (const ruleId of outcome.rulesUsed) {
      let found: "repo" | "global" | null = null;

      const repoPb = await getPlaybook("repo");
      if (repoPb && findBullet(repoPb, ruleId)) {
        found = "repo";
      } else {
        const globalPb = await getPlaybook("global");
        if (globalPb && findBullet(globalPb, ruleId)) {
          found = "global";
        }
      }

      if (!found) {
        missing.push(ruleId);
        continue;
      }

      const pb = playbooks[found].loaded!;
      const bullet = findBullet(pb, ruleId);
      if (!bullet) {
        missing.push(ruleId);
        continue;
      }

      bullet.feedbackEvents = bullet.feedbackEvents || [];
      bullet.feedbackEvents.push({
        type: fb.type,
        timestamp: now(),
        sessionPath: outcome.sessionId,
        context: fb.context,
        decayedValue: fb.weight,
      });
      bullet.updatedAt = now();
      bullet.maturity = calculateMaturityState(bullet, config);
      playbooks[found].dirty = true;
      applied += 1;
    }
  }

  // Persist any modified playbooks
  for (const key of ["repo", "global"] as const) {
    const entry = playbooks[key];
    if (entry.dirty && entry.loaded) {
      await savePlaybook(entry.loaded, entry.path);
    }
  }

  return { applied, missing };
}

