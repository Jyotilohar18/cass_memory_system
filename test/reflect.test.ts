import { describe, test, expect, mock, beforeEach } from "bun:test";
import { reflectOnSession, deduplicateDeltas } from "../src/reflect.js"; // Internal export for testing
import { createTestConfig, createTestDiary, createTestPlaybook, createTestBullet } from "./helpers/factories.js";
import { PlaybookDelta } from "../src/types.js";

// Mock llm module to avoid real API calls
const mockRunReflector = mock();
mock.module("../src/llm.js", () => ({
  runReflector: mockRunReflector
}));

// Mock cass module
const mockSafeCassSearch = mock();
mock.module("../src/cass.js", () => ({
  safeCassSearch: mockSafeCassSearch
}));

describe("reflectOnSession", () => {
  const config = createTestConfig();

  beforeEach(() => {
    mockRunReflector.mockClear();
    mockSafeCassSearch.mockClear();
  });
  
  test("should terminate when no new insights found", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();
    
    // Mock LLM to return empty list
    mockRunReflector.mockResolvedValue({ deltas: [] });
    mockSafeCassSearch.mockResolvedValue([]);

    const deltas = await reflectOnSession(diary, playbook, config);
    
    expect(deltas).toEqual([]);
    expect(mockRunReflector).toHaveBeenCalledTimes(1); // Should stop after 1
  });

  test("should aggregate unique deltas across iterations", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();
    
    // Iteration 1 returns A
    // Iteration 2 returns B
    // Iteration 3 returns A (duplicate)
    
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

    mockRunReflector
      .mockResolvedValueOnce({ deltas: [deltaA] })
      .mockResolvedValueOnce({ deltas: [deltaB] })
      .mockResolvedValueOnce({ deltas: [deltaA] });
      
    mockSafeCassSearch.mockResolvedValue([]);

    const deltas = await reflectOnSession(diary, playbook, config);
    
    expect(deltas).toHaveLength(2);
    expect(deltas.map(d => d.type === 'add' ? d.bullet.content : '')).toContain("Rule A");
    expect(deltas.map(d => d.type === 'add' ? d.bullet.content : '')).toContain("Rule B");
  });

  test("should stop if max iterations reached", async () => {
    mockRunReflector.mockClear();
    const diary = createTestDiary();
    const playbook = createTestPlaybook();
    
    // Mock always returning new stuff
    mockRunReflector.mockResolvedValue({ 
      deltas: [{ 
        type: "add", 
        bullet: { content: "Unique", category: "test" },
        reason: "reason",
        sourceSession: diary.sessionPath 
      }] 
    });
    mockSafeCassSearch.mockResolvedValue([]);

    await reflectOnSession(diary, playbook, { ...config, maxReflectorIterations: 2 });
    
    expect(mockRunReflector).toHaveBeenCalledTimes(2);
  });
});

describe("deduplicateDeltas", () => {
  test("should filter exact duplicates", () => {
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

  test("should filter duplicates by content hash for adds", () => {
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

  test("should allow distinct adds", () => {
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