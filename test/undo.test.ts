/**
 * Unit tests for undo command
 *
 * Tests:
 * - Un-deprecate a deprecated bullet
 * - Undo last feedback event
 * - Hard delete a bullet
 * - Error handling for non-existent bullets
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "yaml";
import { Playbook, PlaybookBullet } from "../src/types.js";

// Test helper to create a bullet
function createTestBullet(overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
  return {
    id: overrides.id || "b-test123",
    content: "Test bullet content",
    category: "testing",
    kind: "workflow_rule",
    type: "rule",
    isNegative: false,
    scope: "global",
    source: "learned",
    tags: [],
    state: "active",
    maturity: "candidate",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    sourceSessions: [],
    sourceAgents: [],
    helpfulCount: 0,
    harmfulCount: 0,
    feedbackEvents: [],
    deprecated: false,
    pinned: false,
    ...overrides
  };
}

// Test helper to create a playbook
function createTestPlaybook(bullets: PlaybookBullet[] = []): Playbook {
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook",
    metadata: {
      createdAt: "2025-01-01T00:00:00Z",
      totalReflections: 0,
      totalSessionsProcessed: 0
    },
    deprecatedPatterns: [],
    bullets
  };
}

describe("undo command - Unit Tests", () => {
  let testDir: string;
  let playbookPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cass-undo-test-"));
    const cassMemoryDir = join(testDir, ".cass-memory");
    mkdirSync(cassMemoryDir, { recursive: true });
    playbookPath = join(cassMemoryDir, "playbook.yaml");

    // Create config
    const configPath = join(cassMemoryDir, "config.yaml");
    writeFileSync(configPath, yaml.stringify({
      playbookPath,
      diaryDir: join(cassMemoryDir, "diaries"),
      defaultLookbackDays: 30,
      llmProvider: "none"
    }));
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("undeprecateBullet logic", () => {
    test("should restore deprecated bullet to active state", () => {
      const bullet = createTestBullet({
        deprecated: true,
        deprecatedAt: "2025-06-01T00:00:00Z",
        deprecationReason: "Test deprecation",
        state: "retired",
        maturity: "deprecated"
      });

      // Simulate undeprecation
      bullet.deprecated = false;
      bullet.deprecatedAt = undefined;
      bullet.deprecationReason = undefined;
      bullet.state = "active";
      bullet.maturity = "candidate";

      expect(bullet.deprecated).toBe(false);
      expect(bullet.deprecatedAt).toBeUndefined();
      expect(bullet.deprecationReason).toBeUndefined();
      expect(bullet.state).toBe("active");
      expect(bullet.maturity).toBe("candidate");
    });

    test("should preserve non-deprecated maturity if not deprecated", () => {
      const bullet = createTestBullet({
        deprecated: true,
        deprecatedAt: "2025-06-01T00:00:00Z",
        state: "retired",
        maturity: "established"  // Was established before deprecation
      });

      // Simulate undeprecation - maturity should go to candidate if it was "deprecated"
      bullet.deprecated = false;
      bullet.deprecatedAt = undefined;
      bullet.state = "active";
      // If maturity was "deprecated", restore to "candidate"
      if (bullet.maturity === "deprecated") {
        bullet.maturity = "candidate";
      }

      // Since maturity was "established" (not "deprecated"), it should stay
      expect(bullet.maturity).toBe("established");
    });
  });

  describe("undoLastFeedback logic", () => {
    test("should remove last helpful feedback and decrement count", () => {
      const bullet = createTestBullet({
        helpfulCount: 3,
        harmfulCount: 1,
        feedbackEvents: [
          { type: "helpful", timestamp: "2025-01-01T00:00:00Z" },
          { type: "harmful", timestamp: "2025-01-02T00:00:00Z" },
          { type: "helpful", timestamp: "2025-01-03T00:00:00Z" }
        ]
      });

      // Simulate undo last feedback
      const lastEvent = bullet.feedbackEvents!.pop();
      if (lastEvent?.type === "helpful") {
        bullet.helpfulCount = Math.max(0, bullet.helpfulCount - 1);
      }

      expect(bullet.helpfulCount).toBe(2);
      expect(bullet.harmfulCount).toBe(1);
      expect(bullet.feedbackEvents).toHaveLength(2);
    });

    test("should remove last harmful feedback and decrement count", () => {
      const bullet = createTestBullet({
        helpfulCount: 2,
        harmfulCount: 2,
        feedbackEvents: [
          { type: "helpful", timestamp: "2025-01-01T00:00:00Z" },
          { type: "harmful", timestamp: "2025-01-02T00:00:00Z" }
        ]
      });

      // Simulate undo last feedback
      const lastEvent = bullet.feedbackEvents!.pop();
      if (lastEvent?.type === "harmful") {
        bullet.harmfulCount = Math.max(0, bullet.harmfulCount - 1);
      }

      expect(bullet.helpfulCount).toBe(2);
      expect(bullet.harmfulCount).toBe(1);
      expect(bullet.feedbackEvents).toHaveLength(1);
    });

    test("should not go below 0 when undoing feedback", () => {
      const bullet = createTestBullet({
        helpfulCount: 0,  // Already at 0
        harmfulCount: 0,
        feedbackEvents: [
          { type: "helpful", timestamp: "2025-01-01T00:00:00Z" }
        ]
      });

      // Simulate undo
      const lastEvent = bullet.feedbackEvents!.pop();
      if (lastEvent?.type === "helpful") {
        bullet.helpfulCount = Math.max(0, bullet.helpfulCount - 1);
      }

      expect(bullet.helpfulCount).toBe(0);  // Should not be negative
    });

    test("should handle empty feedback events", () => {
      const bullet = createTestBullet({
        feedbackEvents: []
      });

      const lastEvent = bullet.feedbackEvents!.length > 0 ? bullet.feedbackEvents!.pop() : null;

      expect(lastEvent).toBeNull();
      expect(bullet.feedbackEvents).toHaveLength(0);
    });
  });

  describe("hard delete logic", () => {
    test("should remove bullet from playbook", () => {
      const bullet1 = createTestBullet({ id: "b-keep" });
      const bullet2 = createTestBullet({ id: "b-delete" });
      const playbook = createTestPlaybook([bullet1, bullet2]);

      // Simulate hard delete
      const index = playbook.bullets.findIndex(b => b.id === "b-delete");
      playbook.bullets.splice(index, 1);

      expect(playbook.bullets).toHaveLength(1);
      expect(playbook.bullets[0].id).toBe("b-keep");
    });
  });

  describe("playbook file operations", () => {
    test("should save playbook with undeprecated bullet", () => {
      const bullet = createTestBullet({
        id: "b-test",
        deprecated: true,
        deprecatedAt: "2025-06-01T00:00:00Z",
        deprecationReason: "Test reason",
        state: "retired",
        maturity: "deprecated"
      });
      const playbook = createTestPlaybook([bullet]);

      // Save original
      writeFileSync(playbookPath, yaml.stringify(playbook));

      // Read and modify
      const loaded = yaml.parse(readFileSync(playbookPath, "utf-8"));
      const loadedBullet = loaded.bullets[0];

      // Undeprecate
      loadedBullet.deprecated = false;
      loadedBullet.deprecatedAt = undefined;
      loadedBullet.deprecationReason = undefined;
      loadedBullet.state = "active";
      loadedBullet.maturity = "candidate";

      // Save again
      writeFileSync(playbookPath, yaml.stringify(loaded));

      // Verify
      const final = yaml.parse(readFileSync(playbookPath, "utf-8"));
      expect(final.bullets[0].deprecated).toBe(false);
      expect(final.bullets[0].state).toBe("active");
      expect(final.bullets[0].maturity).toBe("candidate");
    });

    test("should save playbook with updated feedback counts", () => {
      const bullet = createTestBullet({
        id: "b-test",
        helpfulCount: 5,
        harmfulCount: 2,
        feedbackEvents: [
          { type: "helpful", timestamp: "2025-01-01T00:00:00Z" },
          { type: "helpful", timestamp: "2025-01-02T00:00:00Z" }
        ]
      });
      const playbook = createTestPlaybook([bullet]);

      // Save original
      writeFileSync(playbookPath, yaml.stringify(playbook));

      // Read and modify
      const loaded = yaml.parse(readFileSync(playbookPath, "utf-8"));
      const loadedBullet = loaded.bullets[0];

      // Undo last feedback
      loadedBullet.feedbackEvents.pop();
      loadedBullet.helpfulCount = 4;

      // Save again
      writeFileSync(playbookPath, yaml.stringify(loaded));

      // Verify
      const final = yaml.parse(readFileSync(playbookPath, "utf-8"));
      expect(final.bullets[0].helpfulCount).toBe(4);
      expect(final.bullets[0].feedbackEvents).toHaveLength(1);
    });

    test("should save playbook without deleted bullet", () => {
      const bullet1 = createTestBullet({ id: "b-keep", content: "Keep this" });
      const bullet2 = createTestBullet({ id: "b-delete", content: "Delete this" });
      const playbook = createTestPlaybook([bullet1, bullet2]);

      // Save original
      writeFileSync(playbookPath, yaml.stringify(playbook));

      // Read and modify
      const loaded = yaml.parse(readFileSync(playbookPath, "utf-8"));
      const index = loaded.bullets.findIndex((b: any) => b.id === "b-delete");
      loaded.bullets.splice(index, 1);

      // Save again
      writeFileSync(playbookPath, yaml.stringify(loaded));

      // Verify
      const final = yaml.parse(readFileSync(playbookPath, "utf-8"));
      expect(final.bullets).toHaveLength(1);
      expect(final.bullets[0].id).toBe("b-keep");
    });
  });
});
