import {
  Config,
  PlaybookBullet,
  FeedbackEvent,
  BulletMaturity
} from "./types.js";

// --- Decay Core ---

export function calculateDecayedValue(
  event: FeedbackEvent,
  now: Date,
  halfLifeDays = 90
): number {
  const eventDate = new Date(event.timestamp);
  const ageMs = now.getTime() - eventDate.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  
  // Exponential decay: value = 1 * (0.5)^(age/halfLife)
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

/**
 * Sum decayed values for a collection of feedback events using the provided half-life.
 */
export function getDecayedScore(
  events: FeedbackEvent[] = [],
  halfLifeDays: number
): number {
  const now = new Date();
  return events.reduce(
    (sum, event) => sum + calculateDecayedValue(event, now, halfLifeDays),
    0
  );
}

export function getDecayedCounts(
  bullet: PlaybookBullet, 
  config: Config
): { decayedHelpful: number; decayedHarmful: number } {
  const halfLife = bullet.confidenceDecayHalfLifeDays ?? config.scoring.decayHalfLifeDays;

  // Use feedbackEvents as the single source of truth
  const allEvents = bullet.feedbackEvents || [];
  
  const decayedHelpful = getDecayedScore(
    allEvents.filter((e) => e.type === "helpful"),
    halfLife
  );

  const decayedHarmful = getDecayedScore(
    allEvents.filter((e) => e.type === "harmful"),
    halfLife
  );

  return { decayedHelpful, decayedHarmful };
}

// --- Effective Score ---

export function getEffectiveScore(
  bullet: PlaybookBullet, 
  config: Config
): number {
  const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
  
  // Key insight: harmful feedback weighs 4x more than helpful
  const rawScore = decayedHelpful - (config.scoring.harmfulMultiplier * decayedHarmful);
  
  // Maturity multiplier
  const maturityMultiplier: Record<BulletMaturity, number> = {
    candidate: 0.5,
    established: 1.0,
    proven: 1.5,
    deprecated: 0
  };

  const multiplier = maturityMultiplier[bullet.maturity] ?? 1.0;
  
  return rawScore * multiplier;
}

// --- Maturity State Machine ---

export function calculateMaturityState(
  bullet: PlaybookBullet, 
  config: Config
): BulletMaturity {
  // If explicitly deprecated, stay deprecated
  if (bullet.maturity === "deprecated" || bullet.deprecated) return "deprecated";

  const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
  const total = decayedHelpful + decayedHarmful;
  const harmfulRatio = total > 0 ? decayedHarmful / total : 0;
  
  // Transitions
  const { minFeedbackForActive, minHelpfulForProven, maxHarmfulRatioForProven } = config.scoring;

  if (harmfulRatio > 0.3 && total > minFeedbackForActive) return "deprecated"; 
  if (total < minFeedbackForActive) return "candidate";                        
  if (decayedHelpful >= minHelpfulForProven && harmfulRatio < maxHarmfulRatioForProven) return "proven";
  
  return "established";
}

// --- Lifecycle Checks ---

export function checkForPromotion(bullet: PlaybookBullet, config: Config): BulletMaturity {
  const current = bullet.maturity;
  if (current === "proven" || current === "deprecated") return current;
  
  const newState = calculateMaturityState(bullet, config);
  
  const isPromotion = 
    (current === "candidate" && (newState === "established" || newState === "proven")) ||
    (current === "established" && newState === "proven");

  return isPromotion ? newState : current;
}

export function checkForDemotion(bullet: PlaybookBullet, config: Config): BulletMaturity | "auto-deprecate" {
  if (bullet.pinned) return bullet.maturity;
  
  const score = getEffectiveScore(bullet, config);
  
  // Severe negative score -> auto-deprecate
  if (score < -config.pruneHarmfulThreshold) {
    return "auto-deprecate";
  }
  
  // Soft demotion
  if (score < 0) {
    if (bullet.maturity === "proven") return "established";
    if (bullet.maturity === "established") return "candidate";
  }
  
  return bullet.maturity;
}

export function isStale(bullet: PlaybookBullet, staleDays = 90): boolean {
  const allEvents = bullet.feedbackEvents;
  if (allEvents.length === 0) {
    return (Date.now() - new Date(bullet.createdAt).getTime()) > (staleDays * 86400000);
  }
  
  const lastTs = Math.max(...allEvents.map(e => new Date(e.timestamp).getTime()));
  return (Date.now() - lastTs) > (staleDays * 86400000);
}

export function analyzeScoreDistribution(bullets: PlaybookBullet[], config: Config) {
  const scores = bullets.map(b => getEffectiveScore(b, config));
  return {
    excellent: scores.filter(s => s > 10).length,
    good: scores.filter(s => s > 5 && s <= 10).length,
    neutral: scores.filter(s => s >= 0 && s <= 5).length,
    atRisk: scores.filter(s => s < 0).length
  };
}