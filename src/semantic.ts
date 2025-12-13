import fs from "node:fs/promises";
import path from "node:path";
import {
  EmbeddingCache,
  EmbeddingCacheSchema,
  Playbook,
  PlaybookBullet,
} from "./types.js";
import { atomicWrite, hashContent, resolveGlobalDir, warn } from "./utils.js";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_CACHE_VERSION = "1.0";

let embedderPromise: Promise<any> | null = null;
let embedderModel: string | null = null;

async function loadEmbedder(model: string): Promise<any> {
  const { pipeline } = await import("@xenova/transformers");
  return pipeline("feature-extraction", model);
}

export async function getEmbedder(model = DEFAULT_EMBEDDING_MODEL): Promise<any> {
  if (embedderPromise && embedderModel === model) return embedderPromise;

  embedderModel = model;
  embedderPromise = loadEmbedder(model);

  // If the model load fails, allow retry on the next call.
  embedderPromise.catch(() => {
    embedderPromise = null;
    embedderModel = null;
  });

  return embedderPromise;
}

export async function embedText(
  text: string,
  options: { model?: string } = {}
): Promise<number[]> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  if (model === "none") return [];
  const cleaned = text?.trim();
  if (!cleaned) return [];

  const embedder = await getEmbedder(model);
  const result: any = await embedder(cleaned, { pooling: "mean", normalize: true });

  const data: any = result?.data;
  if (!data || typeof data.length !== "number") {
    throw new Error("Unexpected embedder output (missing data)");
  }

  return Array.from(data) as number[];
}

export async function batchEmbed(
  texts: string[],
  batchSize = 32,
  options: { model?: string } = {}
): Promise<number[][]> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  if (model === "none") return texts.map(() => []);

  const safeBatchSize =
    Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 32;

  const cleaned = texts.map((t) => (typeof t === "string" ? t.trim() : ""));
  const output: number[][] = cleaned.map((t) => (t ? null : [])) as any;

  const embedder = await getEmbedder(model);

  // Batch only the non-empty strings, but preserve indices in the output.
  const nonEmpty: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i];
    if (t) nonEmpty.push({ index: i, text: t });
  }

  for (let start = 0; start < nonEmpty.length; start += safeBatchSize) {
    const batch = nonEmpty.slice(start, start + safeBatchSize);
    const batchTexts = batch.map((b) => b.text);

    const result: any = await embedder(batchTexts, { pooling: "mean", normalize: true });

    const data: any = result?.data;
    const dims: any = result?.dims;
    const batchCount = Array.isArray(dims) && typeof dims[0] === "number" ? dims[0] : null;
    const dim = Array.isArray(dims) && typeof dims[1] === "number" ? dims[1] : null;

    if (!data || typeof data.length !== "number" || !batchCount || !dim) {
      throw new Error("Unexpected embedder output (missing data/dims)");
    }
    if (batchCount !== batchTexts.length) {
      throw new Error(`Unexpected embedder output (batch mismatch: got ${batchCount}, expected ${batchTexts.length})`);
    }

    for (let i = 0; i < batchCount; i++) {
      const startIdx = i * dim;
      const endIdx = startIdx + dim;
      const vec = Array.from(data.subarray ? data.subarray(startIdx, endIdx) : data.slice(startIdx, endIdx)) as number[];
      output[batch[i].index] = vec;
    }
  }

  return output as number[][];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length) return 0;
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function getEmbeddingCachePath(): string {
  return path.join(resolveGlobalDir(), "embeddings", "bullets.json");
}

export function createEmptyEmbeddingCache(model = DEFAULT_EMBEDDING_MODEL): EmbeddingCache {
  return { version: EMBEDDING_CACHE_VERSION, model, bullets: {} };
}

export async function loadEmbeddingCache(
  options: { cachePath?: string; model?: string } = {}
): Promise<EmbeddingCache> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const cachePath = options.cachePath || getEmbeddingCachePath();

  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw);

    const result = EmbeddingCacheSchema.safeParse(parsed);
    if (!result.success) {
      warn(`[semantic] Invalid embedding cache; ignoring (${cachePath})`);
      return createEmptyEmbeddingCache(model);
    }

    const cache = result.data;
    if (cache.model !== model || cache.version !== EMBEDDING_CACHE_VERSION) {
      return createEmptyEmbeddingCache(model);
    }

    return cache;
  } catch (err: any) {
    if (err?.code && err.code !== "ENOENT") {
      warn(`[semantic] Failed to load embedding cache (${cachePath}): ${err.message}`);
    }
    return createEmptyEmbeddingCache(model);
  }
}

export async function saveEmbeddingCache(
  cache: EmbeddingCache,
  options: { cachePath?: string } = {}
): Promise<void> {
  const cachePath = options.cachePath || getEmbeddingCachePath();
  try {
    await atomicWrite(cachePath, JSON.stringify(cache, null, 2));
  } catch (err: any) {
    warn(`[semantic] Failed to save embedding cache (${cachePath}): ${err.message}`);
  }
}

export interface EmbeddingStats {
  reused: number;
  computed: number;
  skipped: number;
}

export async function loadOrComputeEmbeddingsForBullets(
  bullets: PlaybookBullet[],
  options: { model?: string; cachePath?: string } = {}
): Promise<{ cache: EmbeddingCache; stats: EmbeddingStats }> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const cachePath = options.cachePath || getEmbeddingCachePath();

  const cache = await loadEmbeddingCache({ cachePath, model });

  let reused = 0;
  let computed = 0;
  let skipped = 0;

  const toCompute: Array<{ bullet: PlaybookBullet; contentHash: string }> = [];

  for (const bullet of bullets) {
    if (!bullet?.id || !bullet?.content) {
      skipped++;
      continue;
    }

    const contentHash = hashContent(bullet.content);
    const cached = cache.bullets[bullet.id];

    if (
      cached?.contentHash === contentHash &&
      Array.isArray(cached.embedding) &&
      cached.embedding.length > 0
    ) {
      bullet.embedding = cached.embedding;
      reused++;
      continue;
    }

    toCompute.push({ bullet, contentHash });
  }

  if (model !== "none" && toCompute.length > 0) {
    try {
      const embeddings = await batchEmbed(
        toCompute.map((x) => x.bullet.content),
        32,
        { model }
      );

      for (let i = 0; i < toCompute.length; i++) {
        const { bullet, contentHash } = toCompute[i];
        const embedding = embeddings[i] || [];

        if (!Array.isArray(embedding) || embedding.length === 0) {
          skipped++;
          continue;
        }

        bullet.embedding = embedding;
        cache.bullets[bullet.id] = {
          contentHash,
          embedding,
          computedAt: new Date().toISOString(),
        };
        computed++;
      }
    } catch (err: any) {
      warn(`[semantic] batchEmbed failed; falling back to per-text embedding. ${err?.message || ""}`.trim());

      for (const { bullet, contentHash } of toCompute) {
        try {
          const embedding = await embedText(bullet.content, { model });
          if (embedding.length === 0) {
            skipped++;
            continue;
          }

          bullet.embedding = embedding;
          cache.bullets[bullet.id] = {
            contentHash,
            embedding,
            computedAt: new Date().toISOString(),
          };
          computed++;
        } catch (innerErr: any) {
          warn(`[semantic] embedText failed for bullet ${bullet.id}: ${innerErr?.message || innerErr}`);
          skipped++;
        }
      }
    }
  }

  await saveEmbeddingCache(cache, { cachePath });

  return { cache, stats: { reused, computed, skipped } };
}

export async function loadOrComputeEmbeddings(
  playbook: Playbook,
  options: { model?: string; cachePath?: string } = {}
): Promise<{ cache: EmbeddingCache; stats: EmbeddingStats }> {
  return loadOrComputeEmbeddingsForBullets(playbook.bullets, options);
}

export interface SimilarBulletMatch {
  bullet: PlaybookBullet;
  similarity: number;
}

export async function findSimilarBulletsSemantic(
  query: string,
  bullets: PlaybookBullet[],
  topK = 5,
  options: { threshold?: number; model?: string; cachePath?: string; queryEmbedding?: number[] } = {}
): Promise<SimilarBulletMatch[]> {
  const cleaned = query?.trim();
  if (!cleaned) return [];

  if (!Number.isFinite(topK) || topK <= 0) return [];

  const threshold =
    typeof options.threshold === "number" && Number.isFinite(options.threshold)
      ? options.threshold
      : undefined;

  const model = options.model || DEFAULT_EMBEDDING_MODEL;

  const queryEmbedding =
    options.queryEmbedding && Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0
      ? options.queryEmbedding
      : await embedText(cleaned, { model });

  if (!queryEmbedding.length) return [];

  const allHaveEmbeddings = bullets.every(
    (b) => Array.isArray(b.embedding) && b.embedding.length > 0
  );
  if (!allHaveEmbeddings) {
    await loadOrComputeEmbeddingsForBullets(bullets, { model, cachePath: options.cachePath });
  }

  const matches: SimilarBulletMatch[] = [];

  for (const bullet of bullets) {
    if (!bullet?.content) continue;
    if (!Array.isArray(bullet.embedding) || bullet.embedding.length === 0) continue;

    const similarity = cosineSimilarity(queryEmbedding, bullet.embedding);
    if (threshold !== undefined && similarity < threshold) continue;

    matches.push({ bullet, similarity });
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  return matches.slice(0, topK);
}
