import { describe, expect, test } from "bun:test";
import { createTestPlaybook, createTestBullet, createTestConfig, createTestFeedbackEvent } from "./helpers/factories.js";
import { computePlaybookStats, __test as serveTest } from "../src/commands/serve.js";
import { withTempCassHome } from "./helpers/temp.js";
import { withTempGitRepo } from "./helpers/git.js";

describe("serve module stats (unit)", () => {
  const config = createTestConfig();

  test("computePlaybookStats returns counts, distribution, top performers, and staleness", async () => {
    const helpfulBullet = createTestBullet({
      maturity: "established",
      scope: "global",
      feedbackEvents: [createTestFeedbackEvent("helpful", 0)]
    });

    const harmfulBullet = createTestBullet({
      maturity: "established",
      scope: "global",
      feedbackEvents: [createTestFeedbackEvent("harmful", 0)]
    });

    // Stale bullet: no feedback, created long ago
    const staleBullet = createTestBullet({
      maturity: "candidate", // Default
      scope: "global",
      feedbackEvents: [],
      createdAt: new Date(Date.now() - 100 * 86_400_000).toISOString()
    });

    const playbook = createTestPlaybook([helpfulBullet, harmfulBullet, staleBullet]);
    const stats = computePlaybookStats(playbook, config);

    expect(stats.total).toBe(3);
    expect(stats.byScope.global).toBe(3);
    expect(stats.scoreDistribution).toEqual(
      expect.objectContaining({
        excellent: expect.any(Number),
        good: expect.any(Number),
        neutral: expect.any(Number),
        atRisk: expect.any(Number),
      })
    );
    expect(Array.isArray(stats.topPerformers)).toBe(true);
    expect(stats.topPerformers.length).toBeLessThanOrEqual(5);
    expect(stats.staleCount).toBeGreaterThanOrEqual(1);
  });

  test("routeRequest supports tools/list and rejects unsupported methods", async () => {
    const list = await serveTest.routeRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect("result" in list ? list.result?.tools?.length : 0).toBeGreaterThan(0);

    const unsupported = await serveTest.routeRequest({ jsonrpc: "2.0", id: 2, method: "nope" });
    expect("error" in unsupported).toBe(true);
    if ("error" in unsupported) {
      expect(unsupported.error.code).toBe(-32601);
    }
  });
});

describe("serve module helper functions", () => {
  describe("isLoopbackHost", () => {
    test("returns true for localhost", () => {
      expect(serveTest.isLoopbackHost("localhost")).toBe(true);
      expect(serveTest.isLoopbackHost("LOCALHOST")).toBe(true);
      expect(serveTest.isLoopbackHost("  localhost  ")).toBe(true);
    });

    test("returns true for IPv4 loopback addresses", () => {
      expect(serveTest.isLoopbackHost("127.0.0.1")).toBe(true);
      expect(serveTest.isLoopbackHost("127.0.0.0")).toBe(true);
      expect(serveTest.isLoopbackHost("127.255.255.255")).toBe(true);
    });

    test("returns true for IPv6 loopback address", () => {
      expect(serveTest.isLoopbackHost("::1")).toBe(true);
    });

    test("returns false for non-loopback addresses", () => {
      expect(serveTest.isLoopbackHost("0.0.0.0")).toBe(false);
      expect(serveTest.isLoopbackHost("192.168.1.1")).toBe(false);
      expect(serveTest.isLoopbackHost("example.com")).toBe(false);
      expect(serveTest.isLoopbackHost("")).toBe(false);
    });
  });

  describe("headerValue", () => {
    test("returns string value directly", () => {
      expect(serveTest.headerValue("Bearer token123")).toBe("Bearer token123");
    });

    test("returns first element of array", () => {
      expect(serveTest.headerValue(["token1", "token2"])).toBe("token1");
    });

    test("returns undefined for non-string values", () => {
      expect(serveTest.headerValue(undefined)).toBeUndefined();
      expect(serveTest.headerValue(null)).toBeUndefined();
      expect(serveTest.headerValue(123)).toBeUndefined();
      expect(serveTest.headerValue([])).toBeUndefined();
      expect(serveTest.headerValue([123])).toBeUndefined();
    });
  });

  describe("extractBearerToken", () => {
    test("extracts token from Bearer auth header", () => {
      expect(serveTest.extractBearerToken("Bearer mytoken123")).toBe("mytoken123");
      expect(serveTest.extractBearerToken("bearer mytoken")).toBe("mytoken");
      expect(serveTest.extractBearerToken("BEARER TOKEN")).toBe("TOKEN");
    });

    test("handles whitespace in token", () => {
      expect(serveTest.extractBearerToken("Bearer   token  ")).toBe("token");
    });

    test("returns undefined for invalid formats", () => {
      expect(serveTest.extractBearerToken(undefined)).toBeUndefined();
      expect(serveTest.extractBearerToken("")).toBeUndefined();
      expect(serveTest.extractBearerToken("Basic dXNlcjpwYXNz")).toBeUndefined();
      expect(serveTest.extractBearerToken("Bearer")).toBeUndefined();
      expect(serveTest.extractBearerToken("Bearer ")).toBeUndefined();
    });
  });

  describe("buildError", () => {
    test("creates JSON-RPC error response", () => {
      const error = serveTest.buildError(1, "Test error", -32000);
      expect(error).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "Test error" }
      });
    });

    test("includes data when provided", () => {
      const error = serveTest.buildError("req-1", "Error with data", -32001, { detail: "extra" });
      expect(error).toEqual({
        jsonrpc: "2.0",
        id: "req-1",
        error: { code: -32001, message: "Error with data", data: { detail: "extra" } }
      });
    });

    test("handles null id", () => {
      const error = serveTest.buildError(null, "No ID error");
      expect(error.id).toBeNull();
    });
  });
});

describe("serve module routing", () => {
  test("routeRequest handles resources/list", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list"
    });

    expect("result" in response).toBe(true);
    if ("result" in response) {
      expect(Array.isArray(response.result.resources)).toBe(true);
      expect(response.result.resources.length).toBeGreaterThan(0);

      const uris = response.result.resources.map((r: any) => r.uri);
      expect(uris).toContain("cm://playbook");
      expect(uris).toContain("cm://stats");
    }
  });

  test("routeRequest tools/call returns error for missing tool name", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {}
    });

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain("Missing tool name");
    }
  });

  test("routeRequest tools/call returns error for unknown tool", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} }
    });

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.message).toContain("Unknown tool");
    }
  });

  test("routeRequest resources/read returns error for missing uri", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: {}
    });

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain("Missing resource uri");
    }
  });

  test("routeRequest resources/read returns error for unknown resource", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "cm://unknown" }
    });

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.message).toContain("Unknown resource");
    }
  });
});

describe("serve module tool calls", () => {
  test("cm_context requires task argument", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const response = await serveTest.routeRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "cm_context", arguments: {} }
          });

          expect("error" in response).toBe(true);
          if ("error" in response) {
            expect(response.error.message).toContain("task");
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("cm_context succeeds with valid task", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const response = await serveTest.routeRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "cm_context", arguments: { task: "fix authentication bug" } }
          });

          expect("result" in response).toBe(true);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("cm_feedback requires bulletId argument", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cm_feedback", arguments: {} }
    });

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.message).toContain("bulletId");
    }
  });

  test("cm_feedback requires exactly one of helpful or harmful", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "cm_feedback",
        arguments: { bulletId: "b-test123", helpful: true, harmful: true }
      }
    });

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.message).toContain("exactly one");
    }
  });

  test("cm_outcome requires sessionId and outcome", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cm_outcome", arguments: {} }
    });

    expect("error" in response).toBe(true);
  });

  test("cm_outcome validates outcome enum", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "cm_outcome",
        arguments: { sessionId: "session-1", outcome: "invalid_outcome" }
      }
    });

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.message).toContain("success | failure | mixed | partial");
    }
  });

  test("memory_search requires query argument", async () => {
    const response = await serveTest.routeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "memory_search", arguments: {} }
    });

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.message).toContain("query");
    }
  });

  test("memory_search succeeds with valid query", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const response = await serveTest.routeRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "memory_search",
              arguments: { query: "authentication", scope: "playbook" }
            }
          });

          expect("result" in response).toBe(true);
          if ("result" in response) {
            expect(response.result).toHaveProperty("playbook");
            expect(Array.isArray(response.result.playbook)).toBe(true);
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("serve module resource reads", () => {
  test("reads cm://playbook resource", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const response = await serveTest.routeRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "resources/read",
            params: { uri: "cm://playbook" }
          });

          expect("result" in response).toBe(true);
          if ("result" in response) {
            expect(response.result.uri).toBe("cm://playbook");
            expect(response.result.mimeType).toBe("application/json");
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("reads cm://stats resource", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const response = await serveTest.routeRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "resources/read",
            params: { uri: "cm://stats" }
          });

          expect("result" in response).toBe(true);
          if ("result" in response) {
            expect(response.result.uri).toBe("cm://stats");
            expect(response.result.data).toHaveProperty("total");
            expect(response.result.data).toHaveProperty("byScope");
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("reads memory://stats resource (alias)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const response = await serveTest.routeRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "resources/read",
            params: { uri: "memory://stats" }
          });

          expect("result" in response).toBe(true);
          if ("result" in response) {
            expect(response.result.uri).toBe("memory://stats");
            expect(response.result.data).toHaveProperty("total");
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});
