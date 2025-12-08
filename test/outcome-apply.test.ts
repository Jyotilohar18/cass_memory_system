import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyOutcomeFeedback, OutcomeRecord } from "../src/outcome.js";
import { createTestBullet, createTestConfig } from "./helpers/factories.js";
import { savePlaybook } from "../src/playbook.js";

async function withTempPlaybook(run: (playbookPath: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cass-outcome-"));
  try {
    await run(path.join(dir, "playbook.yaml"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("applyOutcomeFeedback", () => {
  test("applies helpful feedback for success outcome", async () => {
    await withTempPlaybook(async (playbookPath) => {
      const bullet = createTestBullet({ id: "b-1" });
      await savePlaybook(
        { schema_version: 2, name: "pb", description: "", metadata: { createdAt: new Date().toISOString(), totalReflections: 0, totalSessionsProcessed: 0 }, deprecatedPatterns: [], bullets: [bullet] },
        playbookPath
      );

      const outcome: OutcomeRecord = {
        sessionId: "/tmp/session.jsonl",
        outcome: "success",
        rulesUsed: ["b-1"],
        recordedAt: new Date().toISOString(),
        path: playbookPath
      };

      const result = await applyOutcomeFeedback(outcome, createTestConfig({ playbookPath }));
      expect(result.applied).toBe(1);
      const content = await fs.readFile(playbookPath, "utf-8");
      expect(content).toContain("feedbackEvents");
    });
  });
});

