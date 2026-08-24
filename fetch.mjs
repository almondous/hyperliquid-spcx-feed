const API_URL = "https://api.hyperliquid.xyz/info";
const DEX = "xyz";
const MARKET = "xyz:SPCX";
const SYMBOL = "SPCX";
const TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postInfo(body) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "hyperliquid-spcx-feed/1.0",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        error.status = response.status;
        throw error;
      }

      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      const retryable =
        error?.name === "AbortError" ||
        !error?.status ||
        error.status === 429 ||
        error.status >= 500;

      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(400 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("Hyperliquid request failed");
}

function number(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function gapBps(a, b) {
  return (Math.abs(a - b) / ((a + b) / 2)) * 10_000;
}

const [metaAndContexts, allMids, book] = await Promise.all([
  postInfo({ type: "metaAndAssetCtxs", dex: DEX }),
  postInfo({ type: "allMids", dex: DEX }),
  postInfo({ type: "l2Book", coin: MARKET }),
]);

if (!Array.isArray(metaAndContexts) || metaAndContexts.length !== 2) {
  throw new Error("Unexpected metaAndAssetCtxs response");
}

const [meta, contexts] = metaAndContexts;
const universe = Array.isArray(meta?.universe) ? meta.universe : [];
if (!Array.isArray(contexts) || contexts.length !== universe.length) {
  throw new Error("Universe/context mismatch");
}

const index = universe.findIndex(
  (asset) => asset?.name === MARKET || asset?.name === SYMBOL,
);
if (index < 0) throw new Error(`${MARKET} not found in dex=${DEX}`);

const context = contexts[index];
const mark = number(context?.markPx, "mark price");
const oracle = number(context?.oraclePx, "oracle price");
const funding = number(context?.funding, "funding");
const openInterestCoin = number(context?.openInterest, "open interest");
const volume24hUsd = number(context?.dayNtlVlm, "24h volume");
const previousDayPrice = optionalNumber(context?.prevDayPx);

const bestBid = optionalNumber(book?.levels?.[0]?.[0]?.px);
const bestAsk = optionalNumber(book?.levels?.[1]?.[0]?.px);
const bookMid =
  bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
const mid = number(allMids?.[MARKET] ?? allMids?.[SYMBOL] ?? bookMid, "mid price");

if (mark <= 0 || oracle <= 0 || mid <= 0) throw new Error("Non-positive price");
if (openInterestCoin < 0 || volume24hUsd < 0) throw new Error("Negative OI or volume");
if (gapBps(mark, oracle) > 500) throw new Error("Mark/oracle mismatch");
if (gapBps(mark, mid) > 500) throw new Error("Mark/mid mismatch");
if (bookMid !== null && gapBps(mark, bookMid) > 500) {
  throw new Error("Mark/order-book mismatch");
}
if (bestBid !== null && bestAsk !== null && bestBid > bestAsk) {
  throw new Error("Crossed order book");
}

const now = new Date();
const output = {
  source: "Hyperliquid official Info API",
  market: MARKET,
  fetched_at: now.toISOString(),
  fetched_at_unix_ms: now.getTime(),
  mark_price: mark,
  oracle_price: oracle,
  mid_price: mid,
  best_bid: bestBid,
  best_ask: bestAsk,
  funding_rate_hourly: funding,
  open_interest_usd: openInterestCoin * mark,
  volume_24h_usd: volume24hUsd,
  previous_day_price: previousDayPrice,
  change_24h_percent:
    previousDayPrice && previousDayPrice > 0
      ? (mark / previousDayPrice - 1) * 100
      : null,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
