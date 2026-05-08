import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { getServerKeyPair, decodeSessionToken } from './crypto';
import { registerRouter } from './routes/register';
import { provisionRouter } from './routes/provision';
import { syncRouter } from './routes/sync';
import { blacklistRouter } from './routes/blacklist';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

app.use(cors());
app.use(express.json({ limit: '256kb' }));

// ---- Auth middleware (attached to req for downstream routes) ---------------
app.use((req: Request, _res: Response, next: NextFunction) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const payload = decodeSessionToken(token);
    if (payload) (req as Request & { user?: Record<string, unknown> }).user = payload;
  }
  next();
});

// ---- Routes ----------------------------------------------------------------
app.use('/api/v1/register', registerRouter);
app.use('/api/v1/provision', provisionRouter);
app.use('/api/v1/sync', syncRouter);
app.use('/api/v1/blacklist', blacklistRouter);

// ---- Health ----------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---- Server public key (clients use this to verify offline tokens) ---------
app.get('/api/v1/pubkey', async (_req, res) => {
  const kp = await getServerKeyPair();
  res.json({ pubkey_b64: kp.publicKeyB64, algorithm: 'Ed25519' });
});

// ---- Error handler ---------------------------------------------------------
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : 'Internal server error';
  console.error('[error]', msg);
  res.status(500).json({ error: msg });
});

app.listen(PORT, () => {
  console.log(`BLEPay server listening on http://localhost:${PORT}`);
});
