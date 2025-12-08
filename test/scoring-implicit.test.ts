import { describe, test, expect } from "bun:test";
import { getEffectiveScore } from "../src/scoring.js";
import { createTestBullet, createTestConfig, createTestFeedbackEvent } from "./helpers/factories.js";

describe("Implicit Feedback Scoring", () => {
  const config = createTestConfig();
  const now = Date.now();

  test("should calculate score correctly with mixed implicit and explicit feedback", () => {
    const events = [
      createTestFeedbackEvent("helpful", 0),
      createTestFeedbackEvent("helpful", 0)
    ];

    const bullet = createTestBullet({ feedbackEvents: events });
    const score = getEffectiveScore(bullet, config);
    
    expect(score).toBeCloseTo(1.0, 2); // Use closeTo for floating point
  });

  test("should decay old implicit feedback", () => {
    const bullet = createTestBullet({
      feedbackEvents: [
        createTestFeedbackEvent("helpful", 90) // 90 days ago
      ]
    });

    const score = getEffectiveScore(bullet, config);
    expect(score).toBeCloseTo(0.25, 2);
  });

  test("future events should be clamped", () => {
    const bullet = createTestBullet({
      feedbackEvents: [
        createTestFeedbackEvent("helpful", -1) // 1 day in future
      ]
    });

    const score = getEffectiveScore(bullet, config);
    expect(score).toBe(0.5);
  });
});