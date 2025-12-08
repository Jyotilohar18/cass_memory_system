import { describe, it, expect } from "bun:test";
import {
  formatBulletsForPrompt,
  formatDiaryForPrompt,
  hashDelta,
  deduplicateDeltas,
  shouldExitEarly,
  getCassHistoryForDiary
} from "../src/reflect.js";
import { createTestBullet, createTestDiary, createTestConfig } from "./helpers/factories.js";
import { PlaybookDelta } from "../src/types.js";

describe("reflect module", () => {
  describe("formatBulletsForPrompt", () => {
    it("returns specific message when playbook is empty", () => {
      const result = formatBulletsForPrompt([]);
      expect(result).toBe("(No existing rules in playbook)");
    });

    it("formats bullets grouped by category", () => {
      const b1 = createTestBullet({ 
        id: "b-1", 
        category: "testing", 
        content: "Always write tests", 
        maturity: "proven",
        helpfulCount: 10,
        harmfulCount: 0
      });
      const b2 = createTestBullet({ 
        id: "b-2", 
        category: "security", 
        content: "Sanitize inputs", 
        maturity: "established",
        helpfulCount: 5,
        harmfulCount: 1
      });
      const b3 = createTestBullet({ 
        id: "b-3", 
        category: "testing", 
        content: "Run linter", 
        maturity: "candidate",
        helpfulCount: 1,
        harmfulCount: 0
      });

      const result = formatBulletsForPrompt([b1, b2, b3]);
      
      expect(result).toContain("## testing");
      expect(result).toContain("## security");
      expect(result).toContain("[b-1] ★ Always write tests (10+ / 0-)");
      expect(result).toContain("[b-2] ● Sanitize inputs (5+ / 1-)");
      expect(result).toContain("[b-3] ○ Run linter (1+ / 0-)");
    });
  });

  describe("formatDiaryForPrompt", () => {
    it("formats diary entry with all sections", () => {
      const diary = createTestDiary({
        sessionPath: "/path/to/session.jsonl",
        agent: "claude",
        workspace: "my-repo",
        status: "success",
        timestamp: "2025-01-01T12:00:00Z",
        accomplishments: ["Fixed bug"],
        decisions: ["Chose libraries"],
        challenges: ["API rate limits"],
        keyLearnings: ["Rate limits need backoff"],
        preferences: ["Use tabs"]
      });

      const result = formatDiaryForPrompt(diary);

      expect(result).toContain("## Session Overview");
      expect(result).toContain("- Path: /path/to/session.jsonl");
      expect(result).toContain("- Agent: claude");
      expect(result).toContain("## Accomplishments");
      expect(result).toContain("- Fixed bug");
      expect(result).toContain("## Decisions Made");
      expect(result).toContain("- Chose libraries");
      expect(result).toContain("## Challenges Encountered");
      expect(result).toContain("- API rate limits");
      expect(result).toContain("## Key Learnings");
      expect(result).toContain("- Rate limits need backoff");
      expect(result).toContain("## User Preferences");
      expect(result).toContain("- Use tabs");
    });

    it("omits empty sections", () => {
      const diary = createTestDiary({
        accomplishments: [],
        decisions: [],
        challenges: [],
        keyLearnings: [],
        preferences: []
      });

      const result = formatDiaryForPrompt(diary);

      expect(result).toContain("## Session Overview");
      expect(result).not.toContain("## Accomplishments");
      expect(result).not.toContain("## Decisions Made");
      expect(result).not.toContain("## Challenges Encountered");
      expect(result).not.toContain("## Key Learnings");
      expect(result).not.toContain("## User Preferences");
    });
  });

  describe("hashDelta", () => {
    it("hashes add delta based on content", () => {
      const d1: PlaybookDelta = { 
        type: "add", 
        bullet: { category: "cat", content: "Same Content" }, 
        reason: "r", 
        sourceSession: "s" 
      };
      const d2: PlaybookDelta = { 
        type: "add", 
        bullet: { category: "other", content: "same content" }, // lowercased in hash
        reason: "r2", 
        sourceSession: "s2" 
      };
      
      expect(hashDelta(d1)).toBe("add:same content");
      expect(hashDelta(d2)).toBe("add:same content");
    });

    it("hashes replace delta based on id and new content", () => {
      const d1: PlaybookDelta = { type: "replace", bulletId: "b-1", newContent: "New" };
      expect(hashDelta(d1)).toBe("replace:b-1:New");
    });

    it("hashes merge delta based on bullet IDs", () => {
      const d1: PlaybookDelta = { type: "merge", bulletIds: ["b-1", "b-2"], mergedContent: "M" };
      expect(hashDelta(d1)).toBe("merge:b-1,b-2");
    });

    it("hashes deprecate delta based on bullet ID", () => {
      const d1: PlaybookDelta = { type: "deprecate", bulletId: "b-1", reason: "r" };
      expect(hashDelta(d1)).toBe("deprecate:b-1");
    });

    it("hashes feedback deltas based on type and bullet ID", () => {
      const d1: PlaybookDelta = { type: "helpful", bulletId: "b-1" };
      const d2: PlaybookDelta = { type: "harmful", bulletId: "b-1" };
      expect(hashDelta(d1)).toBe("helpful:b-1");
      expect(hashDelta(d2)).toBe("harmful:b-1");
    });
  });

  describe("deduplicateDeltas", () => {
    it("removes duplicates based on hash", () => {
      const d1: PlaybookDelta = { 
        type: "add", 
        bullet: { category: "cat", content: "Content" }, 
        reason: "r1", 
        sourceSession: "s1" 
      };
      const d2: PlaybookDelta = { 
        type: "add", 
        bullet: { category: "cat", content: "Content" }, 
        reason: "r2", 
        sourceSession: "s2" 
      };
      const d3: PlaybookDelta = { 
        type: "add", 
        bullet: { category: "cat", content: "Different" }, 
        reason: "r3", 
        sourceSession: "s3" 
      };

      const existing: PlaybookDelta[] = [];
      const newDeltas = [d1, d2, d3];

      const result = deduplicateDeltas(newDeltas, existing);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(d1);
      expect(result[1]).toBe(d3);
    });

    it("filters out deltas already in existing set", () => {
      const d1: PlaybookDelta = { 
        type: "add", 
        bullet: { category: "cat", content: "Content" }, 
        reason: "r1", 
        sourceSession: "s1" 
      };
      const existing = [d1];
      const newDeltas = [d1];

      const result = deduplicateDeltas(newDeltas, existing);
      expect(result).toHaveLength(0);
    });
  });

  describe("shouldExitEarly", () => {
    const config = createTestConfig({ maxReflectorIterations: 3 });

    it("exits if no deltas found in current iteration", () => {
      expect(shouldExitEarly(0, 0, 10, config)).toBe(true);
    });

    it("exits if total deltas exceed max (20)", () => {
      expect(shouldExitEarly(1, 5, 20, config)).toBe(true);
      expect(shouldExitEarly(1, 5, 25, config)).toBe(true);
    });

    it("exits if last iteration reached", () => {
      expect(shouldExitEarly(2, 5, 10, config)).toBe(true);
    });

    it("does not exit if conditions not met", () => {
      expect(shouldExitEarly(0, 5, 5, config)).toBe(false);
      expect(shouldExitEarly(1, 5, 10, config)).toBe(false);
    });
  });
});
