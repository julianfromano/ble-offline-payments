# BLE Offline Payments — Interoperable Android/iOS

Sistema de pagos offline interoperable entre apps nativas **Android** e **iOS** usando **Bluetooth Low Energy (BLE)**, con un agente central solo para registro, provisión de claves y sincronización. No requiere conexión a internet en el momento de la transacción.

## Descripción

- **Pagos offline** entre dos celulares (comprador y vendedor) sin autoridad central en el momento de la transacción.
- **Interoperable:** funciona entre Android y iOS, sin hardware adicional ni relay BLE.
- **Apps nativas:** implementadas con Capacitor, plugins BLE nativos (Kotlin/Swift).
- **Agente central:** solo para onboarding, provisión de claves/certificados y sincronización de transacciones. No participa en el flujo offline.

## Arquitectura

- **Canal:** BLE GATT directo entre apps (sin relay, sin PWA, sin ESP32).
- **Seguridad:**
  - Provisión de claves Ed25519 en TEE/Secure Enclave.
  - Certificados y tokens de saldo firmados por el backend.
  - Canal BLE cifrado con DH efímero + firma Ed25519 + AES-GCM.
  - Doble firma de transacciones, chain_hash para detectar doble gasto.
- **UX:**
  - El vendedor muestra un código corto (shortId) y un PIN de un solo uso.
  - El comprador ingresa el PIN y selecciona el puesto correcto por nombre/código.
  - Confirmación bilateral visual antes de firmar.

## Requisitos

- Node.js 18+ (para build y tooling).
- Android Studio y/o Xcode para compilar apps nativas.
- Cuenta en el agente central para onboarding y provisión de claves.
- Dispositivos Android (8+) y/o iOS (13+) con BLE.

## Instalación y Build

```bash
npm install
# Para Android:
npx cap sync android
# Para iOS (en Mac):
npx cap sync ios
```

## Flujo de uso

1. **Onboarding:**
   - El usuario se registra en el agente central, que genera y provisiona claves/certificados y tokens de saldo offline.
2. **Cobrar:**
   - El vendedor ingresa el monto y publica el cobro, mostrando shortId y PIN.
   - La app anuncia el servicio BLE con nombre único.
3. **Pagar:**
   - El comprador ingresa el PIN y selecciona el puesto correcto.
   - Se establece canal BLE seguro, se firma y confirma la transacción offline.
4. **Sincronización:**
   - Cuando cualquiera de los dos recupera conectividad, sincroniza con el agente central para liquidar y validar las transacciones.

## Estado actual

- Plugins BLE nativos funcionales en Android (Kotlin). Port a Swift para iOS pendiente.
- Protocolo seguro v1 implementado: handshake ECDH+PIN, canal cifrado, doble firma, chain_hash.
- UI React: modos Cobrar y Pagar, lista de puestos, PIN y shortId, ledger local.
- Sin relay BLE, sin PWA, sin dependencias de hardware externo.

## Seguridad

- Claves privadas protegidas en TEE/Secure Enclave.
- Tokens de saldo y certificados con TTL corto.
- Doble firma y chain_hash para no-repudio y detección de doble gasto.
- Sincronización obligatoria para renovar saldo y liquidar pagos.

## Licencia

MIT. Ver LICENSE.
