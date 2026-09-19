const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame?.type === 'request' && frame.method === 'example.ping.v1') process.stdout.write(`${JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { success: true } })}\n`);
});
process.stdout.write('{"type":"ready","protocolVersion":1}\n');
