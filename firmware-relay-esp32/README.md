# BLE Pay — Relay (ESP32) — placeholder

Este directorio aloja el firmware del **relay BLE** (peripheral GATT) que sirve
de broker entre las dos PWAs Android.

## Servicio GATT esperado

| Rol         | UUID                                     | Properties             |
|-------------|------------------------------------------|------------------------|
| Service     | `7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0001`   | primary                |
| INTENT      | `7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0002`   | read, write, notify    |
| ACK         | `7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0003`   | write, notify          |
| STATUS      | `7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0004`   | read, notify (opt.)    |

- Local name advertised: prefijo `BLEPay-Relay`.
- MTU recomendado: ≥ 247.
- Comportamiento: el relay actúa como buzón. Guarda el último valor escrito en
  INTENT y lo entrega por `read`. Cuando recibe un `write` en ACK, dispara
  `notify` para todos los suscriptores.

## Implementación sugerida

- Arduino-ESP32 con `BLEDevice` / `BLEServer`, o ESP-IDF + NimBLE.
- Sin lógica de negocio: el relay no valida hashes ni TTL; eso ocurre en las
  PWAs.
- Reset de buffers tras N segundos de inactividad para evitar fugas entre
  sesiones.

> Pendiente: subir un sketch de referencia. Por ahora cualquier firmware que
> cumpla el servicio GATT alcanza para Fase 1.
