/**
 * Tests for the validate command
 *
 * Tests the `cm validate` command which validates proposed rules against
 * historical evidence from cass sessions.
 *
 * Note: Many tests focus on input validation and error handling paths
 * since the full validation flow requires LLM API access.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { validateCommand } from "../src/commands/validate.js";
import { evidenceCountGate, EvidenceGateResult } from "../src/validate.js";
import { withTempCassHome, TestEnv } from "./helpers/temp.js";
import { withTempGitRepo } from "./helpers/git.js";
import { loadConfig } from "../src/config.js";

/**
 * Capture console.log output during async function execution.
 */
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
    getOutput: () => logs.join("\n"),
    getErrors: () => errors.join("\n"),
  };
}

describe("validateCommand", () => {
  describe("input validation", () => {
    it("throws error for empty proposed rule", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            await expect(validateCommand("", { json: false })).rejects.toThrow(
              "Proposed rule text is required"
            );
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("throws error for whitespace-only rule", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            await expect(
              validateCommand("   \t\n  ", { json: false })
            ).rejects.toThrow("Proposed rule text is required");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("accepts valid rule text", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            // This will fail at LLM step, but should not fail at input validation
            await expect(
              validateCommand("Always use TypeScript", { json: true })
            ).rejects.toThrow(/API/); // Expects API key error, not input error
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("error handling", () => {
    it("throws API key error when LLM is required but not configured", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          const originalApiKey = process.env.ANTHROPIC_API_KEY;
          process.chdir(repoDir);
          delete process.env.ANTHROPIC_API_KEY;

          try {
            await expect(
              validateCommand("Test rule for validation", { json: true })
            ).rejects.toThrow(/ANTHROPIC_API_KEY|API/);
          } finally {
            if (originalApiKey) {
              process.env.ANTHROPIC_API_KEY = originalApiKey;
            }
            process.chdir(originalCwd);
          }
        });
      });
    });
  });
});

describe("evidenceCountGate", () => {
  it("returns draft state when no keywords can be extracted", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          // Very short content with no meaningful keywords
          const result = await evidenceCountGate("a", config);

          expect(result.passed).toBe(true);
          expect(result.suggestedState).toBe("draft");
          expect(result.reason).toContain("No meaningful keywords");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("returns draft state when no historical evidence is found", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          // Rule with keywords but no cass history to match
          const result = await evidenceCountGate(
            "Always use TypeScript for all new projects",
            config
          );

          expect(result.passed).toBe(true);
          expect(result.suggestedState).toBe("draft");
          // May return "No historical evidence" or proceed to ambiguous
          expect(["draft"]).toContain(result.suggestedState);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("returns numeric counts for session analysis", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          const result = await evidenceCountGate(
            "Handle authentication errors gracefully",
            config
          );

          expect(typeof result.sessionCount).toBe("number");
          expect(typeof result.successCount).toBe("number");
          expect(typeof result.failureCount).toBe("number");
          expect(result.sessionCount).toBeGreaterThanOrEqual(0);
          expect(result.successCount).toBeGreaterThanOrEqual(0);
          expect(result.failureCount).toBeGreaterThanOrEqual(0);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("provides a reason for its decision", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          const result = await evidenceCountGate(
            "Use async/await instead of callbacks",
            config
          );

          expect(typeof result.reason).toBe("string");
          expect(result.reason.length).toBeGreaterThan(0);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("has valid structure for gate result", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          const result = await evidenceCountGate(
            "Prefer composition over inheritance for code reuse",
            config
          );

          // Check all required fields exist
          expect(typeof result.passed).toBe("boolean");
          expect(typeof result.reason).toBe("string");
          expect(["draft", "active"]).toContain(result.suggestedState);
          expect(typeof result.sessionCount).toBe("number");
          expect(typeof result.successCount).toBe("number");
          expect(typeof result.failureCount).toBe("number");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("classifyOutcome (via validate module)", () => {
  // The classifyOutcome function is private but we can test its behavior
  // indirectly through integration tests with mock cass data

  it("recognizes success keywords in snippets", async () => {
    // This is tested via the evidenceCountGate when cass returns matching snippets
    // Since we can't mock cass easily here, we verify the function exists
    // and the gate can process snippets
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          // Run gate which internally uses pattern matching
          const result = await evidenceCountGate(
            "Fixed the authentication bug successfully",
            config
          );

          // Result should be valid regardless of actual cass data
          expect(result).toBeDefined();
          expect(typeof result.passed).toBe("boolean");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});
