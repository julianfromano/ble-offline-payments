/**
 * GET /api/v1/blacklist
 *
 * Returns the current list of blocked user_ids.
 * In P1 this will be replaced by a Bloom Filter (1 KB for 10,000 users,
 * ~1% false positive rate) for efficient offline lookups.
 * For P0 we return a plain JSON array and let the client store it locally.
 */

import { Router, type Request, type Response } from 'express';
import { db } from '../store';

export const blacklistRouter = Router();

blacklistRouter.get('/', (_req: Request, res: Response): void => {
  res.json({
    users: db.getBlacklist(),
    updated_at: new Date().toISOString(),
    format: 'plain',          // 'bloom' in P1
    false_positive_rate: 0,   // exact list in P0
  });
});
