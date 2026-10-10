const UPDATE_INTERVAL_MS = 2000;
const WARMUP_MS = 20000;
const EARLY_WARMUP_MS = 10000;
const EARLY_MIN_PROCESSED = 200;
const EARLY_MAX_RATE_RATIO = 1.25;
const EARLY_MAX_TREND_RATIO = 1.1;
const MIN_PROCESSED = 100;
const MIN_SAMPLES = 5;
const MAX_SAMPLES = 10;
const STALE_MS = 10000;

export function createScanEstimator(now = Date.now()) {
  let startedAt = now;
  let previousAt = now;
  let previousCount = 0;
  let startingCount = 0;
  let rates = [];

  return {
    reset(time, count) {
      startedAt = previousAt = time;
      startingCount = previousCount = count;
      rates = [];
    },
    sample(time, count, total) {
      if (time - previousAt >= UPDATE_INTERVAL_MS) {
        rates.push((count - previousCount) / ((time - previousAt) / 1000));
        rates = rates.slice(-MAX_SAMPLES);
        previousAt = time;
        previousCount = count;
      }
      if (time - startedAt < EARLY_WARMUP_MS || count - startingCount < MIN_PROCESSED || rates.length < MIN_SAMPLES) {
        return null;
      }
      const slowest = Math.min(...rates);
      const fastest = Math.max(...rates);
      if (slowest <= 0 || fastest / slowest > 2 || total <= count) {
        return null;
      }
      const early = time - startedAt < WARMUP_MS;
      if (early) {
        // Short observations need stricter consistency and trend checks.
        const split = Math.floor(rates.length / 2);
        const average = (values) => values.reduce((sum, rate) => sum + rate, 0) / values.length;
        const first = average(rates.slice(0, split));
        const last = average(rates.slice(split));
        const trendRatio = Math.max(first, last) / Math.min(first, last);
        const endpointRatio = Math.max(rates[0], rates.at(-1)) / Math.min(rates[0], rates.at(-1));
        if (count - startingCount < EARLY_MIN_PROCESSED || fastest / slowest > EARLY_MAX_RATE_RATIO || trendRatio > EARLY_MAX_TREND_RATIO || endpointRatio > EARLY_MAX_TREND_RATIO) {
          return null;
        }
      }
      // Give an early estimate extra room for changes not yet observed.
      const margin = early ? 0.3 : 0.2;
      return {
        lower: (total - count) / fastest * (1 - margin),
        upper: (total - count) / slowest * (1 + margin)
      };
    }
  };
}

export function formatScanProgress(progress = {}, now = Date.now()) {
  const count = Number.isFinite(progress.processedCount) ? progress.processedCount : 0;
  const total = Number.isFinite(progress.totalCount) ? progress.totalCount : null;
  const prefix = total === null
    ? `${count.toLocaleString()} emails scanned.`
    : `${count.toLocaleString()} of ${total.toLocaleString()} emails scanned.`;
  if (progress.retryUntil > now) {
    return `${prefix} Waiting for Gmail or the connection. Retrying automatically…`;
  }
  if (progress.phase === "counting") {
    return `Counting emails… ${(total || 0).toLocaleString()} found so far.`;
  }
  if (progress.phase === "finishing") {
    return `${prefix} Finishing analysis…`;
  }
  if (!Number.isFinite(progress.updatedAt) || now - progress.updatedAt > STALE_MS) {
    return `${prefix} Updating progress…`;
  }
  const lower = progress.etaLowerSeconds;
  const upper = progress.etaUpperSeconds;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper < lower) {
    return `${prefix} Estimating time remaining…`;
  }
  if (upper < 60) {
    return `${prefix} Estimated time remaining: less than a minute.`;
  }
  const lowMinutes = Math.max(1, Math.floor(lower / 60));
  const highMinutes = Math.max(lowMinutes + 1, Math.ceil(upper / 60));
  return `${prefix} Estimated time remaining: about ${lowMinutes}–${highMinutes} minutes.`;
}
