import Capacitor
import CoreBluetooth
import Foundation

/**
 * BlePeripheral — iOS native BLE peripheral (vendor/advertiser) plugin.
 *
 * Mirrors the API of the Android BlePeripheralPlugin exactly so the TypeScript
 * bridge in src/ble/peripheral.ts works on both platforms without changes.
 *
 * GATT server roles:
 *   - INTENT char (7a3e…0002): read + notify. Holds the hello / sec_intent envelope.
 *   - ACK char    (7a3e…0003): write. Receives hello_ack, buyer_confirm, sec_ack.
 *
 * iOS advertising notes:
 *   - Foreground: service UUID + local name are included in the advertisement (works
 *     for the feria use-case where the app is always in the foreground).
 *   - Background: iOS strips all service UUIDs and the local name. Use only for
 *     central-side connection resumption, not fresh discovery.
 *
 * Long reads: `didReceiveRead` honors `request.offset` so Core Bluetooth can
 * assemble INTENT payloads larger than the negotiated ATT MTU automatically.
 *
 * Thread model: CBPeripheralManager is created with DispatchQueue.main.
 */
@objc(BlePeripheralPlugin)
public class BlePeripheralPlugin: CAPPlugin, CBPeripheralManagerDelegate {

    private static let serviceUUID    = CBUUID(string: "7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0001")
    private static let intentCharUUID = CBUUID(string: "7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0002")
    private static let ackCharUUID    = CBUUID(string: "7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0003")
    private static let maxDeviceNameLen = 12

    private var manager: CBPeripheralManager?
    private var intentChar: CBMutableCharacteristic?
    private var ackChar: CBMutableCharacteristic?
    private var intentData = Data()
    private var subscribedCentrals: [CBCentral] = []

    // Pending operations deferred until CBPeripheralManager is powered on.
    private var pendingStartCall: CAPPluginCall?
    private var pendingDeviceName = "BLEPay"
    // Queued intent update requested before the service was registered.
    private var pendingUpdateData: Data?

    // MARK: - Plugin methods

    @objc func isAvailable(_ call: CAPPluginCall) {
        ensureManager()
        let on = manager?.state == .poweredOn
        call.resolve(["available": on, "reason": on ? "" : stateReason()])
    }

    @objc func startServer(_ call: CAPPluginCall) {
        guard let b64 = call.getString("intentBase64"),
              let data = Data(base64Encoded: b64) else {
            call.reject("intentBase64 requerido"); return
        }
        let rawName = call.getString("deviceName") ?? "BLEPay"
        pendingDeviceName = String(rawName.prefix(BlePeripheralPlugin.maxDeviceNameLen))
        intentData = data

        ensureManager()
        switch manager?.state {
        case .poweredOn:
            // Already ready — build and advertise immediately.
            pendingStartCall = call
            setupService()
        case .poweredOff:
            call.reject("Bluetooth apagado")
        case .unauthorized:
            call.reject("Permiso Bluetooth denegado")
        case .unsupported:
            call.reject("BLE no soportado en este dispositivo")
        default:
            // .unknown / .resetting — queue until state update fires.
            pendingStartCall = call
            call.keepAlive = true
        }
    }

    @objc func updateIntent(_ call: CAPPluginCall) {
        guard let b64 = call.getString("intentBase64"),
              let data = Data(base64Encoded: b64) else {
            call.reject("intentBase64 inválido"); return
        }
        intentData = data
        if let char = intentChar {
            let sent = manager?.updateValue(data, for: char, onSubscribedCentrals: nil) ?? false
            if !sent { pendingUpdateData = data }  // retry in peripheralManagerIsReady
        } else {
            pendingUpdateData = data  // service not yet registered, will be used at setup
        }
        call.resolve(["ok": true])
    }

    @objc func stopServer(_ call: CAPPluginCall) {
        manager?.stopAdvertising()
        manager?.removeAllServices()
        intentChar = nil
        ackChar = nil
        subscribedCentrals.removeAll()
        pendingStartCall?.reject("Servidor detenido")
        pendingStartCall = nil
        emitState("stopped", message: "advertising detenido")
        call.resolve(["ok": true])
    }

    // MARK: - Internal setup

    private func ensureManager() {
        if manager == nil {
            manager = CBPeripheralManager(delegate: self, queue: DispatchQueue.main)
        }
    }

    private func setupService() {
        manager?.stopAdvertising()
        manager?.removeAllServices()
        subscribedCentrals.removeAll()

        let ic = CBMutableCharacteristic(
            type: BlePeripheralPlugin.intentCharUUID,
            properties: [.read, .notify],
            value: nil,  // dynamic value — served via didReceiveRead
            permissions: [.readable]
        )
        let ac = CBMutableCharacteristic(
            type: BlePeripheralPlugin.ackCharUUID,
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable]
        )
        intentChar = ic
        ackChar = ac

        let svc = CBMutableService(type: BlePeripheralPlugin.serviceUUID, primary: true)
        svc.characteristics = [ic, ac]
        manager?.add(svc)
        // Advertising starts after peripheralManager(_:didAdd:error:) fires.
    }

    // MARK: - CBPeripheralManagerDelegate

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            emitState("powered_on", message: "listo")
            if pendingStartCall != nil { setupService() }
        case .poweredOff:
            emitState("powered_off", message: "apagado")
            pendingStartCall?.reject("Bluetooth apagado")
            pendingStartCall = nil
        case .unauthorized:
            emitState("unauthorized", message: "permiso denegado")
            pendingStartCall?.reject("Permiso Bluetooth denegado")
            pendingStartCall = nil
        default:
            break
        }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager,
                                  didAdd service: CBService, error: Error?) {
        if let err = error {
            pendingStartCall?.reject("Error registrando servicio GATT: \(err.localizedDescription)")
            pendingStartCall = nil; return
        }
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [BlePeripheralPlugin.serviceUUID],
            CBAdvertisementDataLocalNameKey:    pendingDeviceName
        ])
    }

    public func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let err = error {
            pendingStartCall?.reject("Error al advertise: \(err.localizedDescription)")
            pendingStartCall = nil; return
        }
        emitState("advertising", message: "nombre=\(pendingDeviceName)")
        pendingStartCall?.resolve(["ok": true])
        pendingStartCall = nil
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager,
                                  didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == BlePeripheralPlugin.intentCharUUID else {
            peripheral.respond(to: request, withResult: .requestNotSupported); return
        }
        // Honor ATT Read Blob offset so large payloads are chunked correctly.
        guard request.offset <= intentData.count else {
            peripheral.respond(to: request, withResult: .invalidOffset); return
        }
        request.value = intentData.subdata(in: request.offset ..< intentData.count)
        peripheral.respond(to: request, withResult: .success)
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager,
                                  didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            if request.characteristic.uuid == BlePeripheralPlugin.ackCharUUID,
               let data = request.value {
                notifyListeners("ack", data: ["ackBase64": data.base64EncodedString()])
                peripheral.respond(to: request, withResult: .success)
            } else {
                peripheral.respond(to: request, withResult: .requestNotSupported)
            }
        }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager,
                                  central: CBCentral,
                                  didSubscribeTo characteristic: CBCharacteristic) {
        guard characteristic.uuid == BlePeripheralPlugin.intentCharUUID else { return }
        if !subscribedCentrals.contains(where: { $0.identifier == central.identifier }) {
            subscribedCentrals.append(central)
        }
        notifyListeners("connection", data: ["connected": true,
                                             "address": central.identifier.uuidString])
        // Push current INTENT value to the newly subscribed central.
        if let ic = intentChar {
            manager?.updateValue(intentData, for: ic, onSubscribedCentrals: [central])
        }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager,
                                  central: CBCentral,
                                  didUnsubscribeFrom characteristic: CBCharacteristic) {
        subscribedCentrals.removeAll(where: { $0.identifier == central.identifier })
        notifyListeners("connection", data: ["connected": false,
                                             "address": central.identifier.uuidString])
    }

    public func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        // TX queue was full; retry queued notification.
        if let data = pendingUpdateData, let ic = intentChar {
            let sent = peripheral.updateValue(data, for: ic, onSubscribedCentrals: nil)
            if sent { pendingUpdateData = nil }
        }
    }

    // MARK: - Helpers

    private func stateReason() -> String {
        switch manager?.state {
        case .poweredOff:   return "Bluetooth apagado"
        case .unauthorized: return "Permiso Bluetooth denegado"
        case .unsupported:  return "BLE peripheral no soportado"
        case .resetting:    return "Bluetooth reiniciándose"
        default:            return "BLE peripheral no disponible"
        }
    }

    private func emitState(_ stage: String, message: String) {
        notifyListeners("state", data: ["stage": stage, "message": message])
    }
}
