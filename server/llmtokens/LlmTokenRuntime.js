// FLEET3 (#38): 15 s sampling timer, periodic saves and the HTTP surface of
// the token ledger. Clean-room from the issue spec. MIT.
import { TOKEN_RANGES } from "./LlmTokenLedger.js";

export const TOKEN_SAMPLE_INTERVAL_MS = 15_000;
export const TOKEN_SAVE_INTERVAL_MS = 60_000;
export const TOKEN_WIPE_CONFIRMATION = "delete-token-totals";

export function createLlmTokenRuntime({
  ledger,
  collect,
  now = Date.now,
  intervalMs = TOKEN_SAMPLE_INTERVAL_MS,
  saveEveryMs = TOKEN_SAVE_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logError = console.error,
}) {
  let timer = null;
  let stopped = false;
  let lastSaveMs = now();

  const sample = () => {
    if (stopped) return;
    try {
      const atMs = now();
      ledger.observe(collect(atMs), atMs);
      if (atMs - lastSaveMs >= saveEveryMs) {
        ledger.save();
        lastSaveMs = atMs;
      }
    } catch (err) {
      try { logError("llm token sample error", err); } catch { /* never block sampling */ }
    }
  };

  return {
    sample,
    start() {
      if (timer !== null || stopped) return false;
      sample();
      timer = setIntervalFn(sample, intervalMs);
      timer?.unref?.();
      return true;
    },
    stop() {
      if (stopped) return true;
      stopped = true;
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
      return ledger.save();
    },
  };
}

function rangeOf(req, res) {
  const range = req.query?.range ?? "24h";
  if (!TOKEN_RANGES.includes(range)) {
    res.status(400).json({ error: `range must be one of ${TOKEN_RANGES.join(", ")}` });
    return null;
  }
  return range;
}

/** GET /api/llm-token-totals?range=, GET …/history?range=, DELETE …?confirm= */
export function registerLlmTokenRoutes(app, ledger) {
  app.get("/api/llm-token-totals/history", (req, res) => {
    const range = rangeOf(req, res);
    if (range) res.json(ledger.history(range));
  });
  app.get("/api/llm-token-totals", (req, res) => {
    const range = rangeOf(req, res);
    if (range) res.json(ledger.totals(range));
  });
  app.delete("/api/llm-token-totals", (req, res) => {
    if (req.query?.confirm !== TOKEN_WIPE_CONFIRMATION) {
      res.status(400).json({ error: `clearing the token ledger requires confirm=${TOKEN_WIPE_CONFIRMATION}` });
      return;
    }
    ledger.clear();
    res.json({ cleared: true });
  });
  return app;
}

/**
 * Fleet energy Wh/token from the ledger (FLEET3): the energy tracker only
 * counts output tokens of a single SSH Spark head; the ledger covers every
 * endpoint. Uses the ledger's 24 h generated total when it has one.
 */
export function withLedgerTokens(view, ledgerTotals24h) {
  const tokens = ledgerTotals24h?.generated ?? 0;
  if (!view || !(tokens > 0) || view.energy24hKwh == null || !Number.isFinite(view.energy24hKwh)) return view;
  return {
    ...view,
    outputTokens24h: tokens,
    whPerOutputToken24h: (view.energy24hKwh * 1000) / tokens,
    tokenSource: "ledger",
  };
}
