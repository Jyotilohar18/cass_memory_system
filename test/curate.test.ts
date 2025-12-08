import { describe, it, expect } from "bun:test";
import { curatePlaybook } from "../src/curate";
import { Playbook, PlaybookBullet, Config, ConfigSchema } from "../src/types";

describe("curatePlaybook decay handling", () => {
  it("applies configured decay half-life to inverted anti-patterns", () => {
    const playbook: Playbook = {
      schema_version: 2,
      name: "test",
      description: "test",
      metadata: {
        createdAt: new Date().toISOString(),
        totalReflections: 0,
        totalSessionsProcessed: 0
      },
      deprecatedPatterns: [],
      bullets: [
        {
          id: "b1",
          content: "Use var instead of const",
          category: "style",
          type: "rule",
          kind: "stack_pattern",
          scope: "global",
          state: "active",
          maturity: "candidate",
          isNegative: false,
          helpfulCount: 0,
          harmfulCount: 5, // Trigger inversion (>3 harmful and >2x helpful)
          feedbackEvents: [
            { type: "harmful", timestamp: new Date().toISOString() },
            { type: "harmful", timestamp: new Date().toISOString() },
            { type: "harmful", timestamp: new Date().toISOString() },
            { type: "harmful", timestamp: new Date().toISOString() },
            { type: "harmful", timestamp: new Date().toISOString() }
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          confidenceDecayHalfLifeDays: 30,
          sourceSessions: [],
          sourceAgents: [],
          tags: [],
          pinned: false,
          deprecated: false
        }
      ]
    };

    const config: Config = ConfigSchema.parse({
        scoring: { decayHalfLifeDays: 45 },
        sanitization: { enabled: true, extraPatterns: [] }
    });

    const result = curatePlaybook(playbook, [], config);
    const antiPattern = result.playbook.bullets.find((b) => b.kind === "anti_pattern");

    expect(antiPattern).toBeDefined();
    // Should inherit from config (45), not the original bullet (30) or default (90)
    expect(antiPattern?.confidenceDecayHalfLifeDays).toBe(45);
  });
});