import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildBenchmark, SOURCE_FILES, verifySourceBuffer } from '../scripts/prepare-judge-benchmark.mjs';

function fixture(count = 12) {
  const sources = Array.from({ length: count }, (_, i) => ({
    source_id: `secret-source-${i}`, task_type: 'QA', source: 'test-only-synthetic-fixture',
    source_info: { question: `Question ${i}`, passages: `Source evidence ${i}` },
  }));
  const responses = sources.flatMap((source, i) => ['pass', 'fail'].map(verdict => ({
    id: `secret-response-${i}-${verdict}`, source_id: source.source_id, model: 'secret-generator',
    split: 'test', quality: 'good', response: `Original answer ${i} ${verdict === 'pass' ? 'A' : 'B'}`,
    labels: verdict === 'fail' ? [{ text: 'hidden gold span', meta: 'secret-annotation', start: 0, end: 5, label_type: 'Evident Conflict' }] : [],
  })));
  return { sources, responses };
}

test('selection is deterministic across source order with unique sources and balanced disjoint splits', () => {
  const { sources, responses } = fixture();
  const first = buildBenchmark(responses, sources, { perLabel: 4 }).dataset;
  const reordered = buildBenchmark([...responses].reverse(), [...sources].reverse(), { perLabel: 4 }).dataset;
  assert.deepEqual(first, reordered);
  assert.equal(first.length, 8);
  assert.equal(new Set(first.map(row => row.reference.sourceId)).size, 8);
  for (const split of ['development', 'heldout']) {
    for (const verdict of ['pass', 'fail']) assert.equal(first.filter(row => row.split === split && row.referenceVerdict === verdict).length, 2);
  }
});

test('quality issues, non-test data, ambiguous annotation flags, and non-QA sources are excluded', () => {
  const { sources, responses } = fixture();
  const excluded = [
    { quality: 'incorrect_refusal' }, { quality: 'truncated' }, { split: 'train' },
    { labels: [{ implicit_true: true }] }, { labels: [{ due_to_null: true }] },
  ].map((change, i) => ({ ...responses[0], ...change, id: `excluded-${i}` }));
  const summarySource = { ...sources[0], source_id: 'summary-source', task_type: 'Summary' };
  excluded.push({ ...responses[0], id: 'excluded-summary', source_id: summarySource.source_id });
  const result = buildBenchmark([...responses, ...excluded], [...sources, summarySource], { perLabel: 4 });
  assert.equal(result.eligible.responses, responses.length);
  assert.ok(result.dataset.every(row => !row.reference.responseId.startsWith('excluded-')));
});

test('requests retain original evidence while withholding labels, metadata, split, and source identifiers', () => {
  const { sources, responses } = fixture();
  const rows = buildBenchmark(responses, sources, { perLabel: 4 }).dataset;
  for (const row of rows) {
    const requestText = JSON.stringify(row.request);
    for (const secret of ['secret-source', 'secret-response', 'secret-generator', 'secret-annotation', 'hidden gold span', 'referenceVerdict', 'labelOrigin', 'heldout', 'development']) {
      assert.ok(!requestText.includes(secret), secret);
    }
    const original = responses.find(response => response.id === row.reference.responseId);
    const source = sources.find(source => source.source_id === original.source_id);
    assert.equal(row.request.output.answer, original.response);
    assert.deepEqual(row.request.case.input, { question: source.source_info.question, source: source.source_info.passages });
    assert.equal(row.referenceVerdict, original.labels.length ? 'fail' : 'pass');
    assert.deepEqual(row.request.trace, []);
  }
  assert.equal(new Set(rows.map(row => row.request.case.expected)).size, 1);
  assert.equal(new Set(rows.map(row => JSON.stringify(row.request.criteria))).size, 1);
});

test('preparation refuses insufficient unique sources and corrupt pinned input', () => {
  const { sources, responses } = fixture(3);
  assert.throws(() => buildBenchmark(responses, sources, { perLabel: 4 }), /Insufficient unique fail sources/);
  assert.throws(() => verifySourceBuffer(Buffer.from('modified source'), SOURCE_FILES[0]), /checksum mismatch/);
  assert.throws(() => buildBenchmark(responses, [...sources, sources[0]], { perLabel: 2 }), /Duplicate source/);
  assert.throws(() => buildBenchmark([...responses, responses[0]], sources, { perLabel: 2 }), /Duplicate response/);
});

test('committed public benchmark is frozen, balanced, human-labelled, and source-disjoint', async () => {
  const raw = await readFile(new URL('../benchmarks/judge/ragtruth-qa.json', import.meta.url));
  const rows = JSON.parse(raw);
  const lock = JSON.parse(await readFile(new URL('../benchmarks/judge/ragtruth-qa.lock.json', import.meta.url)));
  assert.equal(createHash('sha256').update(raw).digest('hex'), lock.datasetSha256);
  assert.equal(rows.length, 48);
  assert.equal(new Set(rows.map(row => row.id)).size, 48);
  assert.equal(new Set(rows.map(row => row.reference.sourceId)).size, 48);
  for (const split of ['development', 'heldout']) {
    for (const verdict of ['pass', 'fail']) assert.equal(rows.filter(row => row.split === split && row.referenceVerdict === verdict).length, 12);
  }
  for (const row of rows) {
    assert.equal(row.labelOrigin, 'human');
    assert.equal(row.reference.originalSplit, 'test');
    assert.equal(row.reference.quality, 'good');
    assert.ok(row.reference.labels.every(label => !label.implicit_true && !label.due_to_null));
    assert.equal(row.referenceVerdict, row.reference.labels.length ? 'fail' : 'pass');
    assert.deepEqual(Object.keys(row.request).sort(), ['case', 'criteria', 'output', 'trace']);
    assert.deepEqual(Object.keys(row.request.case).sort(), ['expected', 'id', 'input', 'name']);
    assert.deepEqual(Object.keys(row.request.case.input).sort(), ['question', 'source']);
    assert.deepEqual(Object.keys(row.request.output), ['answer']);
  }
});
