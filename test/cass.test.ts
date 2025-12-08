import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  cassAvailable,
  handleCassUnavailable,
  cassNeedsIndex,
  cassSearch,
  safeCassSearch,
  cassExport,
  cassExpand,
  cassTimeline,
  findUnprocessedSessions,
  CASS_EXIT_CODES,
} from "../src/cass.js";
import { withTempDir } from "./helpers/index.js";
import { createTestConfig } from "./helpers/factories.js";

function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

async function makeCassStub(dir: string, overrides: Partial<Record<string, string>> = {}) {
  const healthExit = overrides.healthExit ?? "${HEALTH_EXIT:-0}";
  const script = [
    "#!/bin/sh",
    'cmd="$1"; shift',
    'case "$cmd" in',
    '  --version) exit 0 ;;',
    `  health) exit ${healthExit} ;;`,
    '  index) exit 0 ;;',
    '  search)',
    `    echo ${shQuote(overrides.search || '[{"source_path":"/sessions/s1.jsonl","line_number":1,"agent":"stub","snippet":"hello","score":0.9}]')}`,
    "    exit 0 ;;",
    '  export)',
    `    echo ${shQuote(overrides.export || "# Session transcript")}`,
    "    exit 0 ;;",
    '  expand)',
    `    printf %s ${shQuote(overrides.expand || "context lines")}`,
    "    exit 0 ;;",
    '  timeline)',
    `    echo ${shQuote(overrides.timeline || '{"groups":[{"date":"2025-01-01","sessions":[{"path":"/sessions/s1.jsonl","agent":"stub"}]}]}')}`,
    "    exit 0 ;;",
    "  *) exit 9 ;;",
    "esac",
  ].join("\n");

  const scriptPath = path.join(dir, "cass-stub.sh");
  await fs.writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

describe("cass.ts core functions (stubbed)", () => {
  it("cassAvailable detects stub", async () => {
    await withTempDir("cass-available", async (dir) => {
      const cassPath = await makeCassStub(dir);
      expect(cassAvailable(cassPath)).toBe(true);
    });
  });

  it("handleCassUnavailable falls back when cass missing", async () => {
    const result = await handleCassUnavailable({ cassPath: "/no/cass", searchCommonPaths: false });
    expect(result.fallbackMode).toBe("playbook-only");
    expect(result.canContinue).toBe(true);
  });

  it("cassNeedsIndex returns true on INDEX_MISSING health code", async () => {
    await withTempDir("cass-health", async (dir) => {
      const cassPath = await makeCassStub(dir, { healthExit: `${CASS_EXIT_CODES.INDEX_MISSING}` });
      expect(cassNeedsIndex(cassPath)).toBe(true);
    });
  });

  it("safeCassSearch parses hits from stub", async () => {
    await withTempDir("cass-search", async (dir) => {
      const cassPath = await makeCassStub(dir);
      const config = await createTestConfig();
      const hits = await safeCassSearch("query", { limit: 1 }, cassPath, config);
      expect(hits.length).toBe(1);
      expect(hits[0].agent).toBe("stub");
      expect(hits[0].snippet).toBe("hello");
    });
  });

  it("cassExport returns content from stub", async () => {
    await withTempDir("cass-export", async (dir) => {
      const cassPath = await makeCassStub(dir, { export: "EXPORT_CONTENT" });
      const content = await cassExport("session.jsonl", "markdown", cassPath);
      expect(content).toContain("EXPORT_CONTENT");
    });
  });

  it("cassExpand returns context from stub", async () => {
    await withTempDir("cass-expand", async (dir) => {
      const cassPath = await makeCassStub(dir, { expand: "EXPANDED" });
      const content = await cassExpand("session.jsonl", 10, 2, cassPath);
      expect(content?.trim()).toBe("EXPANDED");
    });
  });

  it("cassTimeline returns groups parsed from stub", async () => {
    await withTempDir("cass-timeline", async (dir) => {
      const cassPath = await makeCassStub(dir);
      const timeline = await cassTimeline(7, cassPath);
      expect(timeline.groups.length).toBe(1);
      expect(timeline.groups[0].sessions[0].path).toBe("/sessions/s1.jsonl");
    });
  });

  it("findUnprocessedSessions respects processed set", async () => {
    await withTempDir("cass-find", async (dir) => {
      const cassPath = await makeCassStub(dir);
      const processed = new Set<string>(["/sessions/s1.jsonl"]);
      const sessions = await findUnprocessedSessions(processed, { days: 7, maxSessions: 5 }, cassPath);
      expect(sessions).toHaveLength(0);
    });
  });
});
