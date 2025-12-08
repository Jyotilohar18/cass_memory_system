import { describe, it, expect } from "bun:test";
import {
  calculateDecayedValue,
  getDecayedCounts,
  getEffectiveScore,
  calculateMaturityState,
  checkForPromotion,
  checkForDemotion,
  isStale,
  analyzeScoreDistribution,
} from "../src/scoring.js";
import { FeedbackEvent, Config } from "../src/types.js";
import { createTestBullet, createTestConfig, createTestFeedbackEvent } from "./helpers/factories.js";

const DAY_MS = 86_400_000;

function daysAgo(days: number) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function feedback(type: "helpful" | "harmful", days: number, overrides: Partial<FeedbackEvent> = {}): FeedbackEvent {
  return createTestFeedbackEvent(type, { timestamp: daysAgo(days), ...overrides });
}

describe("scoring", () => {
  // Base config for most tests
  const config = createTestConfig();

  describe("calculateDecayedValue", () => {
    it("returns ~1 for recent events", () => {
      const now = new Date();
      const val = calculateDecayedValue(feedback("helpful", 0), now, 90);
      expect(val).toBeCloseTo(1, 2);
    });

    it("returns ~0.5 at half-life", () => {
      const now = new Date();
      const val = calculateDecayedValue(feedback("helpful", 90), now, 90);
      expect(val).toBeCloseTo(0.5, 2);
    });

    it("returns ~0.25 at 2x half-life", () => {
      const now = new Date();
      const val = calculateDecayedValue(feedback("helpful", 180), now, 90);
      expect(val).toBeCloseTo(0.25, 2);
    });

    it("returns 1 for future events (clamped)", () => {
      const now = new Date();
      // event 10 days in future
      const futureEvent = { type: "helpful", timestamp: new Date(now.getTime() + 10 * DAY_MS).toISOString() } as FeedbackEvent;
      const val = calculateDecayedValue(futureEvent, now, 90);
      expect(val).toBe(1);
    });

    it("returns 0 for invalid half-life", () => {
      const now = new Date();
      const val = calculateDecayedValue(feedback("helpful", 0), now, -5);
      expect(val).toBe(0);
    });

    it("returns 0 for zero half-life", () => {
        const now = new Date();
        const val = calculateDecayedValue(feedback("helpful", 0), now, 0);
        expect(val).toBe(0);
    });
  });

  describe("getDecayedCounts", () => {
    it("separates helpful and harmful events", () => {
      const bullet = createTestBullet({
        feedbackEvents: [feedback("helpful", 0), feedback("harmful", 0)],
      });
      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
      expect(decayedHelpful).toBeGreaterThan(0.99);
      expect(decayedHarmful).toBeGreaterThan(0.99);
    });

    it("respects event.decayedValue overrides", () => {
      const bullet = createTestBullet({
        feedbackEvents: [
          feedback("helpful", 0, { decayedValue: 5 }), // Explicit weight
          feedback("harmful", 0, { decayedValue: 2 }),
        ],
      });
      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
      // Base is ~1, multiplied by weight
      expect(decayedHelpful).toBeCloseTo(5, 1);
      expect(decayedHarmful).toBeCloseTo(2, 1);
    });

    it("handles configuration drift (legacy vs nested scoring)", () => {
      // Test legacy config path
      const legacyConfig = { defaultDecayHalfLife: 30 } as unknown as Config;
      const bullet = createTestBullet({
        feedbackEvents: [feedback("helpful", 30)],
      });
      const { decayedHelpful } = getDecayedCounts(bullet, legacyConfig);
      expect(decayedHelpful).toBeCloseTo(0.5, 2); // 30 days is half life

      // Test nested scoring config path (priority)
      const nestedConfig = {
        defaultDecayHalfLife: 90,
        scoring: { decayHalfLifeDays: 30 }
      } as unknown as Config;
      const { decayedHelpful: nestedVal } = getDecayedCounts(bullet, nestedConfig);
      expect(nestedVal).toBeCloseTo(0.5, 2); // Should use 30 from scoring
    });
    
    it("defaults to 90 days if config is missing half-life", () => {
        const emptyConfig = {} as unknown as Config;
        const bullet = createTestBullet({
            feedbackEvents: [feedback("helpful", 90)],
        });
        const { decayedHelpful } = getDecayedCounts(bullet, emptyConfig);
        expect(decayedHelpful).toBeCloseTo(0.5, 2);
    });
  });

  describe("getEffectiveScore", () => {
    it("applies harmful multiplier", () => {
      const bullet = createTestBullet({
        feedbackEvents: [feedback("helpful", 0), feedback("harmful", 0)],
        maturity: "established", // multiplier 1.0
      });
      // config defaults: harmfulMultiplier = 4
      // score = 1 - (4 * 1) = -3
      const score = getEffectiveScore(bullet, config);
      expect(score).toBeCloseTo(-3, 1);
    });

    it("applies maturity multipliers", () => {
      const events = [feedback("helpful", 0)]; // score ~1

      const candidate = createTestBullet({ maturity: "candidate", feedbackEvents: events });
      expect(getEffectiveScore(candidate, config)).toBeCloseTo(0.5, 2); // 0.5 mult

      const established = createTestBullet({ maturity: "established", feedbackEvents: events });
      expect(getEffectiveScore(established, config)).toBeCloseTo(1.0, 2); // 1.0 mult

      const proven = createTestBullet({ maturity: "proven", feedbackEvents: events });
      expect(getEffectiveScore(proven, config)).toBeCloseTo(1.5, 2); // 1.5 mult

      const deprecated = createTestBullet({ maturity: "deprecated", feedbackEvents: events });
      expect(getEffectiveScore(deprecated, config)).toBe(0); // 0 mult
    });

    it("uses custom harmful multiplier from config", () => {
      const customConfig = { scoring: { harmfulMultiplier: 10 } } as unknown as Config;
      const bullet = createTestBullet({
        feedbackEvents: [feedback("helpful", 0), feedback("harmful", 0)],
        maturity: "established",
      });
      // 1 - 10 = -9
      expect(getEffectiveScore(bullet, customConfig)).toBeCloseTo(-9, 1);
    });
  });

  describe("calculateMaturityState", () => {
    it("returns 'deprecated' if manually deprecated", () => {
        const bullet = createTestBullet({ deprecated: true, maturity: "established" });
        expect(calculateMaturityState(bullet, config)).toBe("deprecated");
        
        const bulletMaturity = createTestBullet({ maturity: "deprecated" });
        expect(calculateMaturityState(bulletMaturity, config)).toBe("deprecated");
    });

    it("returns 'candidate' if insufficient feedback (< 3 events)", () => {
      const bullet = createTestBullet({
        feedbackEvents: [feedback("helpful", 0), feedback("helpful", 0)],
      });
      expect(calculateMaturityState(bullet, config)).toBe("candidate");
    });

    it("returns 'established' when enough feedback but not proven", () => {
      const bullet = createTestBullet({
        // 3 events, good ratio
        feedbackEvents: [feedback("helpful", 0), feedback("helpful", 0), feedback("helpful", 0)],
      });
      // score ~3, ratio 0. < 10 score, so not proven
      expect(calculateMaturityState(bullet, config)).toBe("established");
    });

    it("returns 'proven' when score >= 10 and ratio < 0.1", () => {
      // 10 helpful events, 0 harmful
      const events = Array.from({ length: 11 }, () => feedback("helpful", 0));
      const bullet = createTestBullet({ feedbackEvents: events });
      expect(calculateMaturityState(bullet, config)).toBe("proven");
    });

    it("returns 'deprecated' if harmful ratio > 0.3 (and total > 2)", () => {
      // 2 helpful, 2 harmful. Total 4. Ratio 0.5.
      const bullet = createTestBullet({
        feedbackEvents: [
            feedback("helpful", 0), feedback("helpful", 0),
            feedback("harmful", 0), feedback("harmful", 0)
        ],
      });
      expect(calculateMaturityState(bullet, config)).toBe("deprecated");
    });
    
    it("does not deprecate if total events <= 2 even with high harmful ratio", () => {
        // 1 helpful, 1 harmful. Total 2. Ratio 0.5 (>0.3). But total <= 2.
        // Falls through to total < 3 -> candidate
        const bullet = createTestBullet({
            feedbackEvents: [feedback("helpful", 0), feedback("harmful", 0)],
        });
        expect(calculateMaturityState(bullet, config)).toBe("candidate");
    });
    
    it("returns 'established' if score < 10 but ratio < 0.1 and count >= 3", () => {
         const bullet = createTestBullet({
            feedbackEvents: [feedback("helpful", 0), feedback("helpful", 0), feedback("helpful", 0), feedback("helpful", 0)],
        });
        expect(calculateMaturityState(bullet, config)).toBe("established");
    });
  });

  describe("checkForPromotion", () => {
    it("promotes candidate to established", () => {
      const bullet = createTestBullet({
        maturity: "candidate",
        // Use 4 events to safely exceed total >= 3 even with slight decay
        feedbackEvents: [
            feedback("helpful", 0), feedback("helpful", 0), 
            feedback("helpful", 0), feedback("helpful", 0)
        ],
      });
      expect(checkForPromotion(bullet, config)).toBe("established");
    });

    it("promotes established to proven", () => {
      const events = Array.from({ length: 11 }, () => feedback("helpful", 0));
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: events,
      });
      expect(checkForPromotion(bullet, config)).toBe("proven");
    });

    it("promotes candidate directly to proven", () => {
        const events = Array.from({ length: 11 }, () => feedback("helpful", 0));
        const bullet = createTestBullet({
          maturity: "candidate",
          feedbackEvents: events,
        });
        expect(checkForPromotion(bullet, config)).toBe("proven");
      });

    it("does not change if already proven", () => {
      const bullet = createTestBullet({ maturity: "proven" });
      expect(checkForPromotion(bullet, config)).toBe("proven");
    });
    
    it("does not change if deprecated", () => {
        const bullet = createTestBullet({ maturity: "deprecated" });
        expect(checkForPromotion(bullet, config)).toBe("deprecated");
    });

    it("does not promote if requirements not met", () => {
      const bullet = createTestBullet({
        maturity: "candidate",
        feedbackEvents: [feedback("helpful", 0)],
      });
      expect(checkForPromotion(bullet, config)).toBe("candidate");
    });
  });

  describe("checkForDemotion", () => {
    it("ignores pinned bullets", () => {
      const bullet = createTestBullet({
        maturity: "proven",
        pinned: true,
        feedbackEvents: [feedback("harmful", 0)], // would normally demote
      });
      expect(checkForDemotion(bullet, config)).toBe("proven");
    });

    it("returns 'auto-deprecate' if score below pruneHarmfulThreshold", () => {
        // config.pruneHarmfulThreshold default is 3. So score < -3.
        // Two harmful events (wt 4 each) = -8. Safely below -3.
        const bullet = createTestBullet({
            feedbackEvents: [feedback("harmful", 0), feedback("harmful", 0)],
        });
        expect(checkForDemotion(bullet, config)).toBe("auto-deprecate");
    });

    it("demotes proven to established if score < 0", () => {
        // Score needs to be < 0 but > -3.
        // Helpful=1 (1), Harmful=0.5 (2) -> 1 - 2 = -1.
        const bullet = createTestBullet({
            maturity: "proven",
            feedbackEvents: [
                feedback("helpful", 0), 
                feedback("harmful", 0, { decayedValue: 0.5 }) // artificially lower weight to control score
            ],
        });
        // Override helper calculation to ensure negative score without hitting auto-deprecate
        // helpful: 1, harmful: 0.5 * 4 = 2. Total -1.
        // However, factory doesn't allow setting decayedValue easily in a way getDecayedCounts sees without complex setup?
        // Wait, getDecayedCounts uses calculateDecayedValue OR event.decayedValue.
        
        // Let's use time decay.
        // Helpful 180 days ago (0.25). Harmful 180 days ago (0.25 * 4 = 1). Score -0.75.
        // -0.75 > -3.
        const bulletTime = createTestBullet({
            maturity: "proven",
            feedbackEvents: [
                feedback("helpful", 180),
                feedback("harmful", 180)
            ]
        });
        
        expect(checkForDemotion(bulletTime, config)).toBe("established");
    });

    it("demotes established to candidate if score < 0", () => {
        const bulletTime = createTestBullet({
            maturity: "established",
            feedbackEvents: [
                feedback("helpful", 180),
                feedback("harmful", 180)
            ]
        });
        expect(checkForDemotion(bulletTime, config)).toBe("candidate");
    });
    
    it("does not demote candidate (stays candidate) if score < 0 but not auto-deprecate", () => {
         const bulletTime = createTestBullet({
            maturity: "candidate",
            feedbackEvents: [
                feedback("helpful", 180),
                feedback("harmful", 180)
            ]
        });
        expect(checkForDemotion(bulletTime, config)).toBe("candidate");
    });

    it("does nothing if score >= 0", () => {
       const bullet = createTestBullet({
           maturity: "proven",
           feedbackEvents: [feedback("helpful", 0)]
       });
       expect(checkForDemotion(bullet, config)).toBe("proven");
    });
  });

  describe("isStale", () => {
    it("returns true if no events and created long ago", () => {
      const bullet = createTestBullet({ createdAt: daysAgo(100), feedbackEvents: [] });
      expect(isStale(bullet, 90)).toBe(true);
    });

    it("returns false if no events and created recently", () => {
      const bullet = createTestBullet({ createdAt: daysAgo(10), feedbackEvents: [] });
      expect(isStale(bullet, 90)).toBe(false);
    });

    it("returns true if last event is old", () => {
      const bullet = createTestBullet({
        feedbackEvents: [feedback("helpful", 100)],
      });
      expect(isStale(bullet, 90)).toBe(true);
    });

    it("returns false if last event is recent", () => {
        const bullet = createTestBullet({
          feedbackEvents: [feedback("helpful", 100), feedback("helpful", 10)],
        });
        expect(isStale(bullet, 90)).toBe(false);
      });
  });

  describe("analyzeScoreDistribution", () => {
    it("correctly buckets bullets based on effective score", () => {
        // Excellent: >= 5
        const excellent = createTestBullet({ feedbackEvents: Array.from({length: 6}, () => feedback("helpful", 0)), maturity: "established" }); 
        // 6 * 1.0 = 6
        
        // Good: 2 <= score < 5
        const good = createTestBullet({ feedbackEvents: Array.from({length: 3}, () => feedback("helpful", 0)), maturity: "established" });
        // 3 * 1.0 = 3
        
        // Neutral: 0 <= score < 2
        const neutral = createTestBullet({ feedbackEvents: [feedback("helpful", 0)], maturity: "established" });
        // 1 * 1.0 = 1
        
        // At Risk: < 0
        const atRisk = createTestBullet({ feedbackEvents: [feedback("harmful", 0)], maturity: "established" });
        // -4 * 1.0 = -4

        const dist = analyzeScoreDistribution([excellent, good, neutral, atRisk], config);
        expect(dist.excellent).toBe(1);
        expect(dist.good).toBe(1);
        expect(dist.neutral).toBe(1);
        expect(dist.atRisk).toBe(1);
    });
  });
});