/**
 * Auto-router: classifies user messages by complexity and picks the optimal model.
 *
 * Flow: User query → classifyTask() → scoreModels() → resolveAutoModel()
 *
 * Only activates when `model.primary` is set to `"auto"` in config.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import type {
  AutoRouterConfig,
  AutoRouterPreference,
  ComplexityTier,
} from "../config/types.auto-router.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { classifyByRules } from "./auto-router-rules.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { parseModelRef, type ModelRef } from "./model-selection.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIERS: Record<ComplexityTier, string> = {
  simple: "anthropic/claude-haiku-3-5",
  medium: "anthropic/claude-sonnet-4-20250514",
  complex: "anthropic/claude-opus-4-6",
  reasoning: "anthropic/claude-opus-4-6",
};

// Capability requirements per tier (minimum thresholds)
const TIER_REQUIREMENTS: Record<
  ComplexityTier,
  { minContext: number; needsReasoning: boolean; maxCostInput: number }
> = {
  simple: { minContext: 4_000, needsReasoning: false, maxCostInput: Infinity },
  medium: { minContext: 32_000, needsReasoning: false, maxCostInput: Infinity },
  complex: { minContext: 100_000, needsReasoning: false, maxCostInput: Infinity },
  reasoning: { minContext: 100_000, needsReasoning: true, maxCostInput: Infinity },
};

// ---------------------------------------------------------------------------
// Model Scorer
// ---------------------------------------------------------------------------

type ModelScore = {
  provider: string;
  model: string;
  score: number;
  capabilityMatch: number;
  costEfficiency: number;
  qualityRating: number;
  latencyEstimate: number;
};

/** Known quality tiers by provider (rough heuristic). */
function estimateQuality(provider: string, model: string): number {
  const id = `${provider}/${model}`.toLowerCase();
  if (id.includes("opus")) return 1.0;
  if (id.includes("sonnet")) return 0.8;
  if (id.includes("gpt-4o") && !id.includes("mini")) return 0.85;
  if (id.includes("gpt-4.1") && !id.includes("mini") && !id.includes("nano")) return 0.85;
  if (id.includes("gemini-2.5-pro")) return 0.85;
  if (id.includes("haiku") || id.includes("mini") || id.includes("nano")) return 0.5;
  if (id.includes("flash")) return 0.55;
  return 0.6;
}

/** Estimate latency bucket (0=fast, 1=slow). Lower is better. */
function estimateLatency(provider: string, model: string): number {
  const id = `${provider}/${model}`.toLowerCase();
  if (id.includes("haiku") || id.includes("flash") || id.includes("mini") || id.includes("nano"))
    return 1.0; // fast → high score
  if (id.includes("sonnet") || id.includes("gpt-4o")) return 0.7;
  if (id.includes("opus")) return 0.3;
  return 0.5;
}

function scoreModel(
  def: ModelDefinitionConfig,
  provider: string,
  tier: ComplexityTier,
  preference: AutoRouterPreference,
): ModelScore | null {
  const reqs = TIER_REQUIREMENTS[tier];

  // Hard filter: must meet minimum context window
  if (def.contextWindow < reqs.minContext) {
    return null;
  }

  // Hard filter: reasoning tier needs reasoning-capable model
  if (reqs.needsReasoning && !def.reasoning) {
    return null;
  }

  // Capability match (0-1): how well does the model fit this tier?
  let capabilityMatch = 0.5;
  if (def.contextWindow >= 100_000) capabilityMatch += 0.2;
  if (def.reasoning && tier === "reasoning") capabilityMatch += 0.3;
  if (def.input?.includes("image")) capabilityMatch += 0.1;
  capabilityMatch = Math.min(1.0, capabilityMatch);

  // Cost efficiency (0-1): cheaper is better, normalized
  const costPerMToken = def.cost.input + def.cost.output;
  const costEfficiency = costPerMToken > 0 ? Math.min(1.0, 1.0 / (1 + costPerMToken * 0.1)) : 1.0;

  const qualityRating = estimateQuality(provider, def.id);
  const latencyEst = estimateLatency(provider, def.id);

  // Weighted score with preference adjustments
  let weights = { cap: 0.4, cost: 0.3, quality: 0.2, latency: 0.1 };
  if (preference === "cost") {
    weights = { cap: 0.2, cost: 0.5, quality: 0.15, latency: 0.15 };
  } else if (preference === "quality") {
    weights = { cap: 0.3, cost: 0.1, quality: 0.5, latency: 0.1 };
  }

  const score =
    capabilityMatch * weights.cap +
    costEfficiency * weights.cost +
    qualityRating * weights.quality +
    latencyEst * weights.latency;

  return {
    provider,
    model: def.id,
    score,
    capabilityMatch,
    costEfficiency,
    qualityRating,
    latencyEstimate: latencyEst,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AutoRouterResult = {
  tier: ComplexityTier;
  selectedModel: ModelRef;
  scores?: ModelScore[];
};

/**
 * Check whether the config has auto-routing enabled.
 */
export function isAutoModelEnabled(cfg: OpenClawConfig): boolean {
  const model = cfg.agents?.defaults?.model;
  if (!model || typeof model === "string") {
    return false;
  }
  return model.primary === "auto";
}

/**
 * Extract the auto-router config from the OpenClaw config.
 */
export function getAutoRouterConfig(cfg: OpenClawConfig): AutoRouterConfig | undefined {
  const model = cfg.agents?.defaults?.model as
    | { primary?: string; auto?: AutoRouterConfig }
    | string
    | undefined;
  if (!model || typeof model === "string") {
    return undefined;
  }
  return (model as { auto?: AutoRouterConfig }).auto;
}

// ---------------------------------------------------------------------------
// LLM Classifier
// ---------------------------------------------------------------------------

const CLASSIFICATION_PROMPT = `Classify this user message into exactly one category: SIMPLE, MEDIUM, COMPLEX, or REASONING.

SIMPLE: greetings, yes/no, lookups, short factual questions
MEDIUM: summarization, code review, how-to guides, explanations
COMPLEX: architecture design, multi-file code generation, research synthesis
REASONING: math proofs, logic puzzles, algorithmic problems

Message: "{message}"

Category:`;

const TIER_MAP: Record<string, ComplexityTier> = {
  SIMPLE: "simple",
  MEDIUM: "medium",
  COMPLEX: "complex",
  REASONING: "reasoning",
};

/**
 * Resolve a model ref like "openai/gpt-4.1-nano" into a pi-ai Model object.
 * Uses the built-in model catalog from @mariozechner/pi-ai.
 */
function resolveClassifierModel(modelRef: string): Model<Api> | null {
  const parts = modelRef.split("/");
  if (parts.length < 2) return null;
  const provider = parts[0];
  const modelId = parts.slice(1).join("/");
  try {
    return getModel(provider as any, modelId as any) as Model<Api>;
  } catch {
    return null;
  }
}

/**
 * Classify a message using an LLM call with timeout and fallback.
 */
async function classifyWithLLM(
  message: string,
  classifierModel: string,
  timeoutMs: number,
): Promise<ComplexityTier | null> {
  const model = resolveClassifierModel(classifierModel);
  if (!model) return null;

  const prompt = CLASSIFICATION_PROMPT.replace("{message}", message.slice(0, 500));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await completeSimple(
      model,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
      {
        maxTokens: 10,
        temperature: 0,
        signal: controller.signal,
      },
    );

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim()
      .toUpperCase();

    // Extract the tier from the response
    for (const [key, tier] of Object.entries(TIER_MAP)) {
      if (text.includes(key)) return tier;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a user message into a complexity tier.
 *
 * When `autoConfig.classifier` is `"llm"`, attempts LLM-based classification
 * with a cheap model, falling back to rules on failure.
 */
export async function classifyTask(
  message: string,
  autoConfig?: AutoRouterConfig,
  conversationDepth: number = 0,
  toolMentions: number = 0,
): Promise<ComplexityTier> {
  // Try LLM classification if configured
  if (autoConfig?.classifier === "llm" && autoConfig.classifierModel) {
    const timeoutMs = autoConfig.classifierTimeout ?? 3000;
    const result = await classifyWithLLM(message, autoConfig.classifierModel, timeoutMs);
    if (result) return result;
    // Fall through to rules-based on failure
  }

  return classifyByRules(message, conversationDepth, toolMentions);
}

/**
 * Score available models for a given complexity tier.
 */
export function scoreModels(
  tier: ComplexityTier,
  cfg: OpenClawConfig,
  catalog: ModelCatalogEntry[],
  preference: AutoRouterPreference = "balanced",
): ModelScore[] {
  const scores: ModelScore[] = [];

  // Score models from configured providers
  const providers = cfg.models?.providers ?? {};
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    for (const modelDef of providerConfig.models ?? []) {
      const result = scoreModel(modelDef, providerName, tier, preference);
      if (result) {
        scores.push(result);
      }
    }
  }

  // Score models from catalog (using estimated metadata)
  for (const entry of catalog) {
    const alreadyScored = scores.some((s) => s.provider === entry.provider && s.model === entry.id);
    if (alreadyScored) continue;

    // Build a synthetic ModelDefinitionConfig from catalog entry
    const syntheticDef: ModelDefinitionConfig = {
      id: entry.id,
      name: entry.name,
      reasoning: entry.reasoning ?? false,
      input: entry.input ?? ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow ?? 128_000,
      maxTokens: 8_192,
    };

    const result = scoreModel(syntheticDef, entry.provider, tier, preference);
    if (result) {
      scores.push(result);
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/**
 * Resolve the auto-selected model for a given message.
 *
 * Returns the ModelRef to use, along with the classification tier and scores.
 * Falls back to tier defaults if no catalog models are available.
 */
export async function resolveAutoModel(params: {
  message: string;
  cfg: OpenClawConfig;
  catalog?: ModelCatalogEntry[];
  conversationDepth?: number;
  toolMentions?: number;
}): Promise<AutoRouterResult> {
  const autoConfig = getAutoRouterConfig(params.cfg);
  const preference = autoConfig?.preference ?? "balanced";
  const tiers = autoConfig?.tiers ?? {};

  // 1. Classify the task
  const tier = await classifyTask(
    params.message,
    autoConfig,
    params.conversationDepth,
    params.toolMentions,
  );

  // 2. Check for explicit tier override in config
  const tierModel = tiers[tier];
  if (tierModel) {
    const parsed = parseModelRef(tierModel, DEFAULT_PROVIDER);
    if (parsed) {
      return { tier, selectedModel: parsed };
    }
  }

  // 3. If autoDiscover is enabled and catalog is available, score and pick best
  const shouldDiscover = autoConfig?.autoDiscover !== false;
  if (shouldDiscover && params.catalog && params.catalog.length > 0) {
    const scores = scoreModels(tier, params.cfg, params.catalog, preference);
    if (scores.length > 0) {
      const best = scores[0];
      return {
        tier,
        selectedModel: { provider: best.provider, model: best.model },
        scores: scores.slice(0, 5), // top 5 for debugging
      };
    }
  }

  // 4. Fall back to hardcoded defaults
  const defaultModel = DEFAULT_TIERS[tier];
  const parsed = parseModelRef(defaultModel, DEFAULT_PROVIDER);
  return {
    tier,
    selectedModel: parsed ?? { provider: "anthropic", model: "claude-opus-4-6" },
  };
}
