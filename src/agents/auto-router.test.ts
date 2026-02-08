import { describe, it, expect } from "vitest";
import { classifyTask } from "./auto-router.js";

describe("classifyTask (rules-based)", () => {
  // All 11 regression cases
  const cases: [string, string][] = [
    ["hi", "simple"],
    ["hello there", "simple"],
    ["what time is it?", "simple"],
    ["yes", "simple"],
    ["summarize this article about climate change", "medium"],
    ["explain how React hooks work", "medium"],
    ["review this code for bugs", "medium"],
    [
      "design a microservices architecture for an e-commerce platform with payment processing, inventory management, and user authentication",
      "complex",
    ],
    [
      "write a full-stack application with React frontend, Node.js backend, and PostgreSQL database",
      "complex",
    ],
    ["prove that the square root of 2 is irrational", "reasoning"],
    [
      "solve this dynamic programming problem: given an array of integers, find the longest increasing subsequence",
      "reasoning",
    ],
  ];

  for (const [input, expected] of cases) {
    it(`classifies "${input.slice(0, 40)}..." as ${expected}`, async () => {
      const result = await classifyTask(input);
      expect(result).toBe(expected);
    });
  }
});
