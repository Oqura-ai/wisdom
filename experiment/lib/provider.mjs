// A Pi model provider that follows a script: real Pi runs real tools, and only the model's
// words come from a file. So a session has known problems with no instruction to plant
// them in its transcript, which a reviewer reading the session would simply find.
import fs from 'node:fs';

export default function scriptedWorker(pi) {
  const steps = JSON.parse(fs.readFileSync(process.env.EXPERIMENT_SCRIPT, 'utf8'));
  let next = 0;
  pi.registerProvider('local', {
    api: 'local-api', baseUrl: 'http://unused.invalid', apiKey: 'local-only',
    models: [{ id: 'worker-1', name: 'Worker', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }],
    streamSimple(model) {
      const step = steps[next++] ?? { say: 'Done.' };
      const content = [];
      if (step.say) content.push({ type: 'text', text: step.say });
      if (step.tool) content.push({ type: 'toolCall', id: `call-${next}`, name: step.tool[0], arguments: step.tool[1] });
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: step.tool ? 'toolUse' : 'stop', content,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'start', partial: message }; yield { type: 'done', reason: message.stopReason, message }; },
        async result() { return message; }
      };
    }
  });
}
