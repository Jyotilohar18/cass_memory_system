import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { generateDiaryId } from "../src/utils.js";
import { findDiaryBySession } from "../src/diary.js";
import { withTempDir, createTestDiary } from "./helpers/index.js";

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

// =============================================================================
// findDiaryBySession
// =============================================================================
describe("findDiaryBySession", () => {
  it("returns matching diary by sessionPath", async () => {
    await withTempDir("diary-find", async (dir) => {
      const diaryDir = dir;
      const sessionPath = path.join(dir, "sessions", "s1.jsonl");
      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      await fs.writeFile(sessionPath, "dummy");

      const entry = createTestDiary({
        id: "diary-1",
        sessionPath,
        agent: "claude",
      });
      await fs.writeFile(path.join(diaryDir, `${entry.id}.json`), JSON.stringify(entry, null, 2));

      const found = await findDiaryBySession(sessionPath, diaryDir);
      expect(found?.id).toBe("diary-1");
    });
  });

  it("matches when input path differs only by relative vs absolute", async () => {
    await withTempDir("diary-find-rel", async (dir) => {
      const diaryDir = dir;
      const sessionRel = "./sessions/s2.jsonl";
      const sessionAbs = path.resolve(dir, "sessions/s2.jsonl");
      await fs.mkdir(path.dirname(sessionAbs), { recursive: true });
      await fs.writeFile(sessionAbs, "dummy");

      const entry = createTestDiary({
        id: "diary-2",
        sessionPath: sessionAbs,
        agent: "claude",
      });
      await fs.writeFile(path.join(diaryDir, `${entry.id}.json`), JSON.stringify(entry, null, 2));

      const found = await findDiaryBySession(sessionRel, diaryDir);
      expect(found?.id).toBe("diary-2");
    });
  });

  it("returns null when no diary matches", async () => {
    await withTempDir("diary-find-none", async (dir) => {
      const found = await findDiaryBySession("/no/such/session.jsonl", dir);
      expect(found).toBeNull();
    });
  });
});
