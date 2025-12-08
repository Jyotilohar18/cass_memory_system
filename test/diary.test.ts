import { describe, expect, it } from "bun:test";
import { extractSearchAnchors, DiaryExtraction } from "../src/diary.js";

describe("extractSearchAnchors", () => {
  it("extracts technical terms from diary fields", () => {
    const diary: DiaryExtraction = {
      accomplishments: ["Fixed JWT authentication bug", "Implemented React hooks"],
      decisions: ["Used TypeScript for type safety", "Chose Prisma as ORM"],
      challenges: ["CORS configuration was tricky", "Async/await timeout issues"],
      keyLearnings: ["Always validate tokens", "Use vitest for testing"],
      tags: ["auth", "react", "typescript"]
    };

    const anchors = extractSearchAnchors(diary);

    // Should find key technical terms
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.length).toBeLessThanOrEqual(15);

    // Check for expected technical terms (case-insensitive)
    const lowerAnchors = anchors.map(a => a.toLowerCase());
    expect(lowerAnchors).toContain("jwt");
    expect(lowerAnchors).toContain("react");
    expect(lowerAnchors).toContain("typescript");
  });

  it("returns empty array for empty diary", () => {
    const diary: DiaryExtraction = {};
    const anchors = extractSearchAnchors(diary);
    expect(anchors).toEqual([]);
  });

  it("returns tags when no other content available", () => {
    const diary: DiaryExtraction = {
      tags: ["testing", "api", "database"]
    };
    const anchors = extractSearchAnchors(diary);

    // Should include tags
    const lowerAnchors = anchors.map(a => a.toLowerCase());
    expect(lowerAnchors).toContain("testing");
    expect(lowerAnchors).toContain("api");
    expect(lowerAnchors).toContain("database");
  });

  it("extracts file patterns", () => {
    const diary: DiaryExtraction = {
      accomplishments: ["Updated package.json", "Fixed config.yaml settings"],
      challenges: ["Issues with test.ts file"]
    };

    const anchors = extractSearchAnchors(diary);
    const lowerAnchors = anchors.map(a => a.toLowerCase());

    // Should find file patterns
    expect(lowerAnchors.some(a => a.includes("package.json"))).toBe(true);
  });

  it("prioritizes technical terms over common words", () => {
    const diary: DiaryExtraction = {
      accomplishments: ["The authentication system is now working with OAuth2"],
      keyLearnings: ["The error handling for GraphQL was important"]
    };

    const anchors = extractSearchAnchors(diary);
    const lowerAnchors = anchors.map(a => a.toLowerCase());

    // Technical terms should be present
    expect(lowerAnchors).toContain("authentication");
    expect(lowerAnchors).toContain("oauth2");
    expect(lowerAnchors).toContain("graphql");

    // Common words like "the", "is", "was" should NOT be present
    expect(lowerAnchors).not.toContain("the");
    expect(lowerAnchors).not.toContain("is");
    expect(lowerAnchors).not.toContain("was");
  });

  it("limits output to 15 anchors", () => {
    const diary: DiaryExtraction = {
      accomplishments: [
        "Implemented React, Vue, Angular components",
        "Used TypeScript, JavaScript, Python scripts",
        "Set up Docker, Kubernetes, AWS infrastructure",
        "Configured PostgreSQL, MongoDB, Redis databases",
        "Added JWT, OAuth, CORS security",
        "Wrote Jest, Vitest, Mocha tests"
      ],
      tags: ["tag1", "tag2", "tag3", "tag4", "tag5"]
    };

    const anchors = extractSearchAnchors(diary);
    expect(anchors.length).toBeLessThanOrEqual(15);
  });

  it("deduplicates similar anchors", () => {
    const diary: DiaryExtraction = {
      accomplishments: ["Used React for frontend", "react hooks implementation"],
      decisions: ["REACT components are best"]
    };

    const anchors = extractSearchAnchors(diary);

    // Should only have one version of "react"
    const reactCount = anchors.filter(a => a.toLowerCase() === "react").length;
    expect(reactCount).toBeLessThanOrEqual(1);
  });
});
