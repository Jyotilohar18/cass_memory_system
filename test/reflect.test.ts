import { describe, test, expect } from "bun:test";
import { reflectOnSession, deduplicateDeltas } from "../src/reflect.js"; // Internal export for testing
import { __test as reflectCommandTest } from "../src/commands/reflect.js";
import { createTestConfig, createTestDiary, createTestPlaybook, createTestBullet } from "./helpers/factories.js";
import { PlaybookDelta } from "../src/types.js";
import { formatBulletsForPrompt, hashDelta, shouldExitEarly } from "../src/reflect.js";
import { withLlmShim } from "./helpers/llm-shim.js";

describe("reflectOnSession", () => {
  const config = createTestConfig();

  test("should terminate when no new insights found", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();

    // Use LLMIO injection instead of env var
    await withLlmShim({
      reflector: { deltas: [] }
    }, async (io) => {
      const result = await reflectOnSession(diary, playbook, config, io);
      const deltas = Array.isArray(result) ? result : result.deltas ?? [];
      expect(deltas).toEqual([]);
    });
  });

  test("should aggregate unique deltas across iterations", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();

    // Per-iteration responses: A, B, then A (duplicate)
    const deltaA: PlaybookDelta = {
      type: "add",
      bullet: { content: "Rule A", category: "test" },
      reason: "reason A",
      sourceSession: diary.sessionPath
    };

    const deltaB: PlaybookDelta = {
      type: "add",
      bullet: { content: "Rule B", category: "test" },
      reason: "reason B",
      sourceSession: diary.sessionPath
    };

    // Use a function to return different responses per iteration
    let callCount = 0;
    const iterationResponses = [
      { deltas: [deltaA] },
      { deltas: [deltaB] },
      { deltas: [deltaA] }
    ];

    await withLlmShim({
      reflector: () => {
        const response = iterationResponses[callCount] || { deltas: [] };
        callCount++;
        return response;
      }
    }, async (io) => {
      const result = await reflectOnSession(diary, playbook, config, io);
      const deltas = Array.isArray(result) ? result : result.deltas ?? [];

      expect(deltas).toHaveLength(2);
      expect(deltas.map(d => d.type === 'add' ? d.bullet.content : '')).toContain("Rule A");
      expect(deltas.map(d => d.type === 'add' ? d.bullet.content : '')).toContain("Rule B");
    });
  });

  test("should stop if max iterations reached", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();

    let callCount = 0;
    const iterationResponses = [
      { deltas: [{ type: "add" as const, bullet: { content: "Unique", category: "test" }, reason: "reason", sourceSession: diary.sessionPath }] },
      { deltas: [{ type: "add" as const, bullet: { content: "Another", category: "test" }, reason: "reason", sourceSession: diary.sessionPath }] },
    ];

    await withLlmShim({
      reflector: () => {
        const response = iterationResponses[callCount] || { deltas: [] };
        callCount++;
        return response;
      }
    }, async (io) => {
      const result = await reflectOnSession(diary, playbook, { ...config, maxReflectorIterations: 2 }, io);
      const deltas = Array.isArray(result) ? result : result.deltas ?? [];
      expect(deltas.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("deduplicateDeltas", () => {
  test.serial("should filter exact duplicates", () => {
    const delta: PlaybookDelta = {
      type: "add",
      bullet: { content: "content", category: "cat" },
      reason: "reason",
      sourceSession: "s1"
    };
    
    const existing = [delta];
    const newDeltas = [delta];
    
    const result = deduplicateDeltas(newDeltas, existing);
    expect(result).toHaveLength(0);
  });

  test.serial("should filter duplicates by content hash for adds", () => {
    const d1: PlaybookDelta = {
      type: "add",
      bullet: { content: "Same Content", category: "cat1" },
      reason: "r1",
      sourceSession: "s1"
    };
    
    const d2: PlaybookDelta = {
      type: "add",
      bullet: { content: "same content", category: "cat2" }, // distinct case
      reason: "r2",
      sourceSession: "s2"
    };
    
    const result = deduplicateDeltas([d2], [d1]);
    expect(result).toHaveLength(0); // Should match case-insensitive
  });

  test.serial("should allow distinct adds", () => {
    const d1: PlaybookDelta = {
      type: "add",
      bullet: { content: "A", category: "c" },
      reason: "r",
      sourceSession: "s"
    };
    const d2: PlaybookDelta = {
      type: "add",
      bullet: { content: "B", category: "c" },
      reason: "r",
      sourceSession: "s"
    };
    
    const result = deduplicateDeltas([d2], [d1]);
    expect(result).toHaveLength(1);
  });
});

describe("reflect command helpers (unit)", () => {
  test("summarizeDeltas counts delta types", () => {
    const deltas: PlaybookDelta[] = [
      { type: "add", bullet: { content: "A", category: "c" }, reason: "r", sourceSession: "s" },
      { type: "helpful", bulletId: "b-1" },
      { type: "harmful", bulletId: "b-2" },
      { type: "replace", bulletId: "b-3", newContent: "new" },
      { type: "deprecate", bulletId: "b-4", reason: "outdated" },
      { type: "merge", bulletIds: ["b-5", "b-6"], mergedContent: "merged" },
    ];

    const counts = reflectCommandTest.summarizeDeltas(deltas);
    expect(counts.add).toBe(1);
    expect(counts.helpful).toBe(1);
    expect(counts.harmful).toBe(1);
    expect(counts.replace).toBe(1);
    expect(counts.deprecate).toBe(1);
    expect(counts.merge).toBe(1);
  });

  test("formatDeltaLine renders each delta type", () => {
    expect(
      reflectCommandTest.formatDeltaLine({ type: "add", bullet: { content: "A", category: "cat" }, reason: "r", sourceSession: "s" })
    ).toContain("ADD");
    expect(reflectCommandTest.formatDeltaLine({ type: "helpful", bulletId: "b-1" })).toBe("HELPFUL  b-1");
    expect(reflectCommandTest.formatDeltaLine({ type: "harmful", bulletId: "b-2" })).toBe("HARMFUL  b-2");
    expect(reflectCommandTest.formatDeltaLine({ type: "harmful", bulletId: "b-3", reason: "wasted_time" })).toContain("(wasted_time)");
    expect(reflectCommandTest.formatDeltaLine({ type: "replace", bulletId: "b-4", newContent: "new" })).toContain("REPLACE");
    expect(reflectCommandTest.formatDeltaLine({ type: "deprecate", bulletId: "b-5", reason: "outdated" })).toContain("DEPRECATE");
    expect(reflectCommandTest.formatDeltaLine({ type: "merge", bulletIds: ["b-6", "b-7"], mergedContent: "merged" })).toContain("MERGE");
  });
});

describe("reflect module helpers (unit)", () => {
  test("formatBulletsForPrompt handles empty playbook", () => {
    expect(formatBulletsForPrompt([])).toBe("(Playbook is empty)");
  });

  test("hashDelta normalizes merge ids and replace content", () => {
    const mergeA: PlaybookDelta = { type: "merge", bulletIds: ["b-2", "b-1"], mergedContent: "m" };
    const mergeB: PlaybookDelta = { type: "merge", bulletIds: ["b-1", "b-2"], mergedContent: "m" };
    expect(hashDelta(mergeA)).toBe(hashDelta(mergeB));

    const replaceA: PlaybookDelta = { type: "replace", bulletId: "b-3", newContent: " New   Content " };
    const replaceB: PlaybookDelta = { type: "replace", bulletId: "b-3", newContent: "new content" };
    expect(hashDelta(replaceA)).toBe(hashDelta(replaceB));
  });

  test("shouldExitEarly respects iteration, per-iteration, and total thresholds", () => {
    const config = createTestConfig({ maxReflectorIterations: 3 });

    expect(shouldExitEarly(0, 0, 0, config)).toBe(true);
    expect(shouldExitEarly(0, 1, 20, config)).toBe(true);
    expect(shouldExitEarly(2, 1, 1, config)).toBe(true);
    expect(shouldExitEarly(0, 1, 1, config)).toBe(false);
  });
});
