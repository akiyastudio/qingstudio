// Drain in-flight work before returning an error so callers can safely roll back.
const mapBounded = async (items, concurrency, visit) => {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  const worker = async () => {
    while (!failure) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await visit(items[index], index); }
      catch (error) { failure ||= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, worker));
  if (failure) throw failure;
  return results;
};

// Remove acyclic name dependencies in reverse order. Only cycles (including
// case-only changes on Windows) need the two-stage temporary-name protocol.
const partitionRenames = (moves, key) => {
  const remaining = new Map(moves.map(move => [key(move.source), move]));
  const predecessor = new Map(moves.map(move => [key(move.destination), move]));
  const direct = [];
  let ready = moves.filter(move => !remaining.has(key(move.destination)));
  const layers = [];
  while (ready.length) {
    layers.push(ready); direct.push(...ready);
    for (const move of ready) remaining.delete(key(move.source));
    const next = [];
    for (const move of ready) {
      const prior = predecessor.get(key(move.source));
      if (prior && remaining.has(key(prior.source))) next.push(prior);
    }
    ready = next;
  }
  return { direct, layers, staged: [...remaining.values()] };
};

const createPlanCopyPipeline = (copyBatch, batchSize = 256) => {
  let pending = [];
  let running = Promise.resolve();
  let gate = Promise.resolve();
  let failure;
  const flush = () => {
    const next = gate.then(async () => {
      await running;
      if (failure) throw failure;
      if (!pending.length) return;
      const batch = pending; pending = [];
      running = Promise.resolve().then(() => copyBatch(batch)).catch(error => { failure = error; });
    });
    gate = next.catch(() => undefined);
    return next;
  };
  return {
    push: async entry => {
      if (failure) throw failure;
      pending.push({ ...entry, sourceIdentity: { ...entry.sourceIdentity } });
      if (pending.length >= batchSize) await flush();
    },
    close: async () => { await flush(); await running; if (failure) throw failure; },
    drain: async () => { await gate; await running; },
  };
};

module.exports = { mapBounded, partitionRenames, createPlanCopyPipeline };
