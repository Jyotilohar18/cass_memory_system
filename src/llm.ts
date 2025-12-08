// src/llm.ts
// LLM Provider Abstraction - Using Vercel AI SDK
// Supports OpenAI, Anthropic, and Google providers with a unified interface

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { Config, DiaryEntry } from "./types";

/**
 * Supported LLM provider names
 */
export type LLMProvider = "openai" | "anthropic" | "google";

/**
 * Minimal config interface for LLM operations.
 * Full Config type will be in types.ts once implemented.
 */
export interface LLMConfig {
  provider: LLMProvider;
  model: string;
}

/**
 * Map of provider names to environment variable names
 */
const ENV_VAR_MAP: Record<LLMProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/**
 * Expected key prefixes for format validation
 */
const KEY_PREFIX_MAP: Record<LLMProvider, string> = {
  openai: "sk-",
  anthropic: "sk-ant-",
  google: "AIza", // Google API keys start with AIza
};

/**
 * Get the API key for a provider from environment variables.
 *
 * @param provider - The LLM provider name
 * @returns The API key string
 * @throws Error if provider is unknown or env var is not set
 *
 * @example
 * ```typescript
 * const key = getApiKey("openai");
 * ```
 */
export function getApiKey(provider: string): string {
  const normalized = provider.trim().toLowerCase() as LLMProvider;

  const envVar = ENV_VAR_MAP[normalized];
  if (!envVar) {
    const supported = Object.keys(ENV_VAR_MAP).join(", ");
    throw new Error(
      `Unknown LLM provider '${provider}'. Supported providers: ${supported}.`
    );
  }

  const apiKey = process.env[envVar];
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      `${envVar} environment variable not found. Set it with: export ${envVar}=<your-key>`
    );
  }

  return apiKey.trim();
}

/**
 * Validate API key format (non-blocking, warnings only).
 * Does not make API calls - just checks format patterns.
 *
 * @param provider - The LLM provider name
 * @returns void - logs warnings to stderr if format looks wrong
 *
 * @example
 * ```typescript
 * validateApiKey("openai");
 * // Warning: OpenAI API key does not start with sk- - this may be incorrect
 * ```
 */
export function validateApiKey(provider: string): void {
  const normalized = provider.trim().toLowerCase() as LLMProvider;
  const envVar = ENV_VAR_MAP[normalized];
  if (!envVar) return;

  const apiKey = process.env[envVar];
  if (!apiKey) {
    // getApiKey will handle missing keys - don't duplicate warnings
    return;
  }

  const expectedPrefix = KEY_PREFIX_MAP[normalized];
  if (expectedPrefix && !apiKey.startsWith(expectedPrefix)) {
    console.warn(
      `Warning: ${provider} API key does not start with '${expectedPrefix}' - this may be incorrect`
    );
  }

  // Check for common placeholder patterns
  const placeholders = ["YOUR_API_KEY", "xxx", "test", "demo", "placeholder"];
  const lowerKey = apiKey.toLowerCase();
  for (const placeholder of placeholders) {
    if (lowerKey.includes(placeholder)) {
      console.warn(
        `Warning: ${provider} API key appears to contain a placeholder ('${placeholder}')`
      );
      break;
    }
  }

  // Check minimum length (most keys are 30+ chars)
  if (apiKey.length < 20) {
    console.warn(
      `Warning: ${provider} API key seems too short (${apiKey.length} chars) - this may be incorrect`
    );
  }
}

/**
 * Create a provider-agnostic LanguageModel instance.
 * Uses Vercel AI SDK for unified interface across providers.
 *
 * @param config - Configuration with provider and model name
 * @returns LanguageModel instance for the configured provider/model
 * @throws Error if provider is unknown or API key is not set
 *
 * @example
 * ```typescript
 * const model = getModel({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
 * const { text } = await generateText({ model, prompt: "Hello!" });
 * ```
 */
export function getModel(config: LLMConfig): LanguageModel {
  try {
    const provider = config.provider as "openai" | "anthropic" | "google";
    const apiKey = getApiKey(provider);
    
    switch (provider) {
      case "openai": return createOpenAI({ apiKey })(config.model);
      case "anthropic": return createAnthropic({ apiKey })(config.model);
      case "google": return createGoogleGenerativeAI({ apiKey })(config.model);
      default: throw new Error(`Unsupported provider: ${config.provider}`);
    }
  } catch (err: any) {
    throw err;
  }
}

/**
 * Check if LLM is available (API key exists) without throwing.
 * Useful for graceful degradation.
 *
 * @param provider - The LLM provider to check
 * @returns true if API key is configured
 */
export function isLLMAvailable(provider: LLMProvider): boolean {
  const envVar = ENV_VAR_MAP[provider];
  return !!process.env[envVar];
}

/**
 * Get a list of available (configured) providers.
 *
 * @returns Array of provider names that have API keys set
 */
export function getAvailableProviders(): LLMProvider[] {
  return (Object.keys(ENV_VAR_MAP) as LLMProvider[]).filter((provider) =>
    isLLMAvailable(provider)
  );
}

// --- Prompt Templates ---

/**
 * Prompt templates for LLM operations.
 * These are tuned for structured extraction with Zod schemas.
 */
export const PROMPTS = {
  /**
   * Extract structured diary from a session.
   * Temperature: 0.3 (low for consistency)
   */
  diary: `You are analyzing a coding agent session to extract structured insights.

SESSION METADATA:
- Path: {sessionPath}
- Agent: {agent}
- Workspace: {workspace}

SESSION CONTENT:
{content}

INSTRUCTIONS:
Extract the following from this session. Be SPECIFIC and ACTIONABLE.
Avoid generic statements like "wrote code" or "fixed bug".
Include specific:
- File names and paths
- Function/class/component names
- Error messages and stack traces
- Commands run
- Tools used

If the session lacks information for a field, provide an empty array.

Respond with JSON matching this schema:
{
  "status": "success" | "failure" | "mixed",
  "accomplishments": string[],  // Specific completed tasks with file/function names
  "decisions": string[],        // Design choices with rationale
  "challenges": string[],       // Problems encountered, errors, blockers
  "preferences": string[],      // User style revelations
  "keyLearnings": string[],     // Reusable insights
  "tags": string[],             // Discovery keywords
  "searchAnchors": string[]     // Search phrases for future retrieval
}`,

  /**
   * Extract deltas (changes) from diary for playbook.
   * Multi-iteration capable.
   */
  reflector: `You are analyzing a coding session diary to extract reusable lessons for a playbook.

EXISTING PLAYBOOK RULES:
{existingBullets}

SESSION DIARY:
{diary}

RELEVANT CASS HISTORY:
{cassHistory}

{iterationNote}

INSTRUCTIONS:
Extract playbook deltas (changes) from this session. Each delta should be:
- SPECIFIC: Bad: "Write tests". Good: "For React hooks, test effects separately with renderHook"
- ACTIONABLE: Include concrete examples, file patterns, command flags
- REUSABLE: Would help a DIFFERENT agent on a similar problem

Delta types:
- add: New insight not covered by existing bullets
- helpful: Existing bullet proved useful (reference by ID)
- harmful: Existing bullet caused problems (reference by ID, explain why)
- replace: Existing bullet needs updated wording
- deprecate: Existing bullet is outdated

Maximum 20 deltas per reflection. Focus on quality over quantity.`,

  /**
   * Validate a proposed rule against evidence.
   */
  validator: `You are a scientific validator checking if a proposed rule is supported by historical evidence.

PROPOSED RULE:
{proposedRule}

HISTORICAL EVIDENCE (from cass search):
{evidence}

INSTRUCTIONS:
Analyze whether the evidence supports, contradicts, or is neutral toward the proposed rule.

Consider:
1. How many sessions show success when following this pattern?
2. How many sessions show failure when following this pattern?
3. Are there edge cases or conditions where the rule doesn't apply?
4. Is the rule too broad or too specific?

Respond with:
{
  "valid": boolean,
  "confidence": number,  // 0.0-1.0
  "reason": string,
  "refinedContent": string | null,  // Suggested improvement if partially valid
  "evidence": { supporting: string[], contradicting: string[] }
}`,

  /**
   * Generate pre-task context briefing.
   */
  context: `You are preparing a context briefing for a coding task.

TASK DESCRIPTION:
{task}

RELEVANT PLAYBOOK RULES:
{bullets}

RELEVANT SESSION HISTORY:
{history}

DEPRECATED PATTERNS TO AVOID:
{deprecatedPatterns}

INSTRUCTIONS:
Create a concise briefing that:
1. Summarizes the most relevant rules for this task
2. Highlights any pitfalls or anti-patterns to avoid
3. Suggests relevant cass searches for deeper context
4. Notes any deprecated patterns that might come up

Keep the briefing actionable and under 500 words.`,

  /**
   * Audit a session for rule violations.
   */
  audit: `You are auditing a coding session to check if established rules were followed.

SESSION CONTENT:
{sessionContent}

RULES TO CHECK:
{rulesToCheck}

INSTRUCTIONS:
For each rule, determine if the session:
- FOLLOWED the rule (with evidence)
- VIOLATED the rule (with evidence)
- Rule was NOT APPLICABLE to this session

Respond with:
{
  "results": [
    {
      "ruleId": string,
      "status": "followed" | "violated" | "not_applicable",
      "evidence": string
    }
  ],
  "summary": string
}`,
} as const;

/**
 * Fill prompt template with values.
 *
 * @param template - Prompt template with {placeholders}
 * @param values - Object with placeholder values
 * @returns Filled prompt string
 */
export function fillPrompt(
  template: string,
  values: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return result;
}

/**
 * Truncate content to avoid token limits.
 * Keeps beginning and end, truncates middle.
 *
 * @param content - Content to truncate
 * @param maxChars - Maximum characters (default 50000)
 * @returns Truncated content
 */
export function truncateForPrompt(content: string, maxChars = 50000): string {
  if (content.length <= maxChars) return content;

  const keepChars = Math.floor((maxChars - 100) / 2);
  const beginning = content.slice(0, keepChars);
  const ending = content.slice(-keepChars);

  return `${beginning}\n\n[... ${content.length - maxChars} characters truncated ...]\n\n${ending}`;
}

/**
 * Run the reflector to extract playbook deltas from a diary entry.
 * Used by reflect.ts to generate insights from sessions.
 *
 * @param schema - Zod schema for the expected output
 * @param diary - The diary entry to reflect on
 * @param existingBullets - Formatted string of existing playbook bullets
 * @param cassHistory - Related session history from cass
 * @param iteration - Current iteration number (for multi-pass reflection)
 * @param config - Configuration with LLM settings
 * @returns Parsed output matching the provided schema
 */
export async function extractDiary<T>(
  schema: z.ZodSchema<T>,
  sessionContent: string,
  metadata: { sessionPath: string; agent: string; workspace?: string },
  config: Config
): Promise<T> {
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
  };

  const model = getModel(llmConfig);
  
  const truncatedContent = truncateForPrompt(sessionContent, 50000);

  const prompt = fillPrompt(PROMPTS.diary, {
    sessionPath: metadata.sessionPath,
    agent: metadata.agent,
    workspace: metadata.workspace || "unknown",
    content: truncatedContent
  });

  const { object } = await generateObject({
    model,
    schema,
    prompt,
    temperature: 0.3,
  });

  return object;
}

export async function runReflector<T>(
  schema: z.ZodSchema<T>,
  diary: DiaryEntry,
  existingBullets: string,
  cassHistory: string,
  iteration: number,
  config: Config
): Promise<T> {
  // Build LLM config from Config
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
  };

  const model = getModel(llmConfig);

  // Format diary for prompt
  const diaryText = `
Status: ${diary.status}
Accomplishments: ${diary.accomplishments.join('\n- ')}
Decisions: ${diary.decisions.join('\n- ')}
Challenges: ${diary.challenges.join('\n- ')}
Preferences: ${diary.preferences.join('\n- ')}
Key Learnings: ${diary.keyLearnings.join('\n- ')}
`.trim();

  const iterationNote = iteration > 0
    ? `This is iteration ${iteration + 1}. Focus on insights you may have missed in previous passes.`
    : "";

  const prompt = fillPrompt(PROMPTS.reflector, {
    existingBullets,
    diary: diaryText,
    cassHistory,
    iterationNote,
  });

  const { object } = await generateObject({
    model,
    schema,
    prompt,
    temperature: 0.5,
  });

  return object;
}

/**
 * Validation result from runValidator
 */
export interface ValidatorResult {
  valid: boolean;
  verdict: 'ACCEPT' | 'REJECT' | 'REFINE';
  confidence: number;
  reason: string;
  evidence: Array<{ sessionPath: string; snippet: string; supports: boolean }>;
  suggestedRefinement?: string;
}

// Schema for LLM output
const ValidatorOutputSchema = z.object({
  verdict: z.enum(['ACCEPT', 'REJECT', 'REFINE']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidence: z.array(z.object({
    sessionPath: z.string(),
    snippet: z.string(),
    supports: z.boolean()
  })).default([]),
  suggestedRefinement: z.string().optional()
});

/**
 * Run the validator to assess if a proposed rule is supported by historical evidence.
 * Used by validate.ts to scientifically validate playbook deltas.
 *
 * @param proposedRule - The rule content being validated
 * @param formattedEvidence - Historical evidence from cass formatted as string
 * @param config - Configuration with LLM settings
 * @returns Validation result with verdict and reasoning
 */
export async function runValidator(
  proposedRule: string,
  formattedEvidence: string,
  config: Config
): Promise<ValidatorResult> {
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
  };

  const model = getModel(llmConfig);

  const prompt = fillPrompt(PROMPTS.validator, {
    proposedRule,
    evidence: formattedEvidence
  });

  const { object } = await generateObject({
    model,
    schema: ValidatorOutputSchema,
    prompt,
    temperature: 0.2,
  });

  return {
    valid: object.verdict === 'ACCEPT',
    verdict: object.verdict,
    confidence: object.confidence,
    reason: object.reason,
    evidence: object.evidence,
    suggestedRefinement: object.suggestedRefinement
  };
}

/**
 * Generate context-aware briefing from playbook and history.
 * Used by cm context command for pre-task briefing.
 *
 * @param task - The task description
 * @param bullets - Formatted string of relevant playbook bullets
 * @param history - Related session history from cass
 * @param deprecatedPatterns - Deprecated patterns to warn about
 * @param config - Configuration with LLM settings
 * @returns Formatted briefing text
 */
export async function generateContext(
  task: string,
  bullets: string,
  history: string,
  deprecatedPatterns: string,
  config: Config
): Promise<string> {
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
  };

  const model = getModel(llmConfig);

  const prompt = fillPrompt(PROMPTS.context, {
    task,
    bullets,
    history,
    deprecatedPatterns
  });

  const { object } = await generateObject({
    model,
    schema: z.object({ briefing: z.string() }),
    prompt,
    temperature: 0.3,
  });

  return object.briefing;
}

/**
 * Generate diverse search queries for a task.
 * Used to find relevant prior sessions in cass.
 *
 * @param task - The task description
 * @param config - Configuration with LLM settings
 * @returns Array of search query strings
 */
export async function generateSearchQueries(
  task: string,
  config: Config
): Promise<string[]> {
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
  };

  const model = getModel(llmConfig);

  const prompt = `Given this task: ${task}

Generate 3-5 diverse search queries to find relevant information:
- Similar problems encountered before
- Related frameworks or tools
- Relevant patterns or best practices
- Error messages or debugging approaches

Make queries specific enough to be useful but broad enough to match variations.`;

  const { object } = await generateObject({
    model,
    schema: z.object({ queries: z.array(z.string()).max(5) }),
    prompt,
    temperature: 0.5,
  });

  return object.queries;
}
