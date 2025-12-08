import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateContextResult } from "../../src/commands/context.js";
import { applyOutcomeFeedback, OutcomeRecord } from "../../src/outcome.js";
import { savePlaybook, createEmptyPlaybook } from "../../src/playbook.js";

async function withTempEnv(run: (ctx: { home: string; repo: string }) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cass-home-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "cass-repo-"));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  try {
    process.env.HOME = home;
    process.chdir(repo);
    await run({ home, repo });
  } finally {
    process.env.HOME = prevHome;
    process.chdir(prevCwd);
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  }
}

describe("Integration: context logging + outcome feedback", () => {
  test("context logs rules and outcome backfills missing rulesUsed", async () => {
    await withTempEnv(async ({ home, repo }) => {
      // 1) Prepare global playbook with one bullet
      const playbookPath = path.join(home, ".cass-memory", "playbook.yaml");
      await fs.mkdir(path.dirname(playbookPath), { recursive: true });
      const pb = createEmptyPlaybook("test");
      pb.bullets.push({
        id: "b-int-1",
        scope: "global",
        category: "testing",
        content: "Always hydrate context",
        searchPointer: undefined,
        type: "rule",
        isNegative: false,
        kind: "workflow_rule",
        state: "active",
        maturity: "candidate",
        promotedAt: undefined,
        helpfulCount: 0,
        harmfulCount: 0,
        feedbackEvents: [],
        lastValidatedAt: undefined,
        confidenceDecayHalfLifeDays: 90,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pinned: false,
        deprecated: false,
        deprecatedAt: undefined,
        replacedBy: undefined,
        deprecationReason: undefined,
        sourceSessions: [],
        sourceAgents: [],
        reasoning: undefined,
        tags: [],
        embedding: undefined,
        effectiveScore: undefined,
        workspace: undefined,
        scopeKey: undefined,
      });
      await savePlaybook(pb, playbookPath);

      // 2) Ensure repo .cass exists for context log
      await fs.mkdir(path.join(repo, ".cass"), { recursive: true });

      // 3) Run context with logging enabled
      const sessionId = "sess-int-1";
      const { result } = await generateContextResult("hydrate context", {
        json: true,
        logContext: true,
        session: sessionId,
      });

      expect(result.relevantBullets.length).toBeGreaterThan(0);
      const logPath = path.join(repo, ".cass", "context-log.jsonl");
      const logContent = await fs.readFile(logPath, "utf-8");
      expect(logContent).toContain("b-int-1");

      // 4) Apply outcome with empty rulesUsed; should backfill from context log
      const outcome: OutcomeRecord = {
        sessionId,
        outcome: "success",
        rulesUsed: [],
        recordedAt: new Date().toISOString(),
        path: "in-memory",
      };

      const feedbackResult = await applyOutcomeFeedback(outcome, {
        // Minimal config override to point to the playbook we created
        ...require("../../src/config.js").DEFAULT_CONFIG,
        playbookPath,
      });

      expect(feedbackResult.applied).toBe(1);
    });
  });
});

