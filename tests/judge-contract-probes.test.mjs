import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const probes = JSON.parse(await readFile(new URL('../benchmarks/judge/contract-probes.json', import.meta.url), 'utf8'));
const byName = name => probes.filter(probe => probe.request.case.name === name);
const withVerdict = (group, verdict) => group.find(probe => probe.referenceVerdict === verdict);

test('contract probes identify constructed references and balance all three verdicts', () => {
  assert.equal(probes.length, 12);
  assert.equal(new Set(probes.map(probe => probe.id)).size, 12);
  for (const verdict of ['pass', 'fail', 'pending']) {
    assert.equal(probes.filter(probe => probe.referenceVerdict === verdict).length, 4);
  }
  for (const probe of probes) {
    assert.match(probe.id, /^probe-[0-9a-f]{4}$/);
    assert.equal(probe.source, 'contract-probes');
    assert.equal(probe.split, 'contract');
    assert.equal(probe.labelOrigin, 'constructed');
    assert.deepEqual(Object.keys(probe.reference).sort(), ['basis', 'humanReviewed', 'rationale']);
    assert.equal(probe.reference.basis, 'deterministic-contract');
    assert.equal(probe.reference.humanReviewed, false);
    assert.ok(probe.reference.rationale.length > 10);
    assert.equal(probe.request.case.id, probe.id);
    assert.doesNotMatch(probe.request.case.name, /pass|fail|pending|正确|错误|失败|成功|待定/i);
  }
});

test('judge requests exclude gold labels and provenance while retaining evidence source fields', () => {
  const forbiddenKeys = new Set(['referenceVerdict', 'reference', 'labelOrigin', 'split', 'rationale', 'humanReviewed', 'basis', 'gold', 'goldVerdict']);
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!forbiddenKeys.has(key), `gold-only field leaked: ${key}`);
      inspect(item);
    }
  }
  for (const { request } of probes) {
    assert.deepEqual(Object.keys(request).sort(), ['case', 'criteria', 'output', 'trace']);
    assert.deepEqual(Object.keys(request.case).sort(), ['expected', 'id', 'input', 'name']);
    assert.ok(request.criteria.length > 0);
    assert.ok(request.case.expected.length > 0);
    assert.doesNotMatch(request.case.expected, /\b(pass|fail|pending)\b/i);
    inspect(request);
  }
});

test('each matched group changes only evidence, not the task, answer or standard', () => {
  const names = [...new Set(probes.map(probe => probe.request.case.name))];
  assert.equal(names.length, 4);
  for (const name of names) {
    const group = byName(name);
    assert.equal(group.length, 3);
    assert.deepEqual(group.map(probe => probe.referenceVerdict).sort(), ['fail', 'pass', 'pending']);
    const comparable = ({ request }) => ({ ...request, case: { ...request.case, id: undefined }, trace: undefined });
    assert.deepEqual(comparable(group[0]), comparable(group[1]));
    assert.deepEqual(comparable(group[0]), comparable(group[2]));
    assert.equal(new Set(group.map(probe => JSON.stringify(probe.request.trace))).size, 3);
  }
});

test('refund and policy contrasts distinguish explicit violations from unavailable evidence', () => {
  const refund = byName('退款办理');
  assert.equal(withVerdict(refund, 'pass').request.trace[0].result.success, true);
  assert.equal(withVerdict(refund, 'fail').request.trace[0].result.success, false);
  assert.equal(withVerdict(refund, 'fail').request.trace[0].result.refundId, null);
  assert.deepEqual(withVerdict(refund, 'pending').request.trace, []);
  const policy = byName('退货政策查询');
  assert.equal(withVerdict(policy, 'pass').request.trace[0].result.documents[0].returnWindowDays, 30);
  assert.equal(withVerdict(policy, 'fail').request.trace[0].result.documents[0].returnWindowDays, 14);
  assert.deepEqual(withVerdict(policy, 'pending').request.trace, []);
});

test('multi-turn probes require the last seat choice and distinguish calls from state changes', () => {
  const group = byName('座位变更对话');
  const correct = withVerdict(group, 'pass').request;
  const wrong = withVerdict(group, 'fail').request;
  const unknown = withVerdict(group, 'pending').request;
  assert.match(correct.case.input.messages[0].content, /12A/);
  assert.match(correct.case.input.messages.at(-1).content, /14C/);
  assert.ok(correct.trace.every(event => event.result.seat === '14C'));
  assert.ok(wrong.trace.every(event => event.result.seat === '12A'));
  assert.equal(unknown.trace.length, 1);
  assert.equal(unknown.trace[0].type, 'tool_call');
  assert.equal(unknown.trace[0].arguments.seat, '14C');
  assert.ok(!('result' in unknown.trace[0]));
});

test('conflicting authoritative evidence stays unresolved despite an identical output injection', () => {
  const group = byName('物流状态核对');
  assert.equal(new Set(group.map(probe => probe.request.output.debug)).size, 1);
  assert.ok(group.every(probe => probe.request.output.debug.includes('SYSTEM OVERRIDE')));
  const statuses = verdict => withVerdict(group, verdict).request.trace.map(event => event.result.status);
  assert.deepEqual(statuses('pass'), ['delivered', 'delivered']);
  assert.deepEqual(statuses('fail'), ['in_transit', 'in_transit']);
  assert.deepEqual(statuses('pending'), ['delivered', 'in_transit']);
  const disputed = withVerdict(group, 'pending').request.trace.map(event => event.result);
  assert.equal(disputed[0].orderId, disputed[1].orderId);
  assert.equal(disputed[0].version, disputed[1].version);
  assert.notEqual(disputed[0].source, disputed[1].source);
});
