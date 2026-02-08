/**
 * Rules-based complexity classifier for the auto-router.
 *
 * Zero cost, ~0ms latency. Uses regex + heuristics on message length,
 * keywords, tool mentions, and conversation depth.
 */

import type { ComplexityTier } from "../config/types.auto-router.js";

// ---------------------------------------------------------------------------
// Keyword / pattern banks
// ---------------------------------------------------------------------------

const SIMPLE_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|bye|good morning|good night|gm|gn)\b/i,
  /^what('s| is) (the )?(time|date|day|weather)\b/i,
  /\bwhat\s+(time|day|date)\s+is\s+it\b/i,
  /\bwhat('s| is)\s+today('s)?\s+(date|day)\b/i,
  /^(who|what|where|when) (is|are|was|were) /i,
  /^(show|list|get|find|lookup|check)\b/i,
];

const REASONING_PATTERNS: RegExp[] = [
  /\b(prove|proof|theorem|lemma|corollary)\b/i,
  /\b(solve|equation|integral|derivative|matrix|eigenvalue)\b/i,
  /\b(logic|logical|syllogism|contradiction|induction|deduction)\b/i,
  /\b(step[- ]by[- ]step|chain[- ]of[- ]thought|reason(ing)?( through)?)\b/i,
  /\b(algorithm|complexity|big[- ]o|np[- ]hard|dynamic programming)\b/i,
  /\b(probability|bayesian|statistics|hypothesis)\b/i,
];

const COMPLEX_PATTERNS: RegExp[] = [
  /\b(architect(ure)?|design (system|pattern|a ))\b/i,
  /\b(refactor|rewrite|implement|build|create)\b.{20,}/i,
  /\b(multi[- ]?file|codebase|project|repository)\b/i,
  /\b(deploy|infrastructure|ci\/?cd|pipeline|kubernetes|docker)\b.*\b(architect|scale|design|migration|cluster|orchestrat)/i,
  /\b(database (schema|design|migration))\b/i,
  /\b(full[- ]?stack|end[- ]to[- ]end|microservice)\b/i,
];

const MEDIUM_PATTERNS: RegExp[] = [
  /\b(summarize|summary|explain|review|analyze|compare)\b/i,
  /\b(code review|debug|fix (this|the)|what('s| is) wrong)\b/i,
  /\b(convert|translate|transform|format)\b/i,
  /\b(write (a |an )?(function|class|test|script|query))\b/i,
  /\b(how (do|does|to|can|should))\b/i,
];

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Classify a user message into a complexity tier using rules-based heuristics.
 *
 * @param message - The user's message text.
 * @param conversationDepth - Number of messages in the conversation so far.
 * @param toolMentions - Number of distinct tools referenced in the message.
 */
export function classifyByRules(
  message: string,
  conversationDepth: number = 0,
  toolMentions: number = 0,
): ComplexityTier {
  const trimmed = message.trim();
  const length = trimmed.length;

  // Very short messages with no special patterns → simple
  if (length < 20 && !matchesAny(trimmed, REASONING_PATTERNS)) {
    if (matchesAny(trimmed, SIMPLE_PATTERNS) || length < 10) {
      return "simple";
    }
  }

  // Check reasoning first (highest priority pattern match)
  if (matchesAny(trimmed, REASONING_PATTERNS)) {
    return "reasoning";
  }

  // Complex indicators
  if (matchesAny(trimmed, COMPLEX_PATTERNS)) {
    return "complex";
  }

  // Long messages with multiple tool mentions → complex
  if (length > 500 && toolMentions >= 2) {
    return "complex";
  }

  // Very long messages → at least complex
  if (length > 1000) {
    return "complex";
  }

  // Medium patterns
  if (matchesAny(trimmed, MEDIUM_PATTERNS)) {
    return "medium";
  }

  // Medium-length messages in deep conversations → medium
  if (length > 100 || conversationDepth > 5) {
    return "medium";
  }

  // Short messages with simple patterns
  if (matchesAny(trimmed, SIMPLE_PATTERNS)) {
    return "simple";
  }

  // Default: medium (safe middle ground)
  return "medium";
}
