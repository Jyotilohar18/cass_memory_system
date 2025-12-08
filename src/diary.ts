import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Config, DiaryEntry, RelatedSession, DiaryEntrySchema } from './types.js';
import { extractDiary } from './llm.js';
import { getSanitizeConfig } from './config.js';
import { sanitize } from './security.js';
import { extractAgentFromPath, expandPath, ensureDir, tokenize } from './utils.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ============================================================================
// SEARCH ANCHOR EXTRACTION
// ============================================================================

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
  "take", "took", "come", "came", "way", "well", "back", "even", "still", "while"
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
  
  const sanitizeConfig = getSanitizeConfig(config);
  const sanitizedContent = sanitize(rawContent, sanitizeConfig);
  
  const agent = extractAgentFromPath(sessionPath);
  // Extract workspace name from path (heuristic: parent dir)
  const workspace = path.basename(path.dirname(sessionPath));

  const metadata = { sessionPath, agent, workspace };
  
  // Extract structured data using LLM
  const extracted = await extractDiary(
    ExtractionSchema,
    sanitizedContent, 
    metadata,
    config
  );

  const related = await enrichWithRelatedSessions(sanitizedContent, config);
  
  const diary: DiaryEntry = {
    id: `diary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionPath,
    timestamp: new Date().toISOString(),
    agent,
    workspace,
    status: extracted.status,
    accomplishments: extracted.accomplishments || [],
    decisions: extracted.decisions || [],
    challenges: extracted.challenges || [],
    preferences: extracted.preferences || [],
    keyLearnings: extracted.keyLearnings || [],
    tags: extracted.tags || [],
    searchAnchors: extracted.searchAnchors || [],
    relatedSessions: related
  };
  
  await saveDiaryEntry(diary, config);
  
  return diary;
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

async function enrichWithRelatedSessions(content: string, config: Config): Promise<RelatedSession[]> {
  // Placeholder for cross-agent enrichment
  return []; 
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

// --- Statistics ---

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
