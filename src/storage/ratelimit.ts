/**
 * Local rate limiter for the payer (buyer) side.
 * Enforces spec P1 limits without requiring a server connection.
 * State is persisted in localStorage and overridden by server-issued tokens in P1+.
 */

const KEY = 'blepay_rl';

interface State {
  total_spent: number;      // centavos spent in the current offline session
  last_tx_ts: number;       // epoch ms of last completed transaction
  tx_in_hour: number;       // transactions completed in the current hour window
  hour_start: number;       // epoch ms when the current hour window began
}

export const RATE_LIMITS = {
  MAX_TOTAL_OFFLINE: 5_000_000, // $50,000 in centavos
  MAX_PER_TX:        2_000_000, // $20,000 in centavos
  MAX_PER_HOUR:      5,
  MIN_INTERVAL_MS:   30_000,    // 30 seconds
};

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch { /* ignore */ }
  return { total_spent: 0, last_tx_ts: 0, tx_in_hour: 0, hour_start: Date.now() };
}

function save(s: State): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** Throws a human-readable error if the transaction would exceed any local limit. */
export function checkRateLimit(amount: number): void {
  const now = Date.now();
  const s = load();

  if (amount > RATE_LIMITS.MAX_PER_TX) {
    const limit = (RATE_LIMITS.MAX_PER_TX / 100).toLocaleString();
    throw new Error(`Monto supera el límite por transacción ($${limit}).`);
  }

  if (s.last_tx_ts > 0) {
    const elapsed = now - s.last_tx_ts;
    if (elapsed < RATE_LIMITS.MIN_INTERVAL_MS) {
      const waitSec = Math.ceil((RATE_LIMITS.MIN_INTERVAL_MS - elapsed) / 1000);
      throw new Error(`Esperá ${waitSec}s antes de la próxima transacción.`);
    }
  }

  const newHour = (now - s.hour_start) >= 3_600_000;
  if (!newHour && s.tx_in_hour >= RATE_LIMITS.MAX_PER_HOUR) {
    throw new Error(`Límite de ${RATE_LIMITS.MAX_PER_HOUR} transacciones por hora alcanzado.`);
  }

  if (s.total_spent + amount > RATE_LIMITS.MAX_TOTAL_OFFLINE) {
    const limit = (RATE_LIMITS.MAX_TOTAL_OFFLINE / 100).toLocaleString();
    throw new Error(`Límite total offline ($${limit}) alcanzado — sincronizá con el servidor.`);
  }
}

/** Call after a transaction is confirmed (sec_ack OK sent). */
export function recordTransaction(amount: number): void {
  const now = Date.now();
  const s = load();
  const newHour = (now - s.hour_start) >= 3_600_000;
  save({
    total_spent: s.total_spent + amount,
    last_tx_ts: now,
    tx_in_hour: newHour ? 1 : s.tx_in_hour + 1,
    hour_start: newHour ? now : s.hour_start,
  });
}

/** Reset after receiving a fresh server-issued offline token (provision). */
export function resetRateLimit(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
