/**
 * POST /api/v1/provision
 * Auth: Bearer session token
 *
 * Issues (or refreshes) an OfflineToken for the authenticated user.
 * The token encodes the user's offline spending limit and is signed by the
 * server's Ed25519 key. Devices verify the signature offline.
 *
 * TTL: 24 hours. After expiry the device must reconnect to renew.
 * Revoking a previous device token is done by tracking token_id server-side;
 * the old token still validates locally until TTL but the server rejects
 * its tx_ids during sync (detects double-spend or stale token).
 */

import { Router, type Request, type Response } from 'express';
import { webcrypto } from 'node:crypto';
import { db, type OfflineToken } from '../store';
import { serverSign, canonicalBytes, sha256Hex } from '../crypto';

const DEFAULT_BALANCE = 5_000_000;   // $50,000 ARS in centavos
const TOKEN_TTL_MS    = 24 * 3_600_000;

export const provisionRouter = Router();

provisionRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const userPayload = (req as Request & { user?: Record<string, unknown> }).user;
  if (!userPayload?.sub) { res.status(401).json({ error: 'No autenticado.' }); return; }

  const user_id = userPayload.sub as string;
  const user = db.getUser(user_id);
  if (!user) { res.status(404).json({ error: 'Usuario no encontrado.' }); return; }
  if (!user.active) { res.status(403).json({ error: 'Dispositivo bloqueado.' }); return; }

  const { requested_balance, currency = 'ARS' } = req.body as {
    requested_balance?: number;
    currency?: string;
  };

  // Clamp requested balance to server-configured limit.
  const balance = Math.min(
    Number.isInteger(requested_balance) && (requested_balance as number) > 0
      ? (requested_balance as number)
      : DEFAULT_BALANCE,
    DEFAULT_BALANCE
  );

  // chain_hash seeds from the previous token or a fresh random value.
  const prevToken = db.getCurrentToken(user_id);
  const prevHash = prevToken
    ? await sha256Hex(canonicalBytes(prevToken))
    : Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex');

  const now = Date.now();
  const tokenPayload = {
    token_id: webcrypto.randomUUID(),
    user_id,
    balance,
    currency,
    chain_hash: prevHash,
    max_per_tx:       2_000_000,   // $20,000
    max_per_hour:     5,
    min_interval_ms:  30_000,
    valid_until: new Date(now + TOKEN_TTL_MS).toISOString(),
    issued_at: new Date(now).toISOString(),
  };

  const sig = await serverSign(canonicalBytes(tokenPayload));
  const token: OfflineToken = { ...tokenPayload, server_sig: sig };
  db.saveToken(token);

  console.log(`[provision] user=${user_id} balance=${balance} token=${token.token_id}`);
  res.json({ offline_token: token });
});
