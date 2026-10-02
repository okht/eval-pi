import { readFile, writeFile } from 'node:fs/promises';

// This fixture executes a deterministic workflow and a real, isolated JSON store.
// It deliberately keeps two product bugs; it does not call a language model.
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const { input, sessionId } = JSON.parse(stdin.trim());
const statePath = 'business-state.json';
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { tickets: [], sessionId }; }
const initialTicketCount = state.tickets.length;
const trace = [];
const replies = [];
let pendingRequest = false;
let orderId;
await writeFile(statePath, JSON.stringify(state), 'utf8');

async function submitRequest(order, turn) {
  trace.push({ type: 'tool_call', name: 'submit_after_sales', input: { orderId: order }, turn });
  if (input.scenario === 'timeout-false-success') {
    trace.push({ type: 'tool_result', name: 'submit_after_sales', status: 'timeout', committed: false, turn });
    // Known defect: caller incorrectly ignores the failed tool result.
    return { success: false };
  }
  // Known defect: repeated requests have no idempotency lookup.
  const ticket = { id: `T${state.tickets.length + 1}`, orderId: order };
  state.tickets.push(ticket);
  await writeFile(statePath, JSON.stringify(state), 'utf8');
  trace.push({ type: 'tool_result', name: 'submit_after_sales', status: 'ok', ticketId: ticket.id, committed: true, turn });
  return { success: true, ticket };
}

for (const [index, message] of input.messages.entries()) {
  const turn = index + 1;
  trace.push({ type: 'user_message', content: message, turn });
  const match = message.match(/\bA\d+\b/);
  if (match) orderId = match[0];
  if (message.includes('售后')) pendingRequest = true;
  let reply;
  if (pendingRequest && !orderId) reply = '请提供订单号，我再为你提交售后申请。';
  else if (pendingRequest && orderId) {
    await submitRequest(orderId, turn);
    reply = `订单 ${orderId} 的售后申请已提交，请等待处理。`;
  } else reply = '请描述你需要处理的售后问题。';
  replies.push(reply);
  trace.push({ type: 'assistant_message', content: reply, turn });
}

process.stdout.write(`${JSON.stringify({ reply: replies.at(-1), replies, trace, state, initialTicketCount, sessionId, targetType: 'deterministic-workflow' })}\n`);
