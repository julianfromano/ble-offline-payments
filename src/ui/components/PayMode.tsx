import { useEffect, useRef, useState } from 'react';
import { BleCentral } from '../../ble/central';
import { isNative } from '../../ble/peripheral';
import { createAck, decodeIntent, encodeMessage, isExpired } from '../../protocol/codec';
import type { PaymentIntent } from '../../protocol/types';
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
  importPubRaw,
  type BuyerConfirmPayload,
  type SecureEnvelope,
  type SecureHello
} from '../../protocol/secure';
import { applyAck, markStatus, upsertFromIntent, wasSeen } from '../../storage/ledger';
import { checkRateLimit, recordTransaction } from '../../storage/ratelimit';
import { logger } from '../logger';

const TE = new TextEncoder();
const PROBE_BYTES = TE.encode(HELLO_PROBE);

/**
 * "Pagar" — payer side, protocol v1.
 *
 * UX changes vs original:
 *  - Discovery by 4-digit code: user types the code shown on the vendor's screen.
 *    The app scans in the background and auto-connects to the first device named
 *    BLEPay-${code}. No RSSI list or manual stall selection.
 *  - Bilateral confirmation: after decrypting the sec_intent, the app automatically
 *    sends a buyer_confirm envelope so the vendor sees "Comprador confirmó $Y" before
 *    the final ack. No extra user interaction.
 *  - Rate limiting: enforced locally before sending the final sec_ack.
 *
 * Protocol flow:
 *   1) User enters 4-digit code.
 *   2) App scans; on finding BLEPay-${code} auto-connects.
 *   3) Read INTENT → hello. Derive session key with code as PIN.
 *   4) Send hello_ack (with ECDH pub + probe cipher).
 *   5) Receive sec_intent → check rate limit → send buyer_confirm → show confirm UI.
 *   6) User taps confirm → send sec_ack → record transaction.
 */
export function PayMode() {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string>('idle');
  const [scanning, setScanning] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [buyerConfirmSent, setBuyerConfirmSent] = useState(false);

  const helloRef = useRef<SecureHello | null>(null);
  const myKpRef = useRef<{ publicKey: CryptoKey; privateKey: CryptoKey } | null>(null);
  const sessionKeyRef = useRef<CryptoKey | null>(null);
  const codeRef = useRef<string>('');
  const nativeListenersRef = useRef<Array<{ remove: () => Promise<void> }>>([]);
  const nativeConnectedRef = useRef<boolean>(false);
  const foundAndConnecting = useRef<boolean>(false);

  useEffect(() => {
    return () => { cleanup().catch(() => undefined); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cleanup() {
    const list = nativeListenersRef.current.splice(0);
    await Promise.all(list.map((l) => l.remove().catch(() => undefined)));
    if (isNative()) {
      await BleCentral.stopScan().catch(() => undefined);
      if (nativeConnectedRef.current) {
        await BleCentral.disconnect().catch(() => undefined);
        nativeConnectedRef.current = false;
      }
    }
    sessionKeyRef.current = null;
    helloRef.current = null;
    myKpRef.current = null;
    codeRef.current = '';
    foundAndConnecting.current = false;
  }

  async function sendBuyerConfirm(pi: PaymentIntent, key: CryptoKey) {
    const payload: BuyerConfirmPayload = {
      tx_id: pi.tx_id,
      amount: pi.amount,
      currency: pi.currency,
      ts: Date.now(),
    };
    const plain = TE.encode(JSON.stringify(payload));
    const { iv, ct } = await aesGcmEncrypt(key, plain);
    const env: SecureEnvelope = { v: 1, kind: 'buyer_confirm', iv: b64encode(iv), ct: b64encode(ct) };
    await BleCentral.writeAck({ ackBase64: b64encode(encodeSecureEnvelope(env)) });
    logger.info('protocol', `buyer_confirm enviado: $${pi.amount / 100} ${pi.currency}`);
    setBuyerConfirmSent(true);
  }

  async function onIntentUpdate(bytes: Uint8Array) {
    try {
      const env = decodeSecureEnvelope(bytes);
      if (env.kind !== 'sec_intent') {
        logger.debug('protocol', `intent_update kind=${env.kind} ignorado`);
        return;
      }
      const key = sessionKeyRef.current;
      if (!key) { logger.warn('protocol', 'sec_intent sin clave de sesión'); return; }

      const plain = await aesGcmDecrypt(key, b64decode(env.iv), b64decode(env.ct));
      const pi = await decodeIntent(plain);

      if (await wasSeen(pi.tx_id)) throw new Error(`tx_id repetido (${pi.tx_id}).`);
      if (isExpired(pi)) {
        await upsertFromIntent(pi, 'payer', 'CREATED', 'intent recibido pero expirado');
        await markStatus(pi.tx_id, 'EXPIRED', 'TTL vencido al recibir');
        throw new Error('Intent expirado.');
      }

      // Check rate limits before committing to this transaction.
      checkRateLimit(pi.amount);

      await upsertFromIntent(pi, 'payer', 'CREATED', 'intent cifrado leído');

      // Bilateral confirmation: auto-send before showing confirm UI.
      await sendBuyerConfirm(pi, key);

      setIntent(pi);
      setStage('listo para confirmar');
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('protocol', `sec_intent inválido: ${msg}`);
      setStage(`error: ${msg}`);
    }
  }

  async function connectToVendor(address: string) {
    if (foundAndConnecting.current) return;
    foundAndConnecting.current = true;
    setBusy(true);
    setStage(`conectando a BLEPay-${codeRef.current}…`);
    try {
      setScanning(false);
      await BleCentral.stopScan().catch(() => undefined);

      const res = await BleCentral.connectByAddress({ address });
      nativeConnectedRef.current = true;

      const env = decodeSecureEnvelope(b64decode(res.intentBase64));
      if (env.kind !== 'hello') throw new Error(`Esperaba kind=hello, vino ${env.kind}`);
      helloRef.current = env;

      const kp = await generateEphemeralKeyPair();
      myKpRef.current = kp;
      const receiverPub = await importPubRaw(b64decode(env.receiver_pub));
      const salt = b64decode(env.salt);
      const key = await deriveSessionKey(kp.privateKey, receiverPub, salt, codeRef.current);
      sessionKeyRef.current = key;

      const myPubBytes = await exportPubRaw(kp.publicKey);
      const { iv, ct } = await aesGcmEncrypt(key, PROBE_BYTES);
      const helloAck: SecureEnvelope = {
        v: 1, kind: 'hello_ack',
        payer_pub: b64encode(myPubBytes),
        iv: b64encode(iv),
        ct: b64encode(ct)
      };
      await BleCentral.writeAck({ ackBase64: b64encode(encodeSecureEnvelope(helloAck)) });
      setStage('handshake enviado, esperando intent cifrado…');
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('ui', `Pagar(connect): ${msg}`);
      setStage(`error: ${msg}`);
      sessionKeyRef.current = null;
      foundAndConnecting.current = false;
      if (nativeConnectedRef.current) {
        await BleCentral.disconnect().catch(() => undefined);
        nativeConnectedRef.current = false;
      }
    } finally {
      setBusy(false);
    }
  }

  async function startDiscovery() {
    if (!isNative()) { setStage('Modo seguro v1 sólo soportado en APK por ahora.'); return; }
    if (!/^\d{4}$/.test(codeInput)) { setStage('Ingresá el código de 4 dígitos del vendedor.'); return; }

    setBusy(true);
    setStage('iniciando escaneo');
    setIntent(null);
    setBuyerConfirmSent(false);
    sessionKeyRef.current = null;
    foundAndConnecting.current = false;
    codeRef.current = codeInput;

    try {
      const av = await BleCentral.isAvailable();
      if (!av.available) throw new Error(`BLE central no disponible: ${av.reason ?? 'desconocido'}`);

      const targetName = `BLEPay-${codeInput}`;

      if (nativeListenersRef.current.length === 0) {
        const stateL = await BleCentral.addListener('state', (data) => {
          const s = data as { stage?: string; message?: string };
          if (s?.stage) logger.info('notify', `central: ${s.stage} ${s.message ?? ''}`);
        });
        const updateL = await BleCentral.addListener('intent_update', (data) => {
          const payload = data as { intentBase64?: string };
          if (!payload?.intentBase64) return;
          void onIntentUpdate(b64decode(payload.intentBase64));
        });
        // Auto-connect when we find the device matching the entered code.
        const scanL = await BleCentral.addListener('scan_result', (data) => {
          const r = data as { address?: string; name?: string; rssi?: number };
          if (!r?.address || !r.name) return;
          if (r.name === targetName && !foundAndConnecting.current) {
            logger.info('scan', `encontrado ${targetName} en ${r.address}`);
            void connectToVendor(r.address);
          }
        });
        nativeListenersRef.current.push(stateL, updateL, scanL);
      }

      setScanning(true);
      void BleCentral.scanList({ timeoutMs: 60_000 }).then((res) => {
        if (res.reason === 'timeout' && !foundAndConnecting.current) {
          setScanning(false);
          setStage(`código ${codeInput} no encontrado — ¿el vendedor tiene el cobro activo?`);
        }
      }).catch((e: unknown) => {
        setScanning(false);
        setStage(`error scan: ${(e as Error).message}`);
      });

      setStage(`buscando BLEPay-${codeInput}…`);
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('ui', `Pagar(scan): ${msg}`);
      setStage(`error: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(result: 'OK' | 'REJECT') {
    if (!intent) return;
    const key = sessionKeyRef.current;
    if (!key) { setStage('error: sin clave de sesión'); return; }
    setBusy(true);
    setStage(result === 'OK' ? 'pagando…' : 'rechazando…');
    try {
      if (result === 'OK') checkRateLimit(intent.amount);
      const ack = await createAck(intent, result, result === 'REJECT' ? 'usuario rechazó' : undefined);
      const ackBytes = encodeMessage(ack);
      const { iv, ct } = await aesGcmEncrypt(key, ackBytes);
      const env: SecureEnvelope = { v: 1, kind: 'sec_ack', iv: b64encode(iv), ct: b64encode(ct) };
      await BleCentral.writeAck({ ackBase64: b64encode(encodeSecureEnvelope(env)) });
      await applyAck(ack, `ack cifrado: ${result}`);
      if (result === 'OK') recordTransaction(intent.amount);
      setStage(result === 'OK' ? 'pagado ✓' : 'rechazado');
      logger.info('protocol', `ACK ${result} enviado para ${intent.tx_id}`);
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('ui', `Pagar(confirm): ${msg}`);
      await markStatus(intent.tx_id, 'FAILED', `error al enviar ack: ${msg}`);
      setStage(`error: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    await cleanup();
    setIntent(null);
    setCodeInput('');
    setBuyerConfirmSent(false);
    setScanning(false);
    setStage('cancelado');
  }

  return (
    <div className="card">
      <h2>
        Pagar{' '}
        {isNative()
          ? <span className="muted">(seguro v1 · ECDH+PIN)</span>
          : <span className="muted">(no disponible en PWA)</span>}
      </h2>
      <p className="muted">
        El vendedor muestra un <strong>código de 4 dígitos</strong>. Ingresalo y
        tocá Conectar — la app te conecta automáticamente al puesto correcto.
      </p>

      <label htmlFor="code-input">Código del vendedor</label>
      <input
        id="code-input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={codeInput}
        maxLength={4}
        onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ''))}
        disabled={busy || !!intent || scanning}
        aria-describedby="code-help"
        style={{ fontSize: 32, letterSpacing: 8, fontFamily: 'monospace', textAlign: 'center' }}
      />
      <p id="code-help" className="muted">4 dígitos (ej: 4823)</p>

      <div className="row">
        <button
          className="primary"
          onClick={startDiscovery}
          disabled={busy || scanning || !!intent || codeInput.length !== 4}
        >
          {scanning ? `Buscando BLEPay-${codeInput}…` : 'Conectar'}
        </button>
        <button className="secondary" onClick={onCancel} disabled={busy && !scanning}>
          Cancelar
        </button>
      </div>

      {intent && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              padding: 16, borderRadius: 8, background: '#1a2c44',
              textAlign: 'center', marginBottom: 12
            }}
          >
            <p style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>
              ${(intent.amount / 100).toFixed(2)}{' '}
              <span style={{ fontSize: 18, color: '#7fd1ff' }}>{intent.currency}</span>
            </p>
            {intent.memo && <p className="muted" style={{ margin: '4px 0 0 0' }}>{intent.memo}</p>}
            <p className="muted" style={{ margin: '8px 0 0 0', fontSize: 12 }}>
              tx: {intent.tx_id.slice(0, 8)}…
            </p>
          </div>

          {buyerConfirmSent && (
            <p className="muted" style={{ textAlign: 'center', fontSize: 13, marginBottom: 8 }}>
              Confirmación enviada al vendedor ✓
            </p>
          )}

          <div className="row">
            <button className="primary" onClick={() => onConfirm('OK')} disabled={busy}>
              Confirmar pago
            </button>
            <button className="secondary" onClick={() => onConfirm('REJECT')} disabled={busy}>
              Rechazar
            </button>
          </div>
        </div>
      )}

      <p className="muted" aria-live="polite" style={{ marginTop: 12 }}>Estado: {stage}</p>
    </div>
  );
}
