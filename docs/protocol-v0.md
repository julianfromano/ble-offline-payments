# Protocol v0 — BLE Pay (offline)

> Estado: **prototipo Fase 1**. Sin firmas ni cifrado E2E. Integridad por SHA-256
> y reglas de TTL + nonce + tx_id.

## 1. Topología

```
[ Receptor (Cobrar) ] --BLE--> [ Relay GATT (ESP32) ] <--BLE-- [ Pagador (Pagar) ]
        Android PWA              peripheral broker              Android PWA
```

La PWA actúa como **GATT central** (cliente). Web Bluetooth no permite hoy actuar
como peripheral confiable; por eso un dispositivo intermedio (ESP32 u otro)
expone el servicio GATT custom.

## 2. UUIDs (custom)

| Rol         | UUID                                     |
|-------------|------------------------------------------|
| Service     | `7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0001`   |
| INTENT char | `7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0002`   |
| ACK char    | `7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0003`   |
| STATUS char | `7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0004`   |

Propiedades:

- **INTENT**: `read`, `write`, `notify`. Contiene el último `PaymentIntent` JSON
  publicado por el receptor.
- **ACK**: `write`, `notify`. El pagador escribe aquí su `Ack`; el receptor recibe
  notificación.
- **STATUS** (opcional): `read`, `notify`. Estado/contadores del relay.

El nombre advertised tiene prefijo `BLEPay-Relay`.

## 3. Codificación

- Encoding: **JSON UTF-8** canonicalizado (claves ordenadas, sin espacios) para
  que el SHA-256 sea determinístico.
- Tamaño máximo on-wire: **480 bytes**. Si excede, falla.
- Versión: campo `v` (entero). Esta especificación es `v = 0`.

## 4. Sobre común

```jsonc
{
  "v": 0,                     // versión
  "kind": "intent" | "ack",
  "tx_id": "uuid-v4",         // id de la transacción (idempotencia)
  "nonce": "<32 hex chars>",  // 16 bytes random por mensaje
  "ts": 1746489600000,        // epoch ms (UTC) del emisor
  "hash": "<sha256 hex>"      // SHA-256 del JSON canónico SIN el campo "hash"
}
```

## 5. PaymentIntent (`kind: "intent"`)

```jsonc
{
  "v": 0,
  "kind": "intent",
  "tx_id": "…",
  "nonce": "…",
  "ts": 1746489600000,
  "amount": 1500,             // entero, unidades menores (centavos)
  "currency": "ARS",          // ARS|USD|EUR|BRL
  "ttl": 120000,              // ms, ventana de validez desde ts
  "receiver_ephemeral_id": "<32 hex>",
  "memo": "opcional, ≤80 chars",
  "hash": "…"
}
```

## 6. Ack (`kind: "ack"`)

```jsonc
{
  "v": 0,
  "kind": "ack",
  "tx_id": "…",               // id propio del mensaje ack
  "nonce": "…",
  "ts": 1746489605000,
  "ref_tx_id": "<tx_id del intent>",
  "result": "OK" | "REJECT",
  "reason": "opcional",
  "hash": "…"
}
```

## 7. Reglas de validación (v0)

Receptor del mensaje (cualquier rol):

1. **Versión**: `v === 0`.
2. **Forma**: campos requeridos presentes y con tipos correctos.
3. **Hash**: recomputar SHA-256 sobre la canonicalización del objeto SIN el
   campo `hash` y comparar con el recibido.
4. **TTL** (solo intent): `now <= ts + ttl + 60s` (tolerancia de skew). Si vence,
   marcar `EXPIRED` y rechazar.
5. **Idempotencia**: si `tx_id` ya fue procesado (store `seen` en IndexedDB),
   ignorar.

## 8. Flujo Pay→Ack

```
Cobrar (receiver)                          Pagar (payer)
 |  createPaymentIntent()                       |
 |  upsert ledger CREATED                       |
 |  connect relay                               |
 |  write INTENT (publish) ─────────────────────|
 |  upsert ledger SENT                          |  (usuario abre Pagar)
 |                                              |  connect relay
 |                                              |  read INTENT
 |                                              |  validar hash/TTL/idempotencia
 |                                              |  upsert ledger CREATED (payer)
 |                                              |  usuario confirma
 |                                              |  createAck(OK)
 |  notify ACK ◄───────────────────────────── write ACK
 |  applyAck → ledger ACKED                     |  applyAck → ledger ACKED
```

## 9. Estados del ledger local

```
CREATED ──► SENT ──► ACKED
   │           │
   │           └──► FAILED  (error de envío / REJECT)
   └──► EXPIRED        (TTL vencido al evaluarse)
```

## 10. Limitaciones conocidas (v0)

- Sin autenticación de identidad (cualquiera con el UUID puede escribir).
- Sin cifrado E2E del payload.
- Relay es un punto único; en Fase 2 se evalúa BLE directo Android↔Android usando
  apps wrapper (TWA + companion BLE peripheral) o Nearby Connections.
- Reloj del emisor es de confianza local (TTL puede ser manipulado).

## 11. Cambios planeados para v1

- Firmas Ed25519 con clave de dispositivo (clave pública pinneada en el primer
  pareo).
- Cifrado E2E (X25519 + ChaCha20-Poly1305) sobre payload.
- Revocación / lista de tx_id sospechosos sincronizada al volver online.
