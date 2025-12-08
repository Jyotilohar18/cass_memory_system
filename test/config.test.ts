import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG, loadConfig, getSanitizeConfig } from "../src/config.js";
import { ConfigSchema, Config } from "../src/types.js";

describe("Config", () => {
  test("DEFAULT_CONFIG should be valid", () => {
    const result = ConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  test("getSanitizeConfig should merge defaults", () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      sanitization: {
        enabled: false,
        extraPatterns: ["foo"],
        auditLog: true,
        auditLevel: "info"
      }
    };

    const sanitized = getSanitizeConfig(config);
    expect(sanitized.enabled).toBe(false);
    expect(sanitized.extraPatterns).toEqual(["foo"]);
    expect(sanitized.auditLog).toBe(true);
  });

  test("getSanitizeConfig should handle missing config", () => {
    const sanitized = getSanitizeConfig(undefined);
    expect(sanitized.enabled).toBe(true);
    expect(sanitized.extraPatterns).toEqual([]);
  });
});
