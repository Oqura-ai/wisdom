/** Estimated cost for model calls whose harness reports none (Codex reports only tokens).
 * It is what the call would cost at the provider's standard API prices, not what anyone
 * paid: most Codex use is on a ChatGPT plan. Shown as an estimate, never as reported cost.
 *
 * OpenAI standard tier, short context (up to 272K input tokens), US dollars per million
 * tokens: input, cached input, output. Read from https://developers.openai.com/api/docs/pricing
 * on 2026-11-07. gpt-5.6-sol is at a promotional price until 2026-11-30. Requests over 272K
 * input tokens cost more than this. A model not listed gets no estimate.
 */
const perMillion: Record<string, [input: number, cached: number, output: number]> = {
  'gpt-6-astra': [10, 1, 50],
  'gpt-6-sol': [2, 0.2, 10],
  'gpt-6-luna': [0.1, 0.01, 0.5],
  'gpt-6.1-sol': [2, 0.1, 10],
  'gpt-6.1-terra': [1, 0.05, 5],
  'gpt-5.6-sol': [4, 0.4, 20],
  'gpt-5.6-terra': [2, 0.2, 12],
  'gpt-5.6-luna': [0.2, 0.02, 1.2],
  'gpt-5.5': [5, 0.5, 30],
  'gpt-5.4': [2.5, 0.25, 15],
  'gpt-5.4-mini': [0.75, 0.075, 4.5],
  'gpt-5.4-nano': [0.2, 0.02, 1.25],
  'gpt-5.3-codex': [1.75, 0.175, 14],
  'gpt-5.2': [1.75, 0.175, 14],
  'gpt-5.1': [1.25, 0.125, 10],
  'gpt-5': [1.25, 0.125, 10],
  'gpt-5-mini': [0.25, 0.025, 2],
  'gpt-5-nano': [0.05, 0.005, 0.4],
};

/** Dollars for one call's tokens, or undefined when the model's price is not known. OpenAI
 * charges no separate cache write, so those tokens are priced as input. Reasoning is part of output.
 */
export function estimateCost(model: string | undefined, usage: { input: number; cacheRead: number; cacheWrite: number; output: number }): number | undefined {
  const price = model ? perMillion[model] : undefined;
  if (!price) return undefined;
  const [input, cached, output] = price;
  return ((usage.input + usage.cacheWrite) * input + usage.cacheRead * cached + usage.output * output) / 1_000_000;
}
