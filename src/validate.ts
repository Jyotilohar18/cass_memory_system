import type {
  Config,
  PlaybookDelta,
  EvidenceGateResult,
  ValidationResult
} from "./types.js";
import { runValidator } from "./llm.js";
import { safeCassSearch } from "./cass.js";
import { extractKeywords, log } from "./utils.js";

// --- Pre-LLM Gate ---

export async function evidenceCountGate(
  content: string,
  config: Config
): Promise<EvidenceGateResult> {
  const keywords = extractKeywords(content);
  // 2. Search cass
  const hits = await safeCassSearch(keywords.join(" "), {
    limit: 20,
    days: config.validationLookbackDays
  }, config.cassPath);

  // 3. Classify outcomes
  let successCount = 0;
  let failureCount = 0;
  const sessions = new Set<string>();

  for (const hit of hits) {
    sessions.add(hit.source_path);
    // Heuristic classification based on snippet text
    // In a real system, we'd look up the actual session diary outcome,
    // but snippet heuristics are a fast proxy.
    const lower = hit.snippet.toLowerCase();
    if (lower.includes("fixed") || lower.includes("success") || lower.includes("solved")) {
      successCount++;
    } else if (lower.includes("failed") || lower.includes("error") || lower.includes("broken")) {
      failureCount++;
    }
  }

  const sessionCount = sessions.size;

  // 4. Gate Logic
  if (sessionCount === 0) {
    return {
      passed: true, // Allow as draft (no evidence to contradict)
      reason: "No historical evidence found. Proposing as draft.",
      suggestedState: "draft",
      sessionCount, successCount, failureCount
    };
  }

  if (successCount >= 5 && failureCount === 0) {
    return {
      passed: true,
      reason: `Strong success signal (${successCount} successes). Auto-accepting.`, 
      suggestedState: "active", // Enough evidence to activate immediately
      sessionCount, successCount, failureCount
    };
  }

  if (failureCount >= 3 && successCount === 0) {
    return {
      passed: false,
      reason: `Strong failure signal (${failureCount} failures). Auto-rejecting.`, 
      suggestedState: "draft", // Irrelevant since passed=false
      sessionCount, successCount, failureCount
    };
  }

  // Ambiguous -> Needs LLM
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
  // Only validate "add" deltas
  if (delta.type !== "add") return { valid: true };
  
  if (!config.validationEnabled) return { valid: true };

  const content = delta.bullet.content || "";
  if (content.length < 20) return { valid: true }; // Too short to validate

  // 1. Run Gate
  const gate = await evidenceCountGate(content, config);
  
  if (!gate.passed) {
    log(`Rule rejected by evidence gate: ${gate.reason}`);
    return { valid: false, gate };
  }

  // If gate suggests "active", we might skip LLM if we trust the heuristic enough.
  // But for V1, let's run LLM if we have sessions but it wasn't a slam dunk "5-0" auto-accept.
  // Wait, the gate returns "active" only on 5-0.
  if (gate.suggestedState === "active") {
    return { 
      valid: true, 
      gate,
      result: {
        valid: true,
        verdict: "ACCEPT",
        confidence: 1.0,
        reason: gate.reason,
        evidence: []
      }
    };
  }

  // 2. Run LLM
  // Re-search for evidence to put in prompt? Or use hits from gate?
  // Gate search was cheap/fast. Let's do a targeted search again or reuse if we refactored.
  // For simplicity, re-search.
  const keywords = extractKeywords(content);
  const evidenceHits = await safeCassSearch(keywords.join(" "), { limit: 10 }, config.cassPath);
  const formattedEvidence = formatEvidence(evidenceHits);

  const result = await runValidator(content, formattedEvidence, config);

  return {
    valid: result.valid,
    result,
    gate
  };
}
