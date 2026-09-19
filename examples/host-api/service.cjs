const readline = require('readline'); const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => { const frame = JSON.parse(line); if (frame.type === 'request' && frame.method === 'example.run.v1') send({ type: 'response', id: frame.id, ok: true, result: { contributionId: frame.context.contributionId || '', selectionCount: frame.context.selectedRelativePaths?.length || 0 } }); });
send({ type: 'ready', protocolVersion: 1 });
