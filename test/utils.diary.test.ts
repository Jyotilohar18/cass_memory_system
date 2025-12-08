import { describe, expect, it } from "bun:test";
import { generateDiaryId } from "../src/utils.js";

describe("utils.generateDiaryId", () => {
  it("generates unique IDs for the same session path in rapid succession", () => {
    const path = "/path/to/session.jsonl";
    const id1 = generateDiaryId(path);
    const id2 = generateDiaryId(path);
    
    // Note: With the old implementation using Date.now(), these would likely collide
    // if running on a fast machine. With the fix, they should differ.
    expect(id1).not.toBe(id2);
  });

  it("generates unique IDs for different paths", () => {
    const id1 = generateDiaryId("/path/a");
    const id2 = generateDiaryId("/path/b");
    expect(id1).not.toBe(id2);
  });

  it("maintains format 'diary-<hash>'", () => {
    const id = generateDiaryId("test");
    expect(id).toMatch(/^diary-[a-f0-9]{16}$/);
  });
});
