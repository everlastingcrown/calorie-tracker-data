import assert from 'node:assert/strict';
import test from 'node:test';
import { PipelineDiagnostics } from '../diagnostics.ts';

test('PipelineDiagnostics throttles progress logs by row and time intervals', async () => {
  const messages: string[] = [];
  let now = 1_000;
  const diagnostics = new PipelineDiagnostics({
    log: (message) => messages.push(message),
    now: () => now,
    minIntervalMs: 60_000,
    rowInterval: 10_000,
  });

  await diagnostics.progress('openfoodfacts parsing', { rowsRead: 1, nutrientCorrections: 2 });
  await diagnostics.progress('openfoodfacts parsing', { rowsRead: 9_999 });
  await diagnostics.progress('openfoodfacts parsing', { rowsRead: 10_001 });

  now += 60_000;
  await diagnostics.progress('openfoodfacts parsing', { rowsRead: 10_002 });

  assert.equal(messages.length, 3);
  assert.match(messages[0], /stage=openfoodfacts parsing/);
  assert.match(messages[0], /rowsRead=1/);
  assert.match(messages[0], /nutrientCorrections=2/);
  assert.match(messages[1], /rowsRead=10001/);
  assert.match(messages[2], /rowsRead=10002/);
});
