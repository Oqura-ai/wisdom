// Integration fixture only: real Pi executes real tools; model responses are
// scripted locally so this test needs no API key, network call, or model spend.
import fs from 'node:fs';
import path from 'node:path';

export default function scriptedProvider(pi) {
  pi.registerTool({
    name: 'partial_failure', label: 'Partial failure', description: 'Create a file then fail for the recording test.',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      fs.writeFileSync(path.join(ctx.cwd, 'leftover.txt'), 'created before failure');
      throw new Error('Expected test failure after a real file write');
    }
  });
  pi.registerTool({
    name: 'nested_writer', label: 'Nested writer', description: 'Exercise Pi nested tool calls.',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      await ctx.executeTool('write', { path: 'nested.txt', content: 'nested write\n' });
      // Leave a queryable running interval after the nested write.
      await new Promise(resolve => setTimeout(resolve, 700));
      return { content: [{ type: 'text', text: 'Nested write completed' }] };
    }
  });
  const steps = [
    { name: 'write', arguments: { path: 'example.txt', content: 'hello world\n' } },
    { name: 'edit', arguments: { path: 'example.txt', oldText: 'hello world', newText: 'hello wisdom' } },
    { name: 'partial_failure', arguments: {} },
    { name: 'nested_writer', arguments: {} }
  ];
  let step = 0;
  pi.registerProvider('wisdom-test', {
    api: 'wisdom-test-api', baseUrl: 'http://unused.invalid', apiKey: 'local-test-only',
    models: [{ id: 'scripted', name: 'Scripted integration test', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }],
    streamSimple(model) {
      const action = steps[step++];
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: action ? 'toolUse' : 'stop',
        content: action ? [{ type: 'toolCall', id: `scripted-${step}`, ...action }] : [{ type: 'text', text: 'Fixture finished.' }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'start', partial: message }; yield { type: 'done', reason: message.stopReason, message }; },
        async result() { return message; }
      };
    }
  });
}
