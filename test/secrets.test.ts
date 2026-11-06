import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSecret, redactSecrets, redactionMarker, scanSecrets } from '../src/secrets.js';

const openai = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
const github = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const aws = 'AKIAABCDEFGHIJKLMNOP';
const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';

test('the scan finds the credential shapes it knows', () => {
  const kinds = (text: string) => scanSecrets(text).map(match => [match.kind, match.value]);
  assert.deepEqual(kinds(`key ${openai} and ${github}`), [['openai-key', openai], ['github-token', github]]);
  assert.deepEqual(kinds(`aws ${aws}.`), [['aws-access-key', aws]]);
  assert.deepEqual(kinds(`Authorization: Bearer abcdefghijklmnopqrstuvwxyz`), [['bearer-token', 'abcdefghijklmnopqrstuvwxyz']]);
  assert.deepEqual(kinds(key), [['private-key', key]]);
  assert.deepEqual(kinds('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), [['anthropic-key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz']]);
});

test('assignments are found in plain text and inside JSON-escaped text, value only', () => {
  assert.deepEqual(scanSecrets('DB_PASSWORD=hunter22secret\nNEXT=1').map(m => m.value), ['hunter22secret']);
  assert.deepEqual(scanSecrets(JSON.stringify({ out: 'API_KEY: "zq81kLmN0pQ"\nDB_PASSWORD=hunter22secret' })).map(m => m.value), ['zq81kLmN0pQ', 'hunter22secret']);
  assert.deepEqual(scanSecrets(JSON.stringify({ config: { API_KEY: 'zq81kLmN0pQ' } })).map(m => m.value), ['zq81kLmN0pQ']);
});

test('references, placeholders and plain settings are not secrets', () => {
  for (const text of ['API_KEY=${OPENAI_API_KEY}', 'TOKEN=<your token>', 'MAX_TOKENS=100000', 'SECRET=true', 'PASSWORD=short']) {
    assert.deepEqual(scanSecrets(text), [], text);
  }
});

test('redaction replaces every occurrence, keeps JSON valid, and is not found again', () => {
  const text = JSON.stringify({ a: `token ${openai}`, b: `again ${openai}`, c: 'DB_PASSWORD=hunter22secret' });
  const values = new Map(scanSecrets(text).map(match => [match.value, match.kind]));
  const redacted = redactSecrets(text, values);
  assert(!redacted.includes(openai) && !redacted.includes('hunter22secret'));
  assert.equal(redacted.split(redactionMarker('openai-key')).length - 1, 2);
  assert.match(JSON.parse(redacted).c, /^DB_PASSWORD=\[redacted by sender: secret-assignment\]$/);
  assert.deepEqual(scanSecrets(redacted), []);
});

test('a masked value can be recognized but not used', () => {
  assert.equal(maskSecret(openai), 'sk-pro…3456');
  assert.equal(maskSecret('hunter2'), 'hu…');
  assert.equal(maskSecret('hunter22secret'), 'hu…');
  assert.deepEqual(scanSecrets('mypassword=hunter22secret'), [], 'lower-case words are not names');
  assert.equal(maskSecret(key), '-----BEGIN RSA PRIVATE KEY-----…');
});
