// Compare normalized batch cost only within a volume pair and size class.
// Keep the established 8-worker setting unless repeated samples show a gain.
const createCopyConcurrencyTuner = () => {
  const profiles = new Map();
  const profile = key => {
    if (!profiles.has(key)) {
      if (profiles.size >= 64) profiles.delete(profiles.keys().next().value);
      profiles.set(key, { samples: new Map([[8, []], [4, []], [2, []]]) });
    }
    return profiles.get(key);
  };
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return {
    choose: (key, count) => {
      if (count < 64) return 8;
      const { samples } = profile(key);
      for (const degree of [8, 4, 2]) if (samples.get(degree).length < 3) return degree;
      const baseline = median(samples.get(8));
      const best = [8, 4, 2].sort((a, b) => median(samples.get(a)) - median(samples.get(b)))[0];
      return median(samples.get(best)) < baseline * 0.9 ? best : 8;
    },
    observe: (key, degree, count, milliseconds) => {
      if (count < 64 || ![2, 4, 8].includes(degree) || !Number.isFinite(milliseconds) || milliseconds <= 0) return;
      const samples = profile(key).samples.get(degree);
      samples.push(milliseconds / count);
      if (samples.length > 9) samples.shift();
    },
  };
};
module.exports = { createCopyConcurrencyTuner, copyConcurrencyTuner: createCopyConcurrencyTuner() };
