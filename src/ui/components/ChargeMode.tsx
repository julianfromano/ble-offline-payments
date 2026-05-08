import { useEffect, useRef, useState } from 'react';
import { isNative, BlePeripheral } from '../../ble/peripheral';
import { createPaymentIntent, decodeAck, encodeMessage } from '../../protocol/codec';
import type { Currency, PaymentIntent } from '../../protocol/types';
import {
  HELLO_PROBE,
  aesGcmDecrypt,
  aesGcmEncrypt,
  b64decode,
  b64encode,
  decodeSecureEnvelope,
  deriveSessionKey,
  encodeSecureEnvelope,
  exportPubRaw,
  generateEphemeralKeyPair,
  generatePin,
  generateSalt,
  importPubRaw,
  type BuyerConfirmPayload,
  type SecureEnvelope
} from '../../protocol/secure';
import { applyAck, markStatus, upsertFromIntent, wasSeen } from '../../storage/ledger';
import { logger } from '../logger';

const TE = new TextEncoder();
const TD = new TextDecoder('utf-8', { fatal: true });
const PROBE_BYTES = TE.encode(HELLO_PROBE);

/**
 * "Cobrar" — receiver side, protocol v1.
 *
 * UX changes vs original:
 *  - Shows a single 4-digit decimal code (replaces hex shortId + separate 6-digit PIN).
 *    The same code is used for BLE device name discovery AND channel ECDH key derivation.
 *  - Bilateral confirmation: when the payer sends a buyer_confirm envelope the vendor sees
 *    "Comprador confirmó $Y" before the final ack arrives — no extra user interaction.
 *
 * Protocol flow:
 *   1) Generate ephemeral ECDH P-256 pair + 4-digit code.
 *   2) Advertise hello envelope as BLEPay-${code}.
 *   3) Receive hello_ack → verify probe → derive session key.
 *   4) Publish encrypted sec_intent.
 *   5) Receive buyer_confirm (optional) → show bilateral confirmation.
 *   6) Receive sec_ack → finalize.
 */
export function ChargeMode() {
  const [amount, setAmount] = useState('1500');
  const [currency, setCurrency] = useState<Currency>('ARS');
  const [ttlSec, setTtlSec] = useState('120');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [displayCode, setDisplayCode] = useState<string | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [stage, setStage] = useState<string>('idle');
  const [buyerConfirmedAmount, setBuyerConfirmedAmount] = useState<{
    amount: number; currency: string
  } | null>(null);

  const sessionKeyRef = useRef<CryptoKey | null>(null);
  const pendingIntentRef = useRef<PaymentIntent | null>(null);
  const codeRef = useRef<string | null>(null);
  const currentSaltRef = useRef<Uint8Array | null>(null);
  const currentPrivRef = useRef<CryptoKey | null>(null);
  const nativeListenersRef = useRef<Array<{ remove: () => Promise<void> }>>([]);

  useEffect(() => {
    return () => { cleanupSession().catch(() => undefined); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cleanupSession() {
    const list = nativeListenersRef.current.splice(0);
    await Promise.all(list.map((l) => l.remove().catch(() => undefined)));
    if (isNative()) await BlePeripheral.stopServer().catch(() => undefined);
    sessionKeyRef.current = null;
    codeRef.current = null;
    currentSaltRef.current = null;
    currentPrivRef.current = null;
    pendingIntentRef.current = null;
  }

  async function handleHelloAck(env: SecureEnvelope) {
    if (env.kind !== 'hello_ack') return;
    if (sessionKeyRef.current) { logger.warn('protocol', 'hello_ack repetido ignorado'); return; }
    if (!pendingIntentRef.current) { logger.error('protocol', 'hello_ack sin intent pendiente'); return; }
    const localCode = codeRef.current;
    if (!localCode) { logger.error('protocol', 'hello_ack sin código local'); return; }
    try {
      const payerPub = await importPubRaw(b64decode(env.payer_pub));
      const key = await deriveSessionKey(
        currentPrivRef.current!, payerPub, currentSaltRef.current!, localCode
      );
      const probe = await aesGcmDecrypt(key, b64decode(env.iv), b64decode(env.ct));
      if (probe.byteLength !== PROBE_BYTES.byteLength || !probe.every((v, i) => v === PROBE_BYTES[i])) {
        throw new Error('Probe inválida (código incorrecto o MITM).');
      }
      sessionKeyRef.current = key;
      logger.info('protocol', 'handshake OK — clave de sesión derivada');
      setStage('canal cifrado, publicando intent');

      const intentBytes = encodeMessage(pendingIntentRef.current);
      const { iv, ct } = await aesGcmEncrypt(key, intentBytes);
      const secEnv: SecureEnvelope = { v: 1, kind: 'sec_intent', iv: b64encode(iv), ct: b64encode(ct) };
      await BlePeripheral.updateIntent({ intentBase64: b64encode(encodeSecureEnvelope(secEnv)) });
      await upsertFromIntent(pendingIntentRef.current, 'receiver', 'SENT', 'intent cifrado publicado');
      setStage('esperando confirmación del comprador…');
    } catch (e) {
      const msg = (e as Error).message;
      logger.warn('protocol', `hello_ack rechazado: ${msg}`);
      setStage(`código inválido o MITM (${msg}) — esperando…`);
    }
  }

  async function handleBuyerConfirm(env: SecureEnvelope) {
    if (env.kind !== 'buyer_confirm') return;
    const key = sessionKeyRef.current;
    if (!key) { logger.warn('protocol', 'buyer_confirm antes de tener clave de sesión'); return; }
    try {
      const plain = await aesGcmDecrypt(key, b64decode(env.iv), b64decode(env.ct));
      const payload = JSON.parse(TD.decode(plain)) as BuyerConfirmPayload;
      const pi = pendingIntentRef.current;
      if (!pi || payload.tx_id !== pi.tx_id) {
        logger.warn('protocol', `buyer_confirm para tx desconocido (${payload.tx_id})`);
        return;
      }
      logger.info('protocol', `buyer_confirm: $${payload.amount / 100} ${payload.currency}`);
      setBuyerConfirmedAmount({ amount: payload.amount, currency: payload.currency });
      setStage('comprador confirmó — esperando autorización biométrica…');
    } catch (e) {
      logger.warn('protocol', `buyer_confirm inválido: ${(e as Error).message}`);
    }
  }

  async function handleSecAck(env: SecureEnvelope) {
    if (env.kind !== 'sec_ack') return;
    const key = sessionKeyRef.current;
    if (!key) { logger.warn('protocol', 'sec_ack antes de tener clave de sesión'); return; }
    try {
      const plain = await aesGcmDecrypt(key, b64decode(env.iv), b64decode(env.ct));
      const ack = await decodeAck(plain);
      const pi = pendingIntentRef.current;
      if (!pi || ack.ref_tx_id !== pi.tx_id) {
        logger.warn('protocol', `ack para tx desconocido (${ack.ref_tx_id})`); return;
      }
      if (await wasSeen(ack.tx_id)) {
        logger.warn('protocol', `ack duplicado tx_id=${ack.tx_id}`); return;
      }
      const updated = await applyAck(ack, `ack cifrado: ${ack.result}`);
      logger.info('protocol', `ACK ${ack.result} para ${ack.ref_tx_id}`);
      setStage(updated?.status === 'ACKED' ? 'cobrado ✓' : 'rechazado');
    } catch (e) {
      logger.error('protocol', `sec_ack inválido: ${(e as Error).message}`);
    }
  }

  async function publishNative(pi: PaymentIntent) {
    setStage('verificando soporte BLE peripheral');
    const av = await BlePeripheral.isAvailable();
    if (!av.available) throw new Error(`BLE peripheral no disponible: ${av.reason ?? 'desconocido'}`);

    // 4-digit decimal code: discovery + crypto PIN in one value.
    const kp = await generateEphemeralKeyPair();
    const rPubBytes = await exportPubRaw(kp.publicKey);
    const salt = generateSalt(16);
    const code = generatePin(4);
    codeRef.current = code;
    currentPrivRef.current = kp.privateKey;
    currentSaltRef.current = salt;
    pendingIntentRef.current = pi;
    setDisplayCode(code);
    logger.info('protocol', `sesión código=${code}`);

    const hello: SecureEnvelope = {
      v: 1, kind: 'hello',
      receiver_pub: b64encode(rPubBytes),
      salt: b64encode(salt),
      ts: Date.now()
    };

    nativeListenersRef.current.push(await BlePeripheral.addListener('ack', async (data) => {
      const payload = data as { ackBase64?: string };
      if (!payload?.ackBase64) return;
      try {
        const env = decodeSecureEnvelope(b64decode(payload.ackBase64));
        if (env.kind === 'hello_ack')     await handleHelloAck(env);
        else if (env.kind === 'buyer_confirm') await handleBuyerConfirm(env);
        else if (env.kind === 'sec_ack')   await handleSecAck(env);
        else logger.warn('protocol', `envelope inesperado en ACK: ${env.kind}`);
      } catch (e) {
        logger.error('protocol', `envelope inválido en ACK: ${(e as Error).message}`);
      }
    }));
    nativeListenersRef.current.push(await BlePeripheral.addListener('state', (data) => {
      const s = data as { stage?: string; message?: string };
      if (s?.stage) logger.info('notify', `peripheral: ${s.stage} ${s.message ?? ''}`);
    }));
    nativeListenersRef.current.push(await BlePeripheral.addListener('connection', (data) => {
      const c = data as { connected?: boolean; address?: string };
      logger.info('connect', `central ${c.connected ? 'conectado' : 'desconectado'} ${c.address ?? ''}`);
    }));

    setStage('iniciando advertising');
    await BlePeripheral.startServer({
      intentBase64: b64encode(TE.encode(JSON.stringify(hello))),
      deviceName: `BLEPay-${code}`
    });
    await upsertFromIntent(pi, 'receiver', 'CREATED', 'hello publicado, esperando comprador');
    setStage(`mostrando código ${code} — esperando pagador`);
  }

  async function onPublish() {
    setBusy(true);
    setStage('preparando');
    setDisplayCode(null);
    setIntent(null);
    setBuyerConfirmedAmount(null);
    sessionKeyRef.current = null;
    try {
      if (!isNative()) throw new Error('Modo seguro v1 sólo soportado en APK por ahora.');
      const amt = parseInt(amount, 10);
      const ttl = Math.round(parseFloat(ttlSec) * 1000);
      if (!Number.isInteger(amt) || amt <= 0) throw new Error('Monto inválido.');
      if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('TTL inválido.');
      const pi = await createPaymentIntent({ amount: amt, currency, ttlMs: ttl, memo: memo || undefined });
      setIntent(pi);
      logger.info('protocol', `intent ${pi.tx_id} creado, ${pi.amount} ${pi.currency}`);
      await publishNative(pi);
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('ui', `Cobrar: ${msg}`);
      setStage(`error: ${msg}`);
      if (intent) await markStatus(intent.tx_id, 'FAILED', `error: ${msg}`);
      await cleanupSession();
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    await cleanupSession();
    setDisplayCode(null);
    setBuyerConfirmedAmount(null);
    setStage('cancelado');
  }

  const amountDisplay = intent
    ? `${(intent.amount / 100).toFixed(2)} ${intent.currency}`
    : null;

  return (
    <div className="card">
      <h2>
        Cobrar{' '}
        {isNative()
          ? <span className="muted">(seguro v1 · ECDH+PIN)</span>
          : <span className="muted">(no disponible en PWA)</span>}
      </h2>

      <label htmlFor="amount">Monto (en unidades menores)</label>
      <input
        id="amount" type="number" inputMode="numeric" min={1}
        value={amount} onChange={(e) => setAmount(e.target.value)}
        disabled={busy} aria-describedby="amount-help"
      />
      <p id="amount-help" className="muted">Ej: 1500 = $15,00</p>

      <label htmlFor="currency">Moneda</label>
      <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} disabled={busy}>
        <option value="ARS">ARS</option>
        <option value="USD">USD</option>
        <option value="EUR">EUR</option>
        <option value="BRL">BRL</option>
      </select>

      <label htmlFor="ttl">TTL (segundos)</label>
      <input
        id="ttl" type="number" inputMode="numeric" min={1}
        value={ttlSec} onChange={(e) => setTtlSec(e.target.value)}
        disabled={busy}
      />

      <label htmlFor="memo">Memo (opcional)</label>
      <input
        id="memo" type="text" maxLength={80}
        value={memo} onChange={(e) => setMemo(e.target.value)}
        disabled={busy}
      />

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={onPublish} disabled={busy}>
          {busy ? 'Procesando…' : 'Iniciar cobro'}
        </button>
        <button className="secondary" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
      </div>

      {displayCode && (
        <div
          role="region"
          aria-label="Código de pago para el comprador"
          style={{
            marginTop: 16, padding: 16, borderRadius: 8,
            background: '#0d2c4d', textAlign: 'center'
          }}
        >
          <p className="muted" style={{ margin: 0 }}>
            Mostrá este código al comprador:
          </p>
          <p
            aria-live="polite"
            style={{
              fontSize: 56, fontWeight: 700, letterSpacing: 12,
              margin: '8px 0 4px 0', fontFamily: 'monospace', color: '#7fd1ff'
            }}
          >
            {displayCode}
          </p>
          {amountDisplay && (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {amountDisplay}{memo ? ` — ${memo}` : ''}
            </p>
          )}
        </div>
      )}

      {buyerConfirmedAmount && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            marginTop: 12, padding: 12, borderRadius: 8,
            background: '#0d3a1a', border: '1px solid #2a7a4a', textAlign: 'center'
          }}
        >
          <p style={{ margin: 0, fontWeight: 600, color: '#7fd4a0' }}>
            Comprador confirmó{' '}
            ${(buyerConfirmedAmount.amount / 100).toFixed(2)}{' '}
            {buyerConfirmedAmount.currency}
          </p>
          <p className="muted" style={{ margin: '4px 0 0 0', fontSize: 13 }}>
            Esperando autorización biométrica del comprador…
          </p>
        </div>
      )}

      <p className="muted" aria-live="polite" style={{ marginTop: 12 }}>Estado: {stage}</p>
    </div>
  );
}
