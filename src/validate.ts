import {
  Config,
  PlaybookDelta,
  EvidenceGateResult,
  ValidationResult,
  ValidationEvidence
} from "./types.js";
import { runValidator, ValidatorResult } from "./llm.js";
import { safeCassSearch } from "./cass.js";
import { extractKeywords, log } from "./utils.js";

// --- Verdict Normalization ---

/**
 * Normalize LLM validator result to our internal verdict types.
 * Maps REFINE to ACCEPT_WITH_CAUTION with reduced confidence.
 */
export function normalizeValidatorVerdict(result: ValidatorResult): ValidatorResult {
  if (result.verdict === "REFINE") {
    return {
      ...result,
      verdict: "ACCEPT_WITH_CAUTION",
      valid: true,
      confidence: result.confidence * 0.8 // Reduce confidence for refined rules
    };
  }
  return result;
}

// --- Pre-LLM Gate ---

// Word boundary patterns to avoid false positives like "fixed-width" or "error handling worked"
// These patterns match the words as standalone or at phrase boundaries
const SUCCESS_PATTERNS = [
  /\bfixed\s+(the|a|an|this|that|it)\b/i,        // "fixed the bug" but not "fixed-width"
  /\bsuccessfully\b/i,                            // "successfully deployed"
  /\bsuccess\b(?!ful)/i,                          // "success" but not "successful" (needs context)
  /\bsolved\s+(the|a|an|this|that|it)\b/i,       // "solved the issue"
  /\bworking\s+now\b/i,                           // "working now"
  /\bworks\s+(now|correctly|properly)\b/i,       // "works correctly"
  /\bresolved\b/i,                                // "resolved"
];

const FAILURE_PATTERNS = [
  /\bfailed\s+(to|with)\b/i,                      // "failed to compile" but not "failed CI" (could be action)
  /\berror:/i,                                    // "error:" prefix common in logs
  /\b(threw|throws)\s+.*error\b/i,               // "threw an error"
  /\bbroken\b/i,                                  // "broken"
  /\bcrash(ed|es|ing)?\b/i,                       // "crashed", "crashes"
  /\bbug\s+(in|found|caused)\b/i,                // "bug in", "bug found"
  /\bdoesn't\s+work\b/i,                          // "doesn't work"
];

function matchesPatterns(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

export async function evidenceCountGate(
  content: string,
  config: Config
): Promise<EvidenceGateResult> {
  const keywords = extractKeywords(content);
  const hits = await safeCassSearch(keywords.join(" "), {
    limit: 20,
    days: config.validationLookbackDays
  }, config.cassPath);

  let successCount = 0;
  let failureCount = 0;
  const sessions = new Set<string>();

  for (const hit of hits) {
    if (!hit.source_path) continue;
    sessions.add(hit.source_path);

    const snippet = hit.snippet;
    // Use word-boundary aware patterns to reduce false positives
    if (matchesPatterns(snippet, SUCCESS_PATTERNS)) {
      successCount++;
    } else if (matchesPatterns(snippet, FAILURE_PATTERNS)) {
      failureCount++;
    }
  }

  const sessionCount = sessions.size;

  if (sessionCount === 0) {
    return {
      passed: true,
      reason: "No historical evidence found. Proposing as draft.",
      suggestedState: "draft",
      sessionCount, successCount, failureCount
    };
  }

  if (successCount >= 5 && failureCount === 0) {
    return {
      passed: true,
      reason: `Strong success signal (${successCount} successes). Auto-accepting.`,
      suggestedState: "active",
      sessionCount, successCount, failureCount
    };
  }

  if (failureCount >= 3 && successCount === 0) {
    return {
      passed: false,
      reason: `Strong failure signal (${failureCount} failures). Auto-rejecting.`,
      suggestedState: "draft",
      sessionCount, successCount, failureCount
    };
  }

  return {
    passed: true,
    reason: "Evidence found but ambiguous. Proceeding to LLM validation.",
    suggestedState: "draft",
    sessionCount, successCount, failureCount
  };
}

// --- Format Evidence for LLM ---

function formatEvidence(hits: any[]): string {
  return hits.map((h: any) => `
Session: ${h.source_path}
Snippet: "${h.snippet}"
Relevance: ${h.score}
`).join("\n---\n");
}

// --- Main Validator ---

export async function validateDelta(
  delta: PlaybookDelta,
  config: Config
): Promise<{ valid: boolean; result?: ValidationResult; gate?: EvidenceGateResult }> {

  if (delta.type !== "add") return { valid: true };

  if (!config.validationEnabled) return { valid: true };

  const content = delta.bullet.content || "";
  if (content.length < 20) return { valid: true };

  // 1. Run Gate
  const gate = await evidenceCountGate(content, config);

  if (!gate.passed) {
    log(`Rule rejected by evidence gate: ${gate.reason}`);
    return { valid: false, gate };
  }

  if (gate.suggestedState === "active") {
    return {
      valid: true,
      gate,
      result: {
        valid: true,
        verdict: "ACCEPT",
        confidence: 1.0,
        reason: gate.reason,
        evidence: [],
        approved: true,
        supportingEvidence: [],
        contradictingEvidence: []
      }
    };
  }

  // 2. Run LLM
  const keywords = extractKeywords(content);
  const evidenceHits = await safeCassSearch(keywords.join(" "), { limit: 10 }, config.cassPath);
  const formattedEvidence = formatEvidence(evidenceHits);

  const result = await runValidator(content, formattedEvidence, config);

  let finalVerdict = result.verdict as "ACCEPT" | "REJECT" | "ACCEPT_WITH_CAUTION";

  // Fix: Ensure string[] to object array mapping is correct
  // runValidator currently returns object array for evidence but ValidatorResult type might not align perfectly
  // Wait, ValidatorResult interface in llm.ts: evidence: Array<{ sessionPath: string; snippet: string; supports: boolean }>
  // ValidationResult schema in types.ts: evidence: z.array(z.string())
  // There's a type mismatch I introduced in previous fix.
  // Let's stick to the schema in types.ts which says evidence is string array.
  // But llm.ts runValidator returns object array.
  // I need to map it.

  // Map object array to string array for 'evidence' field
  const evidenceStrings = result.evidence.map(e => e.snippet);

  // Map object array to ValidationEvidence[] for supporting/contradicting
  const supporting = result.evidence.filter(e => e.supports).map(e => ({
    sessionPath: e.sessionPath,
    snippet: e.snippet,
    supports: true,
    confidence: 1.0 // Default confidence
  }));

  const contradicting = result.evidence.filter(e => !e.supports).map(e => ({
    sessionPath: e.sessionPath,
    snippet: e.snippet,
    supports: false,
    confidence: 1.0
  }));

  return {
    valid: result.valid,
    result: {
      ...result,
      verdict: finalVerdict,
      evidence: evidenceStrings,
      approved: result.valid,
      supportingEvidence: supporting,
      contradictingEvidence: contradicting
    },
    gate
  };
}
