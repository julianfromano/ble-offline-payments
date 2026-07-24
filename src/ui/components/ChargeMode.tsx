import { useEffect, useRef, useState } from 'react';
import { isNative, BlePeripheral } from '../../ble/peripheral';
import { createPaymentIntent, decodeAck, encodeMessage } from '../../protocol/codec';
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
  generatePin,
  generateSalt,
  importPubRaw,
  type BuyerConfirmPayload,
  type SecureEnvelope
} from '../../protocol/secure';
import { applyAck, markStatus, upsertFromIntent, wasSeen } from '../../storage/ledger';
import { logger } from '../logger';
import { formatAmount, parseAmountToMinor } from '../format';
import { BhAlert, BhButton, BhTextField } from '../bh';
import successImg from '../bh/assets/success.svg';

const TE = new TextEncoder();
const TD = new TextDecoder('utf-8', { fatal: true });
const PROBE_BYTES = TE.encode(HELLO_PROBE);

const CURRENCY = 'ARS';
const TTL_MS = 5 * 60_000; // ventana de validez del cobro (5 min, cómoda para demo)

type Phase = 'form' | 'waiting' | 'confirmed' | 'done' | 'error';

/**
 * "Cobrar" — receiver side, protocol v1.
 *
 * Flujo de protocolo (sin cambios):
 *   1) Par ECDH P-256 efímero + código de 4 dígitos.
 *   2) Advertising del hello como BLEPay-${code}.
 *   3) hello_ack → verificar probe → derivar clave de sesión.
 *   4) Publicar sec_intent cifrado.
 *   5) buyer_confirm → confirmación bilateral en pantalla.
 *   6) sec_ack → finalizar.
 */
export function ChargeMode() {
  const [amountInput, setAmountInput] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [displayCode, setDisplayCode] = useState<string | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');
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
      setStatusText('Comprador conectado — conexión segura establecida');

      const intentBytes = encodeMessage(pendingIntentRef.current);
      const { iv, ct } = await aesGcmEncrypt(key, intentBytes);
      const secEnv: SecureEnvelope = { v: 1, kind: 'sec_intent', iv: b64encode(iv), ct: b64encode(ct) };
      await BlePeripheral.updateIntent({ intentBase64: b64encode(encodeSecureEnvelope(secEnv)) });
      await upsertFromIntent(pendingIntentRef.current, 'receiver', 'SENT', 'intent cifrado publicado');
      setStatusText('Esperando que el comprador vea el monto…');
    } catch (e) {
      const msg = (e as Error).message;
      logger.warn('protocol', `hello_ack rechazado: ${msg}`);
      setStatusText('El código ingresado no coincide — esperando otro intento…');
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
      setPhase('confirmed');
      setStatusText('El comprador ve el monto — falta su confirmación final');
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
      if (updated?.status === 'ACKED') {
        setPhase('done');
        setStatusText('');
      } else {
        setErrorText('El comprador rechazó el pago.');
        setPhase('error');
      }
    } catch (e) {
      logger.error('protocol', `sec_ack inválido: ${(e as Error).message}`);
    }
  }

  async function publishNative(pi: PaymentIntent) {
    setStatusText('Activando Bluetooth…');
    const av = await BlePeripheral.isAvailable();
    if (!av.available) throw new Error(`Bluetooth no disponible: ${av.reason ?? 'desconocido'}`);

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

    await BlePeripheral.startServer({
      intentBase64: b64encode(TE.encode(JSON.stringify(hello))),
      deviceName: `BLEPay-${code}`
    });
    await upsertFromIntent(pi, 'receiver', 'CREATED', 'hello publicado, esperando comprador');
    setPhase('waiting');
    setStatusText('Esperando al comprador…');
  }

  async function onPublish() {
    setBusy(true);
    setErrorText('');
    setDisplayCode(null);
    setIntent(null);
    setBuyerConfirmedAmount(null);
    sessionKeyRef.current = null;
    try {
      if (!isNative()) throw new Error('Cobrar por Bluetooth funciona desde la app instalada en el celular.');
      const amt = parseAmountToMinor(amountInput);
      if (amt === null) throw new Error('Ingresá un monto válido, por ejemplo 1500 o 1500,50.');
      const pi = await createPaymentIntent({
        amount: amt, currency: CURRENCY, ttlMs: TTL_MS, memo: memo || undefined
      });
      setIntent(pi);
      logger.info('protocol', `intent ${pi.tx_id} creado, ${pi.amount} ${pi.currency}`);
      await publishNative(pi);
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('ui', `Cobrar: ${msg}`);
      setErrorText(msg);
      setPhase('error');
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
    setErrorText('');
    setPhase('form');
    setStatusText('');
  }

  async function onNewCharge() {
    await onCancel();
    setAmountInput('');
    setMemo('');
  }

  // ── Pantalla de éxito ──────────────────────────────────────────────────────
  if (phase === 'done' && intent) {
    return (
      <div className="bh-card result-screen">
        <img src={successImg} alt="" className="result-img" />
        <h2 className="result-title">¡Cobro acreditado!</h2>
        <p className="result-amount">{formatAmount(intent.amount, intent.currency)}</p>
        {intent.memo && <p className="muted">{intent.memo}</p>}
        <p className="muted">El comprobante quedó guardado en ambos celulares.</p>
        <BhButton onClick={onNewCharge}>Nuevo cobro</BhButton>
      </div>
    );
  }

  // ── Cobro activo: código en pantalla ──────────────────────────────────────
  if ((phase === 'waiting' || phase === 'confirmed') && displayCode && intent) {
    return (
      <div className="bh-card">
        <div className="code-panel" role="region" aria-label="Código de pago para el comprador">
          <p className="code-panel__hint">Decile este código al comprador</p>
          <p className="code-panel__code" aria-live="polite">{displayCode}</p>
          <p className="code-panel__amount">
            {formatAmount(intent.amount, intent.currency)}
            {intent.memo ? ` · ${intent.memo}` : ''}
          </p>
        </div>

        {phase === 'confirmed' && buyerConfirmedAmount ? (
          <BhAlert
            severity="success"
            title={`El comprador confirmó ${formatAmount(buyerConfirmedAmount.amount, buyerConfirmedAmount.currency)}`}
            description="Falta su autorización final en el otro celular."
          />
        ) : (
          <p className="status-line" aria-live="polite">
            <span className="pulse-dot" aria-hidden="true" />
            {statusText}
          </p>
        )}

        <div className="actions-row">
          <BhButton variant="tertiary" onClick={onCancel}>Cancelar cobro</BhButton>
        </div>
      </div>
    );
  }

  // ── Formulario ─────────────────────────────────────────────────────────────
  return (
    <div className="bh-card">
      <h2 className="section-title">¿Cuánto querés cobrar?</h2>

      {!isNative() && (
        <BhAlert
          severity="info"
          title="Vista previa"
          description="Cobrar por Bluetooth funciona desde la app instalada en el celular."
        />
      )}

      <BhTextField
        id="amount"
        label="Monto en pesos"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0,00"
        value={amountInput}
        onChange={(e) => setAmountInput(e.target.value)}
        disabled={busy}
        helper="Ejemplo: 1500 o 1500,50"
      />
      <BhTextField
        id="memo"
        label="Concepto (opcional)"
        type="text"
        maxLength={80}
        placeholder="Ej: feria — puesto 12"
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        disabled={busy}
      />

      {phase === 'error' && errorText && (
        <BhAlert severity="error" title="No pudimos iniciar el cobro" description={errorText} />
      )}

      <div className="actions-row">
        <BhButton onClick={onPublish} disabled={busy || !amountInput}>
          {busy ? 'Preparando…' : 'Generar código de cobro'}
        </BhButton>
      </div>
    </div>
  );
}
