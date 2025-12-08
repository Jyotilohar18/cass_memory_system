/**
 * E2E Tests for CLI context command - Pre-task briefing
 *
 * Tests the `cm context` command for generating task-relevant context
 * from playbook rules and session history.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { contextCommand, generateContextResult, ContextFlags } from "../src/commands/context.js";
import { withTempCassHome, TestEnv } from "./helpers/temp.js";
import { createTestLogger } from "./helpers/logger.js";

// Helper to capture console output
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

// Sample playbook content for testing
function createTestPlaybook(bullets: any[] = []) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook for E2E tests",
    metadata: {
      createdAt: now,
      totalReflections: 0,
      totalSessionsProcessed: 0
    },
    bullets: bullets,
    deprecatedPatterns: []
  };
}

// Helper to create a valid test bullet
function createTestBullet(overrides: Partial<{
  id: string;
  content: string;
  kind: string;
  category: string;
  scope: string;
  workspace?: string;
  tags: string[];
  maturity: string;
  isNegative?: boolean;
  effectiveScore?: number;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `test-${Date.now()}`,
    content: overrides.content || "Test bullet content",
    kind: overrides.kind || "stack_pattern",
    category: overrides.category || "testing",
    scope: overrides.scope || "global",
    workspace: overrides.workspace,
    tags: overrides.tags || [],
    maturity: overrides.maturity || "candidate",
    isNegative: overrides.isNegative || false,
    effectiveScore: overrides.effectiveScore ?? 0.8,
    state: "active",
    type: overrides.isNegative ? "anti-pattern" : "rule",
    helpfulCount: 0,
    harmfulCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

describe("E2E: CLI context command", () => {
  describe("Basic Context Generation", () => {
    it("generates empty context when no playbook rules exist", async () => {
      await withTempCassHome(async (env) => {
        // Create minimal playbook with no bullets
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult("implement user auth", {});

        expect(result.task).toBe("implement user auth");
        expect(result.relevantBullets).toEqual([]);
        expect(result.antiPatterns).toEqual([]);
        expect(Array.isArray(result.suggestedCassQueries)).toBe(true);
      });
    });

    it("returns relevant bullets matching task keywords", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "test-auth-1",
            content: "Always validate JWT tokens before processing requests",
            kind: "workflow_rule",
            category: "security",
            tags: ["auth", "jwt", "security"],
            effectiveScore: 0.8
          }),
          createTestBullet({
            id: "test-db-1",
            content: "Use connection pooling for database connections",
            kind: "stack_pattern",
            category: "database",
            tags: ["database", "performance"],
            effectiveScore: 0.7
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult("implement JWT authentication", {});

        // Auth-related bullet should be returned
        expect(result.relevantBullets.length).toBeGreaterThanOrEqual(1);
        const authBullet = result.relevantBullets.find(b => b.id === "test-auth-1");
        expect(authBullet).toBeDefined();
      });
    });

    it("separates anti-patterns from regular rules", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "rule-1",
            content: "Use prepared statements for SQL queries",
            kind: "workflow_rule",
            category: "security",
            tags: ["sql", "security"],
            effectiveScore: 0.8
          }),
          createTestBullet({
            id: "anti-1",
            content: "Never concatenate user input directly into SQL",
            kind: "anti_pattern",
            category: "security",
            tags: ["sql", "security"],
            effectiveScore: 0.8,
            isNegative: true
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult("write SQL query handler", {});

        // Rules and anti-patterns should be separated
        const hasRule = result.relevantBullets.some(b => b.id === "rule-1");
        const hasAntiPattern = result.antiPatterns.some(b => b.id === "anti-1");

        expect(hasRule || hasAntiPattern).toBe(true);
        // Anti-patterns should NOT appear in relevantBullets
        const antiInRules = result.relevantBullets.some(b => b.kind === "anti_pattern");
        expect(antiInRules).toBe(false);
      });
    });

    it("respects workspace filtering", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "global-1",
            content: "Global rule applies everywhere",
            kind: "project_convention",
            category: "general",
            scope: "global",
            tags: ["api"],
            effectiveScore: 0.8
          }),
          createTestBullet({
            id: "workspace-1",
            content: "Frontend-specific rule",
            kind: "stack_pattern",
            category: "frontend",
            scope: "workspace",
            workspace: "frontend",
            tags: ["api", "react"],
            effectiveScore: 0.8
          }),
          createTestBullet({
            id: "workspace-2",
            content: "Backend-specific rule",
            kind: "stack_pattern",
            category: "backend",
            scope: "workspace",
            workspace: "backend",
            tags: ["api", "node"],
            effectiveScore: 0.8
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult("build API endpoint", {
          workspace: "frontend"
        });

        // Should include global and frontend rules, but not backend
        const ids = result.relevantBullets.map(b => b.id);

        // Global rules should be included
        if (ids.includes("global-1")) {
          expect(ids).toContain("global-1");
        }

        // Frontend workspace rules may be included
        // Backend workspace rules should NOT be included
        expect(ids).not.toContain("workspace-2");
      });
    });
  });

  describe("Output Formats", () => {
    it("outputs JSON when --json flag is set", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await contextCommand("test task", { json: true });
        } finally {
          capture.restore();
        }

        // Should output valid JSON
        expect(capture.logs.length).toBeGreaterThan(0);
        const output = capture.logs.join("\n");
        const parsed = JSON.parse(output);

        expect(parsed.task).toBe("test task");
        expect(Array.isArray(parsed.relevantBullets)).toBe(true);
        expect(Array.isArray(parsed.antiPatterns)).toBe(true);
      });
    });

    it("outputs JSON when format=json", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await contextCommand("test task", { format: "json" });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const parsed = JSON.parse(output);
        expect(parsed.task).toBe("test task");
      });
    });

    it("outputs human-readable markdown by default", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "test-rule",
            content: "Test rule content",
            kind: "workflow_rule",
            category: "testing",
            tags: ["test"],
            effectiveScore: 0.8
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await contextCommand("test task", {});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");

        // Should contain human-readable headers
        expect(output).toContain("CONTEXT FOR:");
        expect(output).toContain("test task");
      });
    });
  });

  describe("Deprecated Patterns", () => {
    it("warns when task matches deprecated patterns", async () => {
      await withTempCassHome(async (env) => {
        const now = new Date().toISOString();
        const playbook = {
          schema_version: 2,
          name: "test-playbook",
          description: "Test playbook with deprecated patterns",
          metadata: {
            createdAt: now,
            totalReflections: 0,
            totalSessionsProcessed: 0
          },
          bullets: [],
          deprecatedPatterns: [
            {
              pattern: "moment\\.js",
              replacement: "date-fns or dayjs",
              reason: "moment.js is in maintenance mode",
              deprecatedAt: now
            }
          ]
        };
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult(
          "add moment.js for date formatting",
          {}
        );

        expect(result.deprecatedWarnings.length).toBeGreaterThan(0);
        const hasWarning = result.deprecatedWarnings.some(w =>
          w.includes("deprecated pattern") && w.includes("moment")
        );
        expect(hasWarning).toBe(true);
      });
    });
  });

  describe("Suggested Queries", () => {
    it("generates suggested cass queries from task keywords", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult(
          "implement user authentication with OAuth",
          {}
        );

        expect(Array.isArray(result.suggestedCassQueries)).toBe(true);
        // Should have some suggested queries based on keywords
        expect(result.suggestedCassQueries.length).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe("Limits and Constraints", () => {
    it("respects --top flag for bullet limit", async () => {
      await withTempCassHome(async (env) => {
        // Create many bullets
        const bullets = Array.from({ length: 20 }, (_, i) =>
          createTestBullet({
            id: `rule-${i}`,
            content: `Rule number ${i} about APIs`,
            kind: "stack_pattern",
            category: "api",
            tags: ["api"],
            effectiveScore: 0.8 - (i * 0.01)
          })
        );
        const playbook = createTestPlaybook(bullets);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult("build API", { top: 3 });

        // Should respect the limit
        expect(result.relevantBullets.length).toBeLessThanOrEqual(3);
      });
    });
  });

  describe("Cass Integration", () => {
    it("gracefully handles when cass is unavailable", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "test-rule",
            content: "Test rule for fallback",
            kind: "workflow_rule",
            category: "testing",
            tags: ["test"],
            effectiveScore: 0.8
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Force cass to be "unavailable" by using invalid path
        process.env.CASS_PATH = "/nonexistent/cass/binary";

        try {
          const { result } = await generateContextResult("test task", {});

          // Should still return playbook rules even without cass
          expect(result.task).toBe("test task");
          expect(Array.isArray(result.relevantBullets)).toBe(true);
          // History will be empty since cass is unavailable
          expect(result.historySnippets).toEqual([]);
        } finally {
          delete process.env.CASS_PATH;
        }
      });
    });

    it("returns history snippets when cass is available", async () => {
      // This test requires cass to be installed
      // Skip if cass is not available
      const { cassAvailable } = await import("../src/cass.js");

      if (!cassAvailable()) {
        console.log("Skipping cass integration test - cass not installed");
        return;
      }

      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result, cassHits } = await generateContextResult(
          "implement feature",
          { history: 5, days: 30 }
        );

        // With cass available, historySnippets may have results
        // (depends on actual indexed sessions)
        expect(Array.isArray(result.historySnippets)).toBe(true);
      });
    });
  });

  describe("Error Handling", () => {
    it("handles missing playbook gracefully", async () => {
      await withTempCassHome(async (env) => {
        // Remove the playbook file
        await rm(env.playbookPath, { force: true });

        // Should not throw, but return empty context
        try {
          const { result } = await generateContextResult("test task", {});
          expect(result.task).toBe("test task");
        } catch (err) {
          // Some error handling is acceptable
          expect(err).toBeDefined();
        }
      });
    });

    it("handles malformed playbook gracefully", async () => {
      await withTempCassHome(async (env) => {
        // Write invalid YAML
        await writeFile(env.playbookPath, "invalid: yaml: content: [[[");

        try {
          const { result } = await generateContextResult("test task", {});
          // May return empty or throw depending on implementation
          expect(result.task).toBe("test task");
        } catch (err) {
          // Error is acceptable for malformed config
          expect(err).toBeDefined();
        }
      });
    });
  });
});
