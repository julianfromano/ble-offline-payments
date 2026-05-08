# BLE Pay — PWA (Fase 1)

Prototipo de **pagos offline store-and-forward** Android↔Android sobre **Web
Bluetooth (BLE)**, usando un **relay GATT** (ESP32 u otro peripheral) como
broker de mensajes entre las dos PWAs.

> **Solo prueba.** No es seguro para dinero real. Ver
> [docs/protocol-v0.md](docs/protocol-v0.md) para el contrato del protocolo y
> sus limitaciones.

## Características Fase 1

- UI en dos modos: **Cobrar** y **Pagar**.
- Mensajes JSON versionados, canonicalizados y validados con SHA-256 (WebCrypto).
- TTL + nonce + tx_id para evitar replays y duplicados (idempotencia).
- Ledger local en IndexedDB con estados `CREATED | SENT | ACKED | FAILED |
  EXPIRED` y export JSON.
- Logs por etapa (`scan`, `connect`, `read`, `write`, `notify`, …).
- PWA instalable (manifest + service worker vía `vite-plugin-pwa`).

## Estructura

```
src/
  ble/        # Web Bluetooth client (requestDevice, GATT, read/write/notify)
  protocol/   # Tipos, codec JSON canónico, WebCrypto helpers
  storage/    # IndexedDB + ledger (idempotencia y export)
  ui/         # React UI (App, ChargeMode, PayMode, Ledger, Logs)
docs/         # protocol-v0.md
firmware-relay-esp32/   # placeholder para el firmware del relay
```

## Requisitos

- Node 18+ (recomendado 20).
- Chrome en Android para correr la PWA (Web Bluetooth no está en iOS Safari).
- Un peripheral BLE que implemente el servicio descrito en
  [docs/protocol-v0.md](docs/protocol-v0.md) (UUIDs custom).
- Contexto seguro: **HTTPS** o `http://localhost`.

## Instalación

```bash
npm install
```

## Desarrollo local (dos teléfonos en la misma red Wi-Fi)

Web Bluetooth requiere contexto seguro; en Android, `localhost` no aplica si
servís a otro device. Opciones:

1. **Túnel HTTPS público** (más simple): usá `cloudflared` o `ngrok`:
   ```bash
   npm run dev
   # en otra terminal:
   cloudflared tunnel --url http://localhost:5173
   ```
   Abrí la URL HTTPS resultante en ambos teléfonos.

2. **Vite con HTTPS local + cert confiable**: generá un cert con `mkcert` y
   configurá `server.https` en `vite.config.ts`.

> No es necesario para correr en `localhost` desde la PC, pero sí desde celular.

## Build / Preview

```bash
npm run build
npm run preview -- --host
```

## Pruebas manuales (flujo Pay→Ack)

Necesitás dos celulares Android (`A` = receptor, `B` = pagador) y el relay
encendido, ambos cerca del relay.

1. En `A` abrí la PWA → **Cobrar**.
   - Completá monto, moneda, TTL.
   - Tocá **Publicar intent y cobrar**.
   - Aceptá el selector de dispositivos y elegí `BLEPay-Relay`.
   - El estado debe pasar a `publicando intent` → `esperando ack`.
2. En `B` abrí la PWA → **Pagar**.
   - Tocá **Escanear y leer intent**, elegí el mismo `BLEPay-Relay`.
   - Verificá monto/moneda/memo. Tocá **Confirmar pago**.
3. En `A` el estado debe cambiar a `cobrado`. En ambos teléfonos, la pestaña
   **Ledger** muestra la transacción `ACKED`.
4. **Idempotencia**: volvé a tocar **Escanear y leer intent** en `B` con el
   mismo intent → debe rechazarse por `tx_id repetido`.
5. **TTL**: poné TTL=2s en `A`, esperá 5s antes de leer en `B` → debe pasar a
   `EXPIRED`.
6. **Hash**: si modificás el firmware para emitir un payload corrupto, el lector
   debe rechazar con `Hash inválido`.
7. **Export**: tab **Ledger** → **Exportar JSON** descarga el ledger local.

## Solución de problemas

- **"Web Bluetooth no disponible"**: usá Chrome en Android, sobre HTTPS o
  `localhost`. Habilitá Bluetooth y Ubicación (Android lo exige para escaneo).
- **El selector no muestra el relay**: confirmá que advertise el Service UUID o
  que el `name` empiece con `BLEPay-Relay`.
- **`NotSupportedError` en `requestDevice`**: solo se puede invocar desde un
  gesto del usuario (click/tap).
- **Desconexiones aleatorias**: la app reintenta con backoff. Mantené las apps
  en primer plano (Android puede dormir BLE en background).

## Roadmap

- v1: Firmas Ed25519 + cifrado E2E.
- v1.1: Reconexión de larga duración y store-and-forward multi-relay.
- v2: Eliminar el relay (BLE directo) usando una app wrapper Android nativa.

## Licencia

Prototipo interno. Sin licencia pública por ahora.
