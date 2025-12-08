import { describe, expect, test } from "bun:test";
import { computePlaybookStats } from "../src/commands/serve.js";
import { createTestPlaybook, createTestBullet, createTestConfig, createTestFeedbackEvent } from "./helpers/factories.js";

describe("serve stats resource", () => {
  const config = createTestConfig();

  test("returns counts, distribution, and top performers", () => {
    const helpfulBullet = createTestBullet({
      maturity: "established",
      feedbackEvents: [createTestFeedbackEvent("helpful", 0)]
    });

    const harmfulBullet = createTestBullet({
      maturity: "established",
      feedbackEvents: [createTestFeedbackEvent("harmful", 0)]
    });

    // Stale bullet: no feedback, created long ago
    const staleBullet = createTestBullet({
      feedbackEvents: [],
      createdAt: new Date(Date.now() - 100 * 86_400_000).toISOString()
    });

    const playbook = createTestPlaybook([helpfulBullet, harmfulBullet, staleBullet]);
    const stats = computePlaybookStats(playbook, config);

    expect(stats.total).toBe(3);
    expect(stats.byScope.global).toBe(3);
    expect(stats.byState.candidate + stats.byState.established + (stats.byState.proven || 0)).toBe(3);
    expect(stats.scoreDistribution).toBeDefined();

    // Top performers should include the helpful bullet
    expect(stats.topPerformers.length).toBeGreaterThan(0);
    expect(stats.topPerformers[0].id).toBe(helpfulBullet.id);

    // At-risk should include the harmful bullet
    expect(stats.atRiskCount).toBeGreaterThanOrEqual(1);

    // Stale count should include the stale bullet
    expect(stats.staleCount).toBeGreaterThanOrEqual(1);

    expect(stats.generatedAt).toBeTruthy();
  });
});

