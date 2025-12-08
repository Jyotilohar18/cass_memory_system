/**
 * E2E Smoke Test - CLI Workflow
 *
 * Tests the basic CLI workflow: init -> context -> mark -> playbook
 * Runs with LLM/cass disabled to verify offline/degraded path.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CM_PATH = join(import.meta.dir, "..", "src", "cm.ts");

function runCm(args: string[], cwd: string, env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync("bun", ["run", CM_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      CASS_MEMORY_LLM: "none",  // Disable LLM
      HOME: cwd,  // Isolate from real home
      ...env
    },
    encoding: "utf-8",
    timeout: 30000
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1
  };
}

describe("E2E CLI Smoke Test", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "cass-e2e-"));
  });

  afterAll(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("cm --help shows available commands", () => {
    const result = runCm(["--help"], testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cass-memory");
    expect(result.stdout).toContain("context");
    expect(result.stdout).toContain("playbook");
    expect(result.stdout).toContain("init");
  });

  test("cm init creates config and playbook", () => {
    const result = runCm(["init", "--json"], testDir);

    // Should succeed or warn about existing
    expect(result.exitCode).toBeLessThanOrEqual(1);

    // Check files created
    const cassMemoryDir = join(testDir, ".cass-memory");
    expect(existsSync(cassMemoryDir) || result.stdout.includes("initialized")).toBe(true);
  });

  test("cm playbook list shows playbook (empty or with bullets)", () => {
    const result = runCm(["playbook", "list", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    // Should return valid JSON array
    const bullets = JSON.parse(result.stdout);
    expect(Array.isArray(bullets)).toBe(true);
  });

  test("cm playbook add creates a bullet", () => {
    const result = runCm([
      "playbook", "add",
      "Test rule for smoke testing",
      "--category", "testing",
      "--json"
    ], testDir);

    expect(result.exitCode).toBe(0);

    const response = JSON.parse(result.stdout);
    expect(response.success).toBe(true);
    expect(response.bullet).toBeDefined();
    expect(response.bullet.id).toMatch(/^b-/);
  });

  test("cm context returns context (degraded without cass)", () => {
    const result = runCm([
      "context",
      "test task for smoke testing",
      "--json"
    ], testDir);

    // May succeed with empty results or warn about missing cass
    expect(result.exitCode).toBeLessThanOrEqual(1);

    if (result.exitCode === 0) {
      const context = JSON.parse(result.stdout);
      expect(context.task).toBe("test task for smoke testing");
      expect(Array.isArray(context.relevantBullets)).toBe(true);
    }
  });

  test("cm stats returns playbook statistics", () => {
    const result = runCm(["stats", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    const stats = JSON.parse(result.stdout);
    expect(stats.total).toBeGreaterThanOrEqual(0);
    expect(stats.byScope).toBeDefined();
    expect(stats.scoreDistribution).toBeDefined();
  });

  test("cm doctor checks system health", () => {
    const result = runCm(["doctor", "--json"], testDir);

    expect(result.exitCode).toBeLessThanOrEqual(1);

    const health = JSON.parse(result.stdout);
    expect(Array.isArray(health.checks)).toBe(true);
  });

  test("cm top shows effective bullets", () => {
    const result = runCm(["top", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    const top = JSON.parse(result.stdout);
    expect(top.bullets).toBeDefined();
    expect(Array.isArray(top.bullets)).toBe(true);
  });

  test("cm stale finds stale bullets", () => {
    const result = runCm(["stale", "--json", "--days", "0"], testDir);

    expect(result.exitCode).toBe(0);

    const stale = JSON.parse(result.stdout);
    expect(stale.threshold).toBe(0);
    expect(Array.isArray(stale.bullets)).toBe(true);
  });

  test("cm quickstart shows agent documentation", () => {
    const result = runCm(["quickstart", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    const quickstart = JSON.parse(result.stdout);
    expect(quickstart.oneCommand).toContain("cm context");
    expect(quickstart.protocol).toBeDefined();
  });

  test("cm usage shows LLM cost tracking", () => {
    const result = runCm(["usage", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    const usage = JSON.parse(result.stdout);
    expect(typeof usage.today).toBe("number");
    expect(typeof usage.dailyLimit).toBe("number");
  });
});
