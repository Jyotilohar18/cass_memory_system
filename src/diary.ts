import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Config, DiaryEntry, RelatedSession, DiaryEntrySchema } from './types.js';
import { extractDiary } from './llm.js';
import { getSanitizeConfig } from './config.js';
import { sanitize } from './security.js';
import { extractAgentFromPath, expandPath, ensureDir, tokenize } from './utils.js';
import { safeCassSearch } from './cass.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ============================================================================//
// SEARCH ANCHOR EXTRACTION//
// ============================================================================//

/**
 * Technical terms that should be prioritized as search anchors.
 * These are common patterns in coding/development contexts.
 */
const TECH_TERM_PATTERNS = [
  // Frameworks & Libraries
  /\b(react|angular|vue|svelte|nextjs|next\.js|nuxt|express|fastify|nestjs|django|flask|rails|spring)\b/gi,
  // Languages
  /\b(typescript|javascript|python|rust|go|golang|java|kotlin|swift|ruby|php|c\+\+|csharp|c#)\b/gi,
  // Tools & Infra
  /\b(docker|kubernetes|k8s|aws|gcp|azure|terraform|ansible|jenkins|github|gitlab|ci\/cd|vercel|netlify)\b/gi,
  // Database & Storage
  /\b(postgres|postgresql|mysql|mongodb|redis|sqlite|dynamodb|elasticsearch|prisma|drizzle|sequelize)\b/gi,
  // Auth & Security
  /\b(jwt|oauth|oauth2|saml|cors|csrf|xss|authentication|authorization|bearer|token)\b/gi,
  // Testing
  /\b(jest|vitest|mocha|pytest|playwright|cypress|selenium|unit\s*test|e2e|integration\s*test)\b/gi,
  // Patterns & Concepts
  /\b(api|rest|graphql|websocket|grpc|microservice|serverless|async\/await|promise|middleware)\b/gi,
  // Error patterns
  /\b(error|exception|bug|fix|debug|timeout|memory\s*leak|stack\s*trace|null\s*pointer)\b/gi,
  // Project specific (for cass-memory)
  /\b(cass|cass-memory|playbook|diary|bullet|delta|reflector|curator|validator|llm|context)\b/gi
];

/**
 * Stop words specific to search anchor extraction.
 * These are common in diary entries but not useful as search anchors.
 */
const ANCHOR_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "can", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before",
  "after", "and", "or", "but", "if", "when", "where", "why", "how", "this", "that",
  "these", "those", "what", "which", "who", "there", "here", "i", "you", "he", "she",
  "it", "we", "they", "me", "him", "her", "us", "them", "my", "your", "our", "their",
  "some", "any", "all", "most", "other", "such", "only", "same", "so", "than", "too",
  "very", "just", "also", "now", "then", "up", "down", "out", "about", "more", "less",
  "new", "old", "first", "last", "long", "great", "little", "own", "good", "bad",
  "get", "got", "make", "made", "need", "needed", "use", "used", "using", "work",
  "worked", "working", "try", "tried", "trying", "want", "wanted", "think", "thought",
  "know", "knew", "see", "saw", "look", "looked", "find", "found", "give", "gave",
  "take", "took", "come", "came", "way", "well", "back", "even", "still", "while",
  "create", "created", "update", "updated", "delete", "deleted", "remove", "removed",
  "add", "added", "fix", "fixed", "change", "changed", "run", "ran", "start", "started"
]);

/**
 * Interface for diary extraction fields used for search anchor generation.
 */
export interface DiaryExtraction {
  accomplishments?: string[];
  decisions?: string[];
  challenges?: string[];
  keyLearnings?: string[];
  preferences?: string[];
  tags?: string[];
}

/**
 * Extract search anchors from diary fields.
 * "SEO for agents" - terms optimized for future search.
 *
 * @param diary - Extracted diary fields
 * @returns Array of 10-15 search anchor terms
 */
export function extractSearchAnchors(diary: DiaryExtraction): string[] {
  // Combine all text from diary fields
  const allTexts: string[] = [
    ...(diary.accomplishments || []),
    ...(diary.decisions || []),
    ...(diary.challenges || []),
    ...(diary.keyLearnings || []),
    ...(diary.preferences || []),
  ];

  const combinedText = allTexts.join(" ");
  if (!combinedText.trim()) {
    return diary.tags?.slice(0, 15) || [];
  }

  const anchorScores = new Map<string, number>();

  // 1. Extract technical terms using patterns (high priority)
  for (const pattern of TECH_TERM_PATTERNS) {
    const matches = combinedText.match(pattern) || [];
    for (const match of matches) {
      const normalized = match.toLowerCase().replace(/\s+/g, " ").trim();
      if (normalized.length >= 2) {
        anchorScores.set(normalized, (anchorScores.get(normalized) || 0) + 5);
      }
    }
  }

  // 2. Extract capitalized terms (likely proper nouns / tech names)
  const capitalizedPattern = /\b[A-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+\b/g; // CamelCase
  const capsMatches = combinedText.match(capitalizedPattern) || [];
  for (const match of capsMatches) {
    if (match.length >= 3 && !ANCHOR_STOP_WORDS.has(match.toLowerCase())) {
      anchorScores.set(match, (anchorScores.get(match) || 0) + 3);
    }
  }

  // 3. Extract version numbers (e.g., "React 18", "Node 20", "v2.1.0")
  const versionPattern = /\b[a-zA-Z]+\s*(?:v?\d+(?:\.\d+)*)\b/gi;
  const versionMatches = combinedText.match(versionPattern) || [];
  for (const match of versionMatches) {
    const normalized = match.trim();
    if (normalized.length >= 3) {
      anchorScores.set(normalized, (anchorScores.get(normalized) || 0) + 4);
    }
  }

  // 4. Extract file patterns (e.g., "*.ts", "config.yaml", "package.json")
  const filePattern = /\b[\w.-]+\.(ts|tsx|js|jsx|py|rs|go|json|yaml|yml|md|css|scss|html)\b/gi;
  const fileMatches = combinedText.match(filePattern) || [];
  for (const match of fileMatches) {
    anchorScores.set(match, (anchorScores.get(match) || 0) + 2);
  }

  // 5. Extract multi-word technical phrases (2-3 words with technical terms)
  const phrasePattern = /\b(?:[A-Za-z]+\s+){1,2}(?:error|bug|fix|issue|config|setting|option|function|method|class|component|hook|service|controller|model|schema|type|interface|api|endpoint|route|middleware)\b/gi;
  const phraseMatches = combinedText.match(phrasePattern) || [];
  for (const match of phraseMatches) {
    const normalized = match.toLowerCase().trim();
    if (normalized.length >= 5 && !ANCHOR_STOP_WORDS.has(normalized)) {
      anchorScores.set(normalized, (anchorScores.get(normalized) || 0) + 2);
    }
  }

  // 6. Add frequency-based keywords from tokenization
  const tokens = tokenize(combinedText);
  const tokenCounts = new Map<string, number>();
  for (const token of tokens) {
    if (token.length >= 3 && !ANCHOR_STOP_WORDS.has(token)) {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }
  }

  // Add tokens that appear multiple times
  for (const [token, count] of tokenCounts) {
    if (count >= 2) {
      const existing = anchorScores.get(token) || 0;
      anchorScores.set(token, existing + count);
    }
  }

  // 7. Include tags as anchors (if provided)
  for (const tag of diary.tags || []) {
    const normalized = tag.toLowerCase().trim();
    if (normalized.length >= 2) {
      anchorScores.set(normalized, (anchorScores.get(normalized) || 0) + 4);
    }
  }

  // Sort by score and take top 15
  const sortedAnchors = Array.from(anchorScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([anchor]) => anchor);

  // Deduplicate similar anchors (e.g., "react" and "React")
  const seen = new Set<string>();
  const uniqueAnchors: string[] = [];

  for (const anchor of sortedAnchors) {
    const normalized = anchor.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniqueAnchors.push(anchor);
    }
    if (uniqueAnchors.length >= 15) break;
  }

  return uniqueAnchors;
}

const execFileAsync = promisify(execFile);

// Subset of schema for LLM extraction (omits relatedSessions which we do separately)
const ExtractionSchema = DiaryEntrySchema.pick({
  status: true,
  accomplishments: true,
  decisions: true,
  challenges: true,
  preferences: true,
  keyLearnings: true,
  tags: true,
  searchAnchors: true
});

export async function generateDiary(sessionPath: string, config: Config): Promise<DiaryEntry> {
  const rawContent = await exportSessionSafe(sessionPath, config.cassPath);
  
  // Use helper to get compiled regex patterns
  const sanitizeConfig = getSanitizeConfig(config);
  const sanitizedContent = sanitize(rawContent, sanitizeConfig);
  
  const agent = extractAgentFromPath(sessionPath);
  const workspace = path.basename(path.dirname(sessionPath));

  const metadata = { sessionPath, agent, workspace };

  // Use LLM if API key is available
  const useLLM = Boolean(config.apiKey);

  let rawExtracted: Partial<z.infer<typeof ExtractionSchema>>;

  if (useLLM) {
    try {
      rawExtracted = await extractDiary(
        ExtractionSchema,
        sanitizedContent,
        metadata,
        config
      );
    } catch (e) {
      // Fallback to basic extraction if LLM fails
      console.warn(`LLM extraction failed, falling back to basic: ${e}`);
      rawExtracted = extractDiaryBasic(sanitizedContent);
    }
  } else {
    rawExtracted = extractDiaryBasic(sanitizedContent);
  }

  // Normalize arrays to ensure they're never undefined
  const extracted = {
    status: rawExtracted.status ?? "mixed",
    tags: rawExtracted.tags ?? [],
    accomplishments: rawExtracted.accomplishments ?? [],
    decisions: rawExtracted.decisions ?? [],
    challenges: rawExtracted.challenges ?? [],
    preferences: rawExtracted.preferences ?? [],
    keyLearnings: rawExtracted.keyLearnings ?? [],
    searchAnchors: rawExtracted.searchAnchors ?? []
  };

  const related = await enrichWithRelatedSessions(sanitizedContent, config);
  
  const diary: DiaryEntry = {
    id: `diary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionPath,
    timestamp: new Date().toISOString(),
    agent,
    workspace,
    status: extracted.status,
    accomplishments: extracted.accomplishments,
    decisions: extracted.decisions,
    challenges: extracted.challenges,
    preferences: extracted.preferences,
    keyLearnings: extracted.keyLearnings,
    tags: extracted.tags,
    searchAnchors: extracted.searchAnchors,
    relatedSessions: related
  };
  
  await saveDiaryEntry(diary, config);
  
  return diary;
}

function extractDiaryBasic(content: string): z.infer<typeof ExtractionSchema> {
  return {
    status: "mixed",
    accomplishments: [],
    decisions: [],
    challenges: [],
    preferences: [],
    keyLearnings: [],
    tags: ["no-llm"],
    searchAnchors: extractKeywordsFromContent(content)
  } as z.infer<typeof ExtractionSchema>;
}

async function exportSessionSafe(sessionPath: string, cassPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cassPath, ['export', sessionPath, '--format', 'markdown'], {
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    throw new Error(`Failed to export session: ${error}`);
  }
}

// ============================================================================//
// RAW SESSION FORMATTING//
// ============================================================================//

/**
 * Format raw session files when cass export is unavailable.
 * Converts various session formats to human-readable markdown.
 *
 * @param content - Raw session file content
 * @param ext - File extension (with or without leading dot)
 * @returns Human-readable formatted string
 *
 * @example
 * // JSONL input (single message)
 * const formatted = formatRawSession('{"role":"user","content":"Hello"}', '.jsonl');
 * // Returns: "**user**: Hello"
 *
 * @example
 * // JSON input (multiple messages separated by blank lines)
 * const formatted = formatRawSession('{"messages":[{"role":"user","content":"Hi"},{"role":"assistant","content":"Hello!"}]}', '.json');
 * // Returns: "**user**: Hi\n\n**assistant**: Hello!"
 */
export function formatRawSession(content: string, ext: string): string {
  // Normalize extension (handle with or without leading dot)
  const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;

  switch (normalizedExt) {
    case '.md':
    case '.markdown':
      // Markdown: return as-is (already human-readable)
      return content;

    case '.jsonl':
      // JSONL: parse each line as JSON, format as conversation
      return formatJsonlSession(content);

    case '.json':
      // JSON: parse as single object with messages array
      return formatJsonSession(content);

    default:
      // Unsupported format: return with warning header
      return `<!-- WARNING: Unsupported session format (${normalizedExt}). Raw content follows. -->\n\n${content}`;
  }
}

/**
 * Format a JSONL session file.
 * Each line is expected to be: { role: string, content: string }
 */
function formatJsonlSession(content: string): string {
  const lines = content.split('\n').filter(line => line.trim());
  const formatted: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const parsed = JSON.parse(line);
      const role = parsed.role ?? '[unknown]';
      const messageContent = parsed.content ?? '[empty]';
      formatted.push(`**${role}**: ${messageContent}`);
    } catch {
      // Invalid JSON line: include with parse error marker
      formatted.push(`[PARSE ERROR] ${line}`);
    }
  }

  return formatted.join('\n\n');
}

/**
 * Format a JSON session file.
 * Expected schema: { messages: Array<{ role: string, content: string }> }
 * Also handles variations like { conversation: [...] } or direct array
 */
function formatJsonSession(content: string): string {
  try {
    const parsed = JSON.parse(content);

    // Handle different JSON structures
    let messages: Array<{ role?: string; content?: string }>;

    if (Array.isArray(parsed)) {
      // Direct array of messages
      messages = parsed;
    } else if (Array.isArray(parsed.messages)) {
      // Standard { messages: [...] } format
      messages = parsed.messages;
    } else if (Array.isArray(parsed.conversation)) {
      // Alternative { conversation: [...] } format
      messages = parsed.conversation;
    } else if (Array.isArray(parsed.turns)) {
      // Alternative { turns: [...] } format (used by some agents)
      messages = parsed.turns;
    } else {
      // Unknown structure: return with warning
      return `<!-- WARNING: Unrecognized JSON structure. Expected {messages: [...]} or array. -->\n\n${content}`;
    }

    const formatted: string[] = [];

    for (const msg of messages) {
      const role = msg.role ?? '[unknown]';
      const messageContent = msg.content ?? '[empty]';
      formatted.push(`**${role}**: ${messageContent}`);
    }

    return formatted.join('\n\n');
  } catch (err) {
    // JSON parse error: return with error message
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `[PARSE ERROR: ${errorMsg}]\n\n${content}`;
  }
}

/**
 * Enrich diary with related sessions from other agents for cross-agent learning.
 *
 * Process:
 * 1. Extract keywords from content using tokenization
 * 2. Query cass for related sessions using keywords
 * 3. Filter out sessions from same source path
 * 4. Score each result by relevance
 * 5. Return top N most relevant sessions
 *
 * @param content - Session content to find related sessions for
 * @param config - Configuration including cass settings
 * @param currentSessionPath - Optional path to exclude from results
 * @returns Array of related sessions with relevance scores
 */
async function enrichWithRelatedSessions(
  content: string,
  config: Config,
  currentSessionPath?: string
): Promise<RelatedSession[]> {
  // Extract keywords from content
  const keywords = extractKeywordsFromContent(content);

  if (keywords.length === 0) {
    return [];
  }

  // Build search query from top keywords (limit to avoid overly complex queries)
  const searchQuery = keywords.slice(0, 8).join(" OR ");

  try {
    // Search for related sessions
    // Use relatedSessionsDays (not sessionLookbackDays) for cross-agent lookback
    const hits = await safeCassSearch(searchQuery, {
      limit: (config.maxRelatedSessions ?? 5) * 4, // Get more than we need for filtering
      days: config.relatedSessionsDays ?? 30,
    }, config.cassPath);

    if (hits.length === 0) {
      return [];
    }

    // Filter and score results
    const scoredHits = hits
      .filter(hit => {
        // Exclude current session
        if (currentSessionPath && hit.source_path === currentSessionPath) {
          return false;
        }
        return true;
      })
      .map(hit => {
        // Calculate relevance score
        const score = calculateRelevanceScore(hit, keywords);
        return { hit, score };
      })
      // Filter by minimum relevance score from config
      .filter(({ score }) => score >= (config.minRelevanceScore ?? 0.1))
      .sort((a, b) => b.score - a.score)
      .slice(0, config.maxRelatedSessions ?? 5);

    // Convert to RelatedSession format
    return scoredHits.map(({ hit, score }): RelatedSession => ({
      sessionPath: hit.source_path,
      agent: hit.agent || extractAgentFromPath(hit.source_path),
      relevanceScore: Math.round(score * 100) / 100, // Round to 2 decimals
      snippet: truncateSnippet(hit.snippet, 200)
    }));

  } catch (err) {
    // Don't fail diary generation if cross-agent search fails
    console.warn(`[enrichWithRelatedSessions] Search failed: ${err}`);
    return [];
  }
}

/**
 * Extract meaningful keywords from content for search.
 * Focuses on technical terms and unique identifiers.
 */
function extractKeywordsFromContent(content: string): string[] {
  const tokens = tokenize(content);

  // Count token frequency
  const frequency = new Map<string, number>();
  for (const token of tokens) {
    // Skip very short or very long tokens
    if (token.length < 3 || token.length > 40) continue;
    // Skip pure numbers
    if (/^\d+$/.test(token)) continue;

    frequency.set(token, (frequency.get(token) || 0) + 1);
  }

  // Prioritize tokens that appear multiple times but aren't too common
  const scored = Array.from(frequency.entries())
    .filter(([_, count]) => count >= 2 && count <= 20)
    .map(([token, count]) => ({
      token,
      // Score: frequency weighted by technical patterns
      score: count * (isTechnicalTerm(token) ? 2 : 1)
    }))
    .sort((a, b) => b.score - a.score);

  return scored.map(s => s.token).slice(0, 15);
}

/**
 * Check if a token looks like a technical term.
 */
function isTechnicalTerm(token: string): boolean {
  // CamelCase or PascalCase
  if (/^[a-z]+[A-Z]/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token)) return true;
  // Contains underscore (likely code identifier)
  if (token.includes('_')) return true;
  // File extensions
  if (/\.(ts|js|py|go|rs|json|yaml|md)$/i.test(token)) return true;
  // Common tech patterns
  if (/^(api|http|sql|css|html|dom|npm|git|cli|sdk|jwt|auth)/i.test(token)) return true;

  return false;
}

/**
 * Calculate relevance score for a search hit.
 */
function calculateRelevanceScore(
  hit: { snippet: string; score?: number; agent?: string },
  keywords: string[]
): number {
  let score = hit.score ?? 0.5; // Base score from cass

  // Boost for keyword matches in snippet
  const hitSnippetLower = hit.snippet.toLowerCase();
  let keywordMatches = 0;
  for (const keyword of keywords) {
    if (hitSnippetLower.includes(keyword.toLowerCase())) {
      keywordMatches++;
    }
  }
  score += (keywordMatches / keywords.length) * 0.3;

  // Small diversity bonus for different agent types
  if (hit.agent && !['unknown', 'other'].includes(hit.agent)) {
    score += 0.05;
  }

  return Math.min(score, 1.0);
}

/**
 * Truncate snippet to max length, preserving word boundaries.
 */
function truncateSnippet(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  // Find last space before maxLength
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace) + '...';
  }
  return truncated + '...';
}

async function saveDiaryEntry(entry: DiaryEntry, config: Config): Promise<void> {
  if (!config.diaryDir) return;

  // Atomic write
  const filename = `${entry.id}.json`;
  const diaryDir = expandPath(config.diaryDir);
  const filePath = path.join(diaryDir, filename);
  const tempPath = `${filePath}.tmp`;

  await ensureDir(diaryDir);

  try {
    await fs.writeFile(tempPath, JSON.stringify(entry, null, 2));
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try { await fs.unlink(tempPath); } catch {}
    throw error;
  }
}

// ============================================================================//
// DIARY LOADING//
// ============================================================================//

/**
 * Custom error types for diary loading operations
 */
export class DiaryLoadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly errorType: "file_not_found" | "json_parse" | "schema_validation" | "unknown" = "unknown"
  ) {
    super(message);
    this.name = "DiaryLoadError";
  }
}

/**
 * Load and validate a diary entry from disk.
 *
 * Process:
 * 1. Verify file exists at diaryPath
 * 2. Read file contents as UTF-8 string
 * 3. Parse JSON string to object
 * 4. Validate against DiaryEntrySchema using Zod
 * 5. Return validated DiaryEntry
 *
 * @param diaryPath - Absolute path to the diary JSON file
 * @returns Validated DiaryEntry object
 * @throws DiaryLoadError with specific error types for debugging
 *
 * @example
 * try {
 *   const diary = await loadDiaryEntry("/path/to/diary-123.json");
 *   console.log(diary.status, diary.accomplishments);
 * } catch (err) {
 *   if (err instanceof DiaryLoadError) {
 *     console.error(`Load failed (${err.errorType}): ${err.message}`);
 *   }
 * }
 */
export async function loadDiaryEntry(diaryPath: string): Promise<DiaryEntry> {
  const expanded = expandPath(diaryPath);

  // 1. Check if file exists
  try {
    await fs.access(expanded);
  } catch (err) {
    throw new DiaryLoadError(
      `Diary file not found: ${expanded}`,
      err,
      "file_not_found"
    );
  }

  // 2. Read file contents
  let content: string;
  try {
    content = await fs.readFile(expanded, "utf-8");
  } catch (err) {
    throw new DiaryLoadError(
      `Failed to read diary file: ${expanded}`,
      err,
      "unknown"
    );
  }

  // 3. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new DiaryLoadError(
      `Invalid JSON in diary file: ${expanded}`,
      err,
      "json_parse"
    );
  }

  // 4. Validate against schema
  const result = DiaryEntrySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new DiaryLoadError(
      `Schema validation failed for ${expanded}:\n${issues}`,
      result.error,
      "schema_validation"
    );
  }

  // 5. Apply migration for old schema versions if needed
  const diary = migrateOldDiary(result.data);

  return diary;
}

/**
 * Migrate old diary format to current schema.
 * Adds default values for new fields to maintain backward compatibility.
 *
 * @param diary - Parsed diary entry
 * @returns Migrated diary entry with all current fields
 */
function migrateOldDiary(diary: DiaryEntry): DiaryEntry {
  // Ensure all arrays exist (older versions might be missing some)
  return {
    ...diary,
    accomplishments: diary.accomplishments ?? [],
    decisions: diary.decisions ?? [],
    challenges: diary.challenges ?? [],
    preferences: diary.preferences ?? [],
    keyLearnings: diary.keyLearnings ?? [],
    tags: diary.tags ?? [],
    searchAnchors: diary.searchAnchors ?? [],
    relatedSessions: diary.relatedSessions ?? [],
  };
}

/**
 * Load all diary entries from a directory.
 *
 * @param diaryDir - Directory containing diary JSON files
 * @returns Array of validated DiaryEntry objects (skips invalid files)
 *
 * @example
 * const diaries = await loadAllDiaries("~/.cass-memory/diary");
 * const stats = computeDiaryStats(diaries);
 */
export async function loadAllDiaries(diaryDir: string): Promise<DiaryEntry[]> {
  const expanded = expandPath(diaryDir);

  // Check if directory exists
  try {
    await fs.access(expanded);
  } catch {
    return []; // Directory doesn't exist, return empty
  }

  const files = await fs.readdir(expanded);
  const diaries: DiaryEntry[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const diary = await loadDiaryEntry(path.join(expanded, file));
      diaries.push(diary);
    } catch (err) {
      // Log but don't throw - skip invalid diary files
      console.warn(`Skipping invalid diary file ${file}: ${err}`);
    }
  }

  // Sort by timestamp (newest first)
  diaries.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return diaries;
}

/**
 * Find a diary entry by session path.
 *
 * @param diaryDir - Directory containing diary JSON files
 * @param sessionPath - Session path to search for
 * @returns DiaryEntry if found, undefined otherwise
 */
export async function findDiaryBySession(
  diaryDir: string,
  sessionPath: string
): Promise<DiaryEntry | undefined> {
  const diaries = await loadAllDiaries(diaryDir);
  return diaries.find(d => d.sessionPath === sessionPath);
}

/**
 * List diary entries from the past N days.
 * Useful for stats, recent activity summaries, and trend analysis.
 *
 * @param diaryDir - Directory containing diary JSON files
 * @param days - Number of days to look back (default: 7)
 * @returns Array of DiaryEntry objects sorted by timestamp (newest first)
 *
 * @example
 * // Get last week's diaries
 * const recent = await listRecentDiaries("~/.cass-memory/diary", 7);
 * console.log(`${recent.length} diaries in the past week`);
 *
 * @example
 * // Get last 30 days for monthly summary
 * const monthly = await listRecentDiaries(config.diaryDir, 30);
 */
export async function listRecentDiaries(
  diaryDir: string,
  days: number = 7
): Promise<DiaryEntry[]> {
  // Load all diaries (already sorted by timestamp)
  const allDiaries = await loadAllDiaries(diaryDir);

  // Calculate cutoff date
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  // Filter to only recent diaries
  return allDiaries.filter(diary => {
    const diaryDate = new Date(diary.timestamp);
    return diaryDate >= cutoffDate;
  });
}

// --- Safe Extraction Wrapper ---//

/**
 * Session metadata for diary extraction.
 */
export interface SessionMetadata {
  sessionPath: string;
  agent: string;
  workspace?: string;
}

/**
 * Safe wrapper around diary extraction with graceful fallback on failure.
 * Philosophy: A minimal diary is better than no diary. Failed extractions are
 * marked clearly but don't break the pipeline.
 *
 * @param sessionContent - Raw session content (sanitized)
 * @param metadata - Session metadata (path, agent, workspace)
 * @param config - Configuration including LLM settings
 * @returns DiaryEntry - either full extraction or minimal fallback
 *
 * @example
 * const diary = await extractDiarySafe(content, { sessionPath, agent, workspace }, config);
 * // Always returns valid DiaryEntry, even on LLM failure
 */
export async function extractDiarySafe(
  sessionContent: string,
  metadata: SessionMetadata,
  config: Config
): Promise<DiaryEntry> {
  const now = new Date().toISOString();
  const baseEntry: Partial<DiaryEntry> = {
    id: `diary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionPath: metadata.sessionPath,
    timestamp: now,
    agent: metadata.agent,
    workspace: metadata.workspace || path.basename(path.dirname(metadata.sessionPath)),
  };

  try {
    // Attempt full extraction
    const extracted = await extractDiary(
      ExtractionSchema,
      sessionContent,
      metadata,
      config
    );

    // Generate search anchors from extracted content if not provided
    const searchAnchors =
      (extracted.searchAnchors && extracted.searchAnchors.length > 0)
        ? extracted.searchAnchors
        : extractSearchAnchors(extracted);

    // Enrich with related sessions
    const relatedSessions = await enrichWithRelatedSessions(sessionContent, config);

    return {
      ...baseEntry,
      status: extracted.status || "mixed",
      accomplishments: extracted.accomplishments || [],
      decisions: extracted.decisions || [],
      challenges: extracted.challenges || [],
      preferences: extracted.preferences || [],
      keyLearnings: extracted.keyLearnings || [],
      tags: extracted.tags || [],
      searchAnchors,
      relatedSessions,
    } as DiaryEntry;
  } catch (error) {
    // Return minimal fallback diary
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      ...baseEntry,
      status: "mixed",
      accomplishments: ["[Extraction failed - see raw session]"],
      decisions: [],
      challenges: [`Diary extraction error: ${errorMessage}`],
      preferences: [],
      keyLearnings: [],
      tags: ["extraction-failure"],
      searchAnchors: ["extraction-failure", metadata.agent],
      relatedSessions: [],
    } as DiaryEntry;
  }
}

/**
 * Extract diary fields with per-field fallbacks.
 * Individual field failures don't crash the whole extraction.
 *
 * @param sessionContent - Raw session content
 * @param metadata - Session metadata
 * @param config - Configuration
 * @returns Partial diary fields with defaults for failed extractions
 */
export async function extractDiaryFields(
  sessionContent: string,
  metadata: SessionMetadata,
  config: Config
): Promise<z.infer<typeof ExtractionSchema>> {
  // This delegates to the LLM extraction but could be extended
  // to have per-field fallbacks in the future
  const result = await extractDiary(ExtractionSchema, sessionContent, metadata, config);
  return result as z.infer<typeof ExtractionSchema>;
}

// --- Statistics ---//

export function computeDiaryStats(diaries: DiaryEntry[]): {
  total: number;
  byStatus: Record<string, number>;
  byAgent: Record<string, number>;
  avgChallenges: number;
  avgLearnings: number;
  topTags: Array<{ tag: string; count: number }>;
  successRate: number;
} {
  const byStatus: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};

  let totalChallenges = 0;
  let totalLearnings = 0;
  let successCount = 0;

  for (const diary of diaries) {
    byStatus[diary.status] = (byStatus[diary.status] || 0) + 1;
    byAgent[diary.agent] = (byAgent[diary.agent] || 0) + 1;

    totalChallenges += diary.challenges?.length ?? 0;
    totalLearnings += diary.keyLearnings?.length ?? 0;

    if (diary.status === "success") successCount++;

    for (const tag of diary.tags ?? []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  const total = diaries.length;
  const avgChallenges = total === 0 ? 0 : totalChallenges / total;
  const avgLearnings = total === 0 ? 0 : totalLearnings / total;
  const successRate = total === 0 ? 0 : (successCount / total) * 100;

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  return {
    total,
    byStatus,
    byAgent,
    avgChallenges,
    avgLearnings,
    topTags,
    successRate,
  };
}
