/** Shared surface rules. Detailed views project text; clean views can also retain
 * images and other non-text blocks without treating thinking as surface text.
 */
export function messageContent(value: any, surface = false): any {
  if (!Array.isArray(value)) return value ?? null;
  const blocks = surface ? value.filter(b => !['thinking', 'toolCall', 'reasoning'].includes(b?.type)) : value;
  if (blocks.every(b => b?.type === 'text' && typeof b.text === 'string')) return blocks.map(b => b.text).join('\n');
  return blocks;
}

export function surfaceText(value: any): string {
  const message = value?.message ?? value;
  if (typeof message?.text === 'string') return message.text;
  const content = messageContent(message?.content, true);
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '';
}
