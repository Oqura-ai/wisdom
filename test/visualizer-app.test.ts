import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Tests run from dist/test, so the sources are two folders up.
const root = new URL('../../', import.meta.url);

test('the Commits app renders recorded text with the same Markdown as the Usage dashboard', () => {
  // Each app has its own React, so the file is copied, not imported: the two must stay the same.
  const read = (path: string) => fs.readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(read('visualizer/components/Markdown.tsx'), read('dashboard/components/Markdown.tsx'),
    'visualizer/components/Markdown.tsx differs from dashboard/components/Markdown.tsx: change both together');
});
