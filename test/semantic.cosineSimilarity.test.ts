import { describe, expect, test } from "bun:test";
import { batchEmbed, cosineSimilarity, embedText, findSemanticDuplicates, ModelLoadProgress, ProgressCallback } from "../src/semantic.js";

describe("semantic: cosineSimilarity", () => {
  test("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  test("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  test("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("semantic: embedding helpers (no model downloads)", () => {
  test("embedText returns [] when model is 'none'", async () => {
    expect(await embedText("hello world", { model: "none" })).toEqual([]);
  });

  test("batchEmbed returns [] vectors when model is 'none'", async () => {
    const result = await batchEmbed(["hello", "", "world"], 32, { model: "none" });
    expect(result).toEqual([[], [], []]);
  });
});

describe("semantic: findSemanticDuplicates (deterministic)", () => {
  test("detects duplicates from precomputed embeddings", async () => {
    const bullets: any[] = [
      { id: "b-1", content: "A", embedding: [1, 0] },
      { id: "b-2", content: "B", embedding: [1, 0] },
      { id: "b-3", content: "C", embedding: [0, 1] },
    ];

    const dupes = await findSemanticDuplicates(bullets, 0.9, { ensureEmbeddings: false });
    expect(dupes).toHaveLength(1);
    expect(dupes[0].pair).toEqual(["b-1", "b-2"]);
    expect(dupes[0].similarity).toBeCloseTo(1);
  });
});

describe("semantic: progress callback types", () => {
  test("ModelLoadProgress has expected status values", () => {
    // Type test - verify the interface is correctly exported
    const initiateProgress: ModelLoadProgress = { status: "initiate" };
    const downloadProgress: ModelLoadProgress = { status: "download", name: "model.bin" };
    const progressProgress: ModelLoadProgress = { status: "progress", progress: 50 };
    const doneProgress: ModelLoadProgress = { status: "done" };
    const readyProgress: ModelLoadProgress = { status: "ready" };

    expect(initiateProgress.status).toBe("initiate");
    expect(downloadProgress.status).toBe("download");
    expect(progressProgress.progress).toBe(50);
    expect(doneProgress.status).toBe("done");
    expect(readyProgress.status).toBe("ready");
  });

  test("ProgressCallback type is correctly exported", () => {
    // Type test - verify callback signature
    const progressEvents: ModelLoadProgress[] = [];
    const callback: ProgressCallback = (progress) => {
      progressEvents.push(progress);
    };

    callback({ status: "initiate" });
    callback({ status: "progress", progress: 25 });
    callback({ status: "progress", progress: 50 });
    callback({ status: "progress", progress: 75 });
    callback({ status: "progress", progress: 100 });
    callback({ status: "ready" });

    expect(progressEvents).toHaveLength(6);
    expect(progressEvents[0].status).toBe("initiate");
    expect(progressEvents[progressEvents.length - 1].status).toBe("ready");
  });
});
