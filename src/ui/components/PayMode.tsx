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
import { formatAmount } from '../format';
import { BhAlert, BhButton, BhTextField } from '../bh';
import successImg from '../bh/assets/success.svg';
import searchingImg from '../bh/assets/owl-looking-for.svg';

const TE = new TextEncoder();
const PROBE_BYTES = TE.encode(HELLO_PROBE);

type Phase = 'form' | 'scanning' | 'confirm' | 'done' | 'error';

/**
 * "Pagar" — payer side, protocol v1.
 *
 * Flujo de protocolo (sin cambios):
 *   1) Usuario ingresa código de 4 dígitos.
 *   2) Escaneo; al encontrar BLEPay-${code} conecta automáticamente.
 *   3) INTENT → hello. Deriva clave de sesión con el código como PIN.
 *   4) hello_ack (pub ECDH + probe cifrada).
 *   5) sec_intent → rate limit → buyer_confirm → UI de confirmación.
 *   6) Confirmar → sec_ack → registrar transacción.
 */
export function PayMode() {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');
  const [scanning, setScanning] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [intent, setIntent] = useState<PaymentIntent | null>(null);

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

  function fail(msg: string) {
    setErrorText(msg);
    setPhase('error');
    setScanning(false);
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

      if (await wasSeen(pi.tx_id)) throw new Error('Este cobro ya fue procesado.');
      if (isExpired(pi)) {
        await upsertFromIntent(pi, 'payer', 'CREATED', 'intent recibido pero expirado');
        await markStatus(pi.tx_id, 'EXPIRED', 'TTL vencido al recibir');
        throw new Error('El cobro venció — pedile al vendedor que lo genere de nuevo.');
      }

      // Check rate limits before committing to this transaction.
      checkRateLimit(pi.amount);

      await upsertFromIntent(pi, 'payer', 'CREATED', 'intent cifrado leído');

      // Bilateral confirmation: auto-send before showing confirm UI.
      await sendBuyerConfirm(pi, key);

      setIntent(pi);
      setPhase('confirm');
      setStatusText('');
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('protocol', `sec_intent inválido: ${msg}`);
      fail(msg);
    }
  }

  async function connectToVendor(address: string) {
    if (foundAndConnecting.current) return;
    foundAndConnecting.current = true;
    setBusy(true);
    setStatusText('Puesto encontrado — conectando…');
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
      setStatusText('Conexión segura establecida — recibiendo el cobro…');
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('ui', `Pagar(connect): ${msg}`);
      fail(msg);
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
    if (!isNative()) {
      fail('Pagar por Bluetooth funciona desde la app instalada en el celular.');
      return;
    }
    if (!/^\d{4}$/.test(codeInput)) {
      fail('Ingresá el código de 4 dígitos que muestra el vendedor.');
      return;
    }

    setBusy(true);
    setErrorText('');
    setIntent(null);
    sessionKeyRef.current = null;
    foundAndConnecting.current = false;
    codeRef.current = codeInput;

    try {
      const av = await BleCentral.isAvailable();
      if (!av.available) throw new Error(`Bluetooth no disponible: ${av.reason ?? 'desconocido'}`);

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
      setPhase('scanning');
      setStatusText('Buscando el puesto del vendedor…');
      void BleCentral.scanList({ timeoutMs: 60_000 }).then((res) => {
        if (res.reason === 'timeout' && !foundAndConnecting.current) {
          fail(`No encontramos el código ${codeInput} cerca. ¿El vendedor tiene el cobro activo?`);
        }
      }).catch((e: unknown) => {
        fail(`No pudimos buscar por Bluetooth: ${(e as Error).message}`);
      });
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('ui', `Pagar(scan): ${msg}`);
      fail(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(result: 'OK' | 'REJECT') {
    if (!intent) return;
    const key = sessionKeyRef.current;
    if (!key) { fail('Se perdió la conexión segura — volvé a intentar.'); return; }
    setBusy(true);
    setStatusText(result === 'OK' ? 'Enviando el pago…' : 'Rechazando…');
    try {
      if (result === 'OK') checkRateLimit(intent.amount);
      const ack = await createAck(intent, result, result === 'REJECT' ? 'usuario rechazó' : undefined);
      const ackBytes = encodeMessage(ack);
      const { iv, ct } = await aesGcmEncrypt(key, ackBytes);
      const env: SecureEnvelope = { v: 1, kind: 'sec_ack', iv: b64encode(iv), ct: b64encode(ct) };
      await BleCentral.writeAck({ ackBase64: b64encode(encodeSecureEnvelope(env)) });
      await applyAck(ack, `ack cifrado: ${result}`);
      if (result === 'OK') recordTransaction(intent.amount);
      logger.info('protocol', `ACK ${result} enviado para ${intent.tx_id}`);
      if (result === 'OK') {
        setPhase('done');
      } else {
        await onCancel();
      }
    } catch (e) {
      const msg = (e as Error).message;
      logger.error('ui', `Pagar(confirm): ${msg}`);
      await markStatus(intent.tx_id, 'FAILED', `error al enviar ack: ${msg}`);
      fail(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    await cleanup();
    setIntent(null);
    setCodeInput('');
    setScanning(false);
    setErrorText('');
    setStatusText('');
    setPhase('form');
  }

  // ── Pantalla de éxito ──────────────────────────────────────────────────────
  if (phase === 'done' && intent) {
    return (
      <div className="bh-card result-screen">
        <img src={successImg} alt="" className="result-img" />
        <h2 className="result-title">¡Pago enviado!</h2>
        <p className="result-amount">{formatAmount(intent.amount, intent.currency)}</p>
        {intent.memo && <p className="muted">{intent.memo}</p>}
        <p className="muted">El comprobante quedó guardado en ambos celulares.</p>
        <BhButton onClick={onCancel}>Nuevo pago</BhButton>
      </div>
    );
  }

  // ── Confirmación del pago ──────────────────────────────────────────────────
  if (phase === 'confirm' && intent) {
    return (
      <div className="bh-card result-screen">
        <p className="muted">Estás por pagar</p>
        <p className="result-amount">{formatAmount(intent.amount, intent.currency)}</p>
        {intent.memo && <p className="muted">{intent.memo}</p>}
        <BhAlert
          severity="success"
          title="Conexión protegida"
          description="El monto viaja cifrado entre los dos celulares. Confirmá solo si coincide con lo acordado."
        />
        <div className="actions-row actions-row--stack">
          <BhButton onClick={() => onConfirm('OK')} disabled={busy}>Confirmar pago</BhButton>
          <BhButton variant="secondary" onClick={() => onConfirm('REJECT')} disabled={busy}>
            Rechazar
          </BhButton>
        </div>
      </div>
    );
  }

  // ── Buscando al vendedor ───────────────────────────────────────────────────
  if (phase === 'scanning') {
    return (
      <div className="bh-card result-screen">
        <img src={searchingImg} alt="" className="result-img" />
        <h2 className="result-title">Buscando el puesto…</h2>
        <p className="status-line status-line--center" aria-live="polite">
          <span className="pulse-dot" aria-hidden="true" />
          {statusText}
        </p>
        <BhButton variant="tertiary" onClick={onCancel} disabled={busy && !scanning}>
          Cancelar
        </BhButton>
      </div>
    );
  }

  // ── Formulario: código del vendedor ────────────────────────────────────────
  return (
    <div className="bh-card">
      <h2 className="section-title">Ingresá el código del vendedor</h2>
      <p className="muted">
        El vendedor tiene un código de <strong>4 dígitos</strong> en su pantalla.
        Con ese código tu celular encuentra el puesto correcto y se conecta de forma segura.
      </p>

      {!isNative() && (
        <BhAlert
          severity="info"
          title="Vista previa"
          description="Pagar por Bluetooth funciona desde la app instalada en el celular."
        />
      )}

      <BhTextField
        id="code-input"
        label="Código de 4 dígitos"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        className="bh-input code-input"
        value={codeInput}
        maxLength={4}
        onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ''))}
        disabled={busy}
        placeholder="••••"
      />

      {phase === 'error' && errorText && (
        <BhAlert severity="error" title="No se pudo completar" description={errorText} />
      )}

      <div className="actions-row">
        <BhButton onClick={startDiscovery} disabled={busy || codeInput.length !== 4}>
          Conectar y pagar
        </BhButton>
      </div>
    </div>
  );
}
