/**
 * POST /api/v1/register
 *
 * Registers a new device. The device submits its public key (generated in the
 * TEE / Secure Enclave on the device, never transmitted as private key).
 *
 * For P1: device_attestation should carry a SafetyNet/Play Integrity token
 * (Android) or DeviceCheck token (iOS). In this P0 implementation the
 * attestation field is accepted but not verified.
 *
 * Returns a short-lived session token used to call /provision and /sync.
 */

import { Router, type Request, type Response } from 'express';
import { db } from '../store';
import { issueSessionToken } from '../crypto';

export const registerRouter = Router();

registerRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const { device_pubkey_b64, platform, device_model, device_attestation } = req.body as {
    device_pubkey_b64?: string;
    platform?: string;
    device_model?: string;
    device_attestation?: string;
  };

  if (!device_pubkey_b64 || typeof device_pubkey_b64 !== 'string') {
    res.status(400).json({ error: 'device_pubkey_b64 requerido' });
    return;
  }
  if (platform !== 'android' && platform !== 'ios' && platform !== 'web') {
    res.status(400).json({ error: 'platform debe ser android, ios o web' });
    return;
  }

  // Idempotent: if the same pubkey re-registers, return the existing user.
  let user = db.getUserByPubkey(device_pubkey_b64);
  if (!user) {
    user = db.createUser({
      device_pubkey_b64,
      platform,
      device_model: device_model ?? 'unknown',
    });
    console.log(`[register] new user ${user.user_id} platform=${platform}`);
  } else {
    console.log(`[register] re-register user ${user.user_id}`);
  }

  // TODO P1: verify device_attestation (SafetyNet / DeviceCheck)
  void device_attestation;

  if (!user.active) {
    res.status(403).json({ error: 'Dispositivo bloqueado por fraude detectado.' });
    return;
  }

  // Issue a session token (1h TTL).
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const token = await issueSessionToken({
    sub: user.user_id,
    exp: expiresAt,
    iat: new Date().toISOString(),
  });

  res.status(201).json({
    user_id: user.user_id,
    registered_at: user.registered_at,
    token,
    expires_at: expiresAt,
  });
});
