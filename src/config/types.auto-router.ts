/**
 * Configuration types for the auto-router model selection feature.
 *
 * When `model.primary` is set to `"auto"`, the auto-router classifies
 * incoming messages by complexity and picks the optimal model tier.
 */

export type AutoRouterClassifier = "rules" | "llm";

export type AutoRouterPreference = "cost" | "balanced" | "quality";

export type ComplexityTier = "simple" | "medium" | "complex" | "reasoning";

export type AutoRouterTiers = {
  /** Model for simple tasks (greetings, yes/no, lookups). */
  simple?: string;
  /** Model for medium tasks (summarization, code review). */
  medium?: string;
  /** Model for complex tasks (architecture, multi-file codegen). */
  complex?: string;
  /** Model for reasoning tasks (math, logic, proofs). */
  reasoning?: string;
};

export type AutoRouterConfig = {
  /** Classifier strategy: "rules" (free, ~0ms) or "llm" (cheap model call). */
  classifier?: AutoRouterClassifier;
  /** Model used for LLM-based classification (only when classifier="llm"). */
  classifierModel?: string;
  /** Optimization preference: "cost", "balanced", or "quality". */
  preference?: AutoRouterPreference;
  /** Model overrides per complexity tier. */
  tiers?: AutoRouterTiers;
  /** Timeout in ms for LLM classifier calls (default: 3000). */
  classifierTimeout?: number;
  /** Auto-discover models from catalog for scoring (default: true). */
  autoDiscover?: boolean;
};
