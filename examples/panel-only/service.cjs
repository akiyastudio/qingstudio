const readline = require('readline');

const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type !== 'request' || frame.method !== 'panel-example.inspect.v1') return;
  send({
    type: 'response',
    id: frame.id,
    ok: true,
    result: {
      projectId: frame.context.projectId,
      projectName: frame.context.projectName,
      contributionId: frame.context.contributionId,
    },
  });
});

send({ type: 'ready', protocolVersion: 1 });
