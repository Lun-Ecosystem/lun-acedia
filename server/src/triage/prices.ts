/**
 * Dollars per million tokens (input, output), prompts of 100K tokens or fewer. Read on 2026-10-19 from
 * the Claude model table of the claude-api skill (Claude Haiku 5.5: $0.10 / $0.50). Check the official
 * pricing page when the model changes.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export function costOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const price = PRICES[model];
  if (!price) throw new Error(`Tarif inconnu pour le modèle ${model}`);
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
