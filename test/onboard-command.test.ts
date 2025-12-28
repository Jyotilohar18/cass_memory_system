/**
 * Tests for the onboard command input validation and subcommands
 *
 * Tests:
 * - Input validation for limit, days, workspace, agent, read, mark-done
 * - Subcommands: reset, mark-done, status, gaps, sample, read, prompt, guided
 * - Error handling paths
 */
import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import yaml from "yaml";
import { onboardCommand } from "../src/commands/onboard.js";
import { withTempCassHome } from "./helpers/temp.js";
import { withTempGitRepo } from "./helpers/git.js";
import { createTestPlaybook, createTestBullet } from "./helpers/factories.js";
import { markSessionProcessed, loadOnboardState } from "../src/onboard-state.js";

/**
 * Capture console output during async function execution.
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

describe("onboardCommand input validation", () => {
  test("rejects invalid limit (negative)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, limit: -5, json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("limit");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid limit (zero)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, limit: 0, json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("limit");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid days (negative)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, days: -10, json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("days");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid days (zero)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, days: 0, json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("days");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects empty workspace string", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, workspace: "", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("workspace");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects empty agent string", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, agent: "", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("agent");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects empty read path", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ read: "", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("read");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects empty mark-done path", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ markDone: "", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("mark-done");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("onboardCommand --reset", () => {
  test("requires confirmation without --yes", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          // Non-interactive mode (no TTY) without --yes should error
          await onboardCommand({ reset: true, json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("confirmation");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("resets with --yes flag", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        // Add some progress first
        await markSessionProcessed("/test/session.jsonl", 5);

        const capture = captureConsole();
        try {
          await onboardCommand({ reset: true, yes: true, json: true });
          const output = capture.getOutput();
          expect(output).toContain("success");
          expect(output).toContain("reset");

          // Verify state was cleared
          const state = await loadOnboardState();
          expect(state.processedSessions).toEqual([]);
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("resets in non-json mode with --yes", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ reset: true, yes: true });
          const output = capture.getOutput();
          // Should show success message (with icon/checkmark)
          expect(output.toLowerCase()).toContain("reset");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("onboardCommand --mark-done", () => {
  test("marks session as processed", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ markDone: "/test/session.jsonl", json: true });
          const output = capture.getOutput();
          expect(output).toContain("success");
          expect(output).toContain("/test/session.jsonl");

          // Verify state was updated
          const state = await loadOnboardState();
          expect(state.processedSessions).toHaveLength(1);
          expect(state.processedSessions[0].skipped).toBe(true);
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("marks session in non-json mode", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await onboardCommand({ markDone: "/another/session.jsonl" });
          const output = capture.getOutput();
          // Should show success indicator and path
          expect(output).toContain("/another/session.jsonl");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("onboardCommand --status", () => {
  test("returns status in JSON mode", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        // Create a playbook with some bullets
        const bullets = [
          createTestBullet({ id: "b-1" }),
          createTestBullet({ id: "b-2" }),
        ];
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

        const capture = captureConsole();
        try {
          await onboardCommand({ status: true, json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
          expect(result.command).toBe("onboard:status");
          expect(result.data.status).toBeDefined();
          expect(result.data.status.playbookRules).toBeGreaterThanOrEqual(0);
          expect(result.data.progress).toBeDefined();
          expect(result.data.gapAnalysis).toBeDefined();
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("returns status in text mode", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ status: true });
          const output = capture.getOutput();
          expect(output).toContain("ONBOARDING STATUS");
          expect(output).toContain("Playbook rules");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("shows progress when sessions processed", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        // Add some progress
        await markSessionProcessed("/test/s1.jsonl", 3);
        await markSessionProcessed("/test/s2.jsonl", 5);

        const capture = captureConsole();
        try {
          await onboardCommand({ status: true });
          const output = capture.getOutput();
          expect(output).toContain("PROGRESS");
          expect(output).toContain("Sessions analyzed");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("onboardCommand --gaps", () => {
  test("shows gap analysis in JSON mode", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ gaps: true, json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
          expect(result.command).toBe("onboard:gaps");
          expect(result.data.gapAnalysis).toBeDefined();
          expect(result.data.gapAnalysis.gaps).toBeDefined();
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("shows gap analysis in text mode", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ gaps: true });
          const output = capture.getOutput();
          expect(output).toContain("PLAYBOOK GAP ANALYSIS");
          expect(output).toContain("CATEGORY BREAKDOWN");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("onboardCommand --sample", () => {
  test("accepts valid limit", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, limit: 5, json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
          expect(result.command).toBe("onboard:sample");
          expect(result.data.sessions).toBeDefined();
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("accepts valid days parameter", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, days: 30, json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
          expect(result.data.sessions).toBeDefined();
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("accepts workspace filter", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, workspace: "/test/workspace", json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("accepts agent filter", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, agent: "claude", json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("supports fill-gaps mode", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true, fillGaps: true, json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
          expect(result.data.gapAnalysis).toBeDefined();
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("sample in text mode shows header", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ sample: true });
          const output = capture.getOutput();
          // Should show the header
          expect(output).toContain("SAMPLED SESSIONS");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("onboardCommand --read", () => {
  test("handles non-existent session path", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ read: "/nonexistent/session.jsonl", json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          // Should succeed but with null content
          expect(result.success).toBe(true);
          expect(result.data.sessionContent).toBeNull();
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("includes extraction prompt in response", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ read: "/test/session.jsonl", json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.data.extractionPrompt).toBeDefined();
          expect(result.data.extractionPrompt).toContain("Session Analysis");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("--read --template with non-existent session returns error", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ read: "/nonexistent.jsonl", template: true, json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          // Template mode should error on missing session
          expect(result.success).toBe(false);
          expect(result.error).toBeDefined();
          expect(result.error.message.toLowerCase()).toContain("session");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("onboardCommand --prompt", () => {
  test("returns extraction prompt in JSON mode", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ prompt: true, json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
          expect(result.command).toBe("onboard:prompt");
          expect(result.data.extractionPrompt).toBeDefined();
          expect(result.data.categories).toBeDefined();
          expect(result.data.examples).toBeDefined();
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("returns extraction prompt in text mode", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ prompt: true });
          const output = capture.getOutput();
          expect(output).toContain("Session Analysis");
          expect(output).toContain("What to Look For");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("onboardCommand default (guided mode)", () => {
  test("returns guided onboarding in JSON mode", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({ json: true });
          const output = capture.getOutput();
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
          expect(result.command).toBe("onboard:guided");
          expect(result.data.status).toBeDefined();
          expect(result.data.categories).toBeDefined();
          expect(result.data.examples).toBeDefined();
          expect(result.data.extractionPrompt).toBeDefined();
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("returns guided onboarding in text mode", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        try {
          await onboardCommand({});
          const output = capture.getOutput();
          expect(output).toContain("Agent-Native Onboarding");
          expect(output).toContain("How This Works");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });
});
