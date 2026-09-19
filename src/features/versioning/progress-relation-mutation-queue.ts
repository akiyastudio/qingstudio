export class ProgressRelationMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private disposed = false;
  private generation = 0;

  isPending(childId: string) {
    return !this.disposed && this.tails.has(childId);
  }

  captureGeneration() {
    return this.generation;
  }

  isGenerationCurrent(generation: number) {
    return !this.disposed && generation === this.generation;
  }

  runIfCurrent(generation: number, callback: () => void) {
    if (!this.isGenerationCurrent(generation)) return false;
    callback();
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.tails.clear();
  }

  enqueue<T>(childId: string, operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('progress_relation_mutation_queue_disposed'));
    const generation = this.generation;
    const previous = this.tails.get(childId) || Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => {
      if (!this.isGenerationCurrent(generation)) throw new Error('progress_relation_mutation_queue_disposed');
      const value = await operation();
      if (!this.isGenerationCurrent(generation)) throw new Error('progress_relation_mutation_queue_disposed');
      return value;
    });
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(childId, tail);
    void tail.finally(() => {
      if (this.isGenerationCurrent(generation) && this.tails.get(childId) === tail) this.tails.delete(childId);
    });
    return result;
  }
}
