import { describe, test, expect } from "bun:test";
import { inferOutcome } from "../src/diary.js";

describe("Fast Diary Extraction", () => {
  describe("inferOutcome", () => {
    test("returns failure for content with error patterns", () => {
      expect(inferOutcome("Error: Failed to compile")).toBe("failure");
      expect(inferOutcome("The build failed with errors")).toBe("failure");
      expect(inferOutcome("TypeError: undefined is not a function")).toBe("failure");
      expect(inferOutcome("Traceback (most recent call last)")).toBe("failure");
      expect(inferOutcome("SyntaxError: Unexpected token")).toBe("failure");
    });

    test("returns success for content with success patterns", () => {
      expect(inferOutcome("Build completed successfully")).toBe("success");
      expect(inferOutcome("All tests passed")).toBe("success");
      expect(inferOutcome("Fixed the bug in the login flow")).toBe("success");
      expect(inferOutcome("The feature works correctly now")).toBe("success");
      expect(inferOutcome("Issue resolved")).toBe("success");
    });

    test("returns mixed for content with both patterns", () => {
      expect(inferOutcome("Error: Failed to compile but then it was fixed")).toBe("mixed");
      expect(inferOutcome("Had some errors but successfully resolved them")).toBe("mixed");
      expect(inferOutcome("TypeError occurred, but all tests pass now")).toBe("mixed");
    });

    test("returns success for neutral content", () => {
      expect(inferOutcome("Working on the feature")).toBe("success");
      expect(inferOutcome("Added new functionality to the app")).toBe("success");
      expect(inferOutcome("Refactored the code")).toBe("success");
    });

    test("handles empty content", () => {
      expect(inferOutcome("")).toBe("success");
    });

    test("is case insensitive", () => {
      expect(inferOutcome("ERROR: something went wrong")).toBe("failure");
      expect(inferOutcome("error: something went wrong")).toBe("failure");
      expect(inferOutcome("SUCCESSFULLY completed")).toBe("success");
      expect(inferOutcome("Successfully completed")).toBe("success");
    });

    test("detects specific error types", () => {
      expect(inferOutcome("Cannot find module 'react'")).toBe("failure");
      expect(inferOutcome("Module not found")).toBe("failure");
      expect(inferOutcome("null reference exception")).toBe("failure");
      expect(inferOutcome("RuntimeError: stack overflow")).toBe("failure");
    });

    test("detects specific success patterns", () => {
      expect(inferOutcome("Build successful")).toBe("success");
      expect(inferOutcome("All tests pass")).toBe("success");
      expect(inferOutcome("It works now")).toBe("success");
      expect(inferOutcome("Done with the implementation")).toBe("success");
    });
  });
});
