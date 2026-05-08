import Capacitor
import CoreBluetooth
import Foundation

/**
 * BleCentral — iOS native BLE central (payer/scanner) plugin.
 *
 * Mirrors the API of the Android BleCentralPlugin exactly so the TypeScript
 * bridge in src/ble/central.ts works on both platforms without changes.
 *
 * Key iOS/Android difference: iOS does not expose MAC addresses. The "address"
 * field in scan_result events and connectByAddress is the peripheral's Core
 * Bluetooth identifier UUID string (stable per app install + device).
 *
 * Thread model: CBCentralManager is created with DispatchQueue.main so all
 * delegate callbacks fire on the main thread — safe for Capacitor plugin calls.
 */
@objc(BleCentralPlugin)
public class BleCentralPlugin: CAPPlugin, CBCentralManagerDelegate, CBPeripheralDelegate {

    private static let serviceUUID    = CBUUID(string: "7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0001")
    private static let intentCharUUID = CBUUID(string: "7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0002")
    private static let ackCharUUID    = CBUUID(string: "7a3e1c10-9b54-4f3d-8b2a-2d1f9d4a0003")

    private var central: CBCentralManager?
    // Discovered peripherals keyed by identifier UUID string.
    private var peripherals: [String: CBPeripheral] = [:]
    private var connectedPeripheral: CBPeripheral?
    private var intentChar: CBCharacteristic?
    private var ackChar: CBCharacteristic?

    private var pendingScanCall: CAPPluginCall?
    private var pendingConnectCall: CAPPluginCall?
    private var pendingWriteCall: CAPPluginCall?
    private var scanTimeoutItem: DispatchWorkItem?
    private var connectTimeoutItem: DispatchWorkItem?

    // MARK: - Plugin methods

    @objc func isAvailable(_ call: CAPPluginCall) {
        ensureCentral()
        let on = central?.state == .poweredOn
        call.resolve(["available": on, "reason": on ? "" : bluetoothStateReason()])
    }

    @objc func scanList(_ call: CAPPluginCall) {
        ensureCentral()
        guard central?.state == .poweredOn else {
            call.reject("Bluetooth no disponible: \(bluetoothStateReason())"); return
        }
        let timeoutMs = call.getDouble("timeoutMs") ?? 15_000
        peripherals.removeAll()
        pendingScanCall = call
        call.keepAlive = true

        central?.scanForPeripherals(
            withServices: [BleCentralPlugin.serviceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
        emitState("scanning", message: "service=\(BleCentralPlugin.serviceUUID)")

        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.central?.stopScan()
            self.pendingScanCall?.resolve(["ok": true, "reason": "timeout"])
            self.pendingScanCall = nil
            self.emitState("scan_stopped", message: "timeout=\(Int(timeoutMs))ms")
        }
        scanTimeoutItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + timeoutMs / 1_000, execute: item)
    }

    @objc func stopScan(_ call: CAPPluginCall) {
        central?.stopScan()
        scanTimeoutItem?.cancel()
        scanTimeoutItem = nil
        pendingScanCall?.resolve(["ok": true, "reason": "stopped"])
        pendingScanCall = nil
        emitState("scan_stopped", message: "manual")
        call.resolve(["ok": true])
    }

    @objc func connectByAddress(_ call: CAPPluginCall) {
        guard let address = call.getString("address") else {
            call.reject("address requerido"); return
        }
        guard let peripheral = peripherals[address] else {
            call.reject("Periférico '\(address)' no encontrado — ¿el escaneo está activo?"); return
        }

        // Stop ongoing scan before connecting.
        central?.stopScan()
        scanTimeoutItem?.cancel()
        scanTimeoutItem = nil
        pendingScanCall?.resolve(["ok": true, "reason": "superseded by connect"])
        pendingScanCall = nil

        peripheral.delegate = self
        connectedPeripheral = peripheral
        pendingConnectCall = call
        call.keepAlive = true

        emitState("connecting", message: "address=\(address)")
        central?.connect(peripheral, options: nil)

        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if let p = self.connectedPeripheral { self.central?.cancelPeripheralConnection(p) }
            self.pendingConnectCall?.reject("Timeout de conexión (10s)")
            self.pendingConnectCall = nil
        }
        connectTimeoutItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: item)
    }

    @objc func writeAck(_ call: CAPPluginCall) {
        guard let b64 = call.getString("ackBase64"),
              let data = Data(base64Encoded: b64) else {
            call.reject("ackBase64 inválido"); return
        }
        guard let peripheral = connectedPeripheral,
              let char = ackChar else {
            call.reject("No hay conexión GATT activa"); return
        }
        pendingWriteCall = call
        call.keepAlive = true
        peripheral.writeValue(data, for: char, type: .withResponse)
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        scanTimeoutItem?.cancel()
        connectTimeoutItem?.cancel()
        central?.stopScan()
        if let p = connectedPeripheral { central?.cancelPeripheralConnection(p) }
        connectedPeripheral = nil; intentChar = nil; ackChar = nil
        pendingScanCall?.resolve(["ok": true, "reason": "disconnect"])
        pendingScanCall = nil
        pendingConnectCall?.reject("Cancelado por disconnect()")
        pendingConnectCall = nil
        pendingWriteCall?.reject("Cancelado por disconnect()")
        pendingWriteCall = nil
        emitState("disconnected", message: "central cerrado")
        call.resolve(["ok": true])
    }

    // MARK: - CBCentralManagerDelegate

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:  emitState("powered_on",  message: "listo")
        case .poweredOff: emitState("powered_off", message: "apagado")
        case .unauthorized: emitState("unauthorized", message: "permiso denegado")
        default: emitState("unavailable", message: "state=\(central.state.rawValue)")
        }
    }

    public func centralManager(_ central: CBCentralManager,
                               didDiscover peripheral: CBPeripheral,
                               advertisementData: [String: Any],
                               rssi RSSI: NSNumber) {
        let uuid = peripheral.identifier.uuidString
        peripherals[uuid] = peripheral
        let name = peripheral.name
            ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
            ?? ""
        notifyListeners("scan_result", data: [
            "address":   uuid,
            "name":      name,
            "rssi":      RSSI.intValue,
            "timestamp": Int(Date().timeIntervalSince1970 * 1_000)
        ])
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        connectTimeoutItem?.cancel(); connectTimeoutItem = nil
        emitState("connected", message: "discovering services")
        peripheral.discoverServices([BleCentralPlugin.serviceUUID])
    }

    public func centralManager(_ central: CBCentralManager,
                               didFailToConnect peripheral: CBPeripheral, error: Error?) {
        connectTimeoutItem?.cancel(); connectTimeoutItem = nil
        pendingConnectCall?.reject("Falló conexión: \(error?.localizedDescription ?? "desconocido")")
        pendingConnectCall = nil
        connectedPeripheral = nil
    }

    public func centralManager(_ central: CBCentralManager,
                               didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        emitState("disconnected", message: error?.localizedDescription ?? "ok")
        pendingConnectCall?.reject("Desconectado antes de leer INTENT")
        pendingConnectCall = nil
        pendingWriteCall?.reject("Desconectado durante write ACK")
        pendingWriteCall = nil
        if connectedPeripheral?.identifier == peripheral.identifier {
            connectedPeripheral = nil; intentChar = nil; ackChar = nil
        }
        notifyListeners("connection", data: ["connected": false,
                                             "address": peripheral.identifier.uuidString])
    }

    // MARK: - CBPeripheralDelegate

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let err = error {
            pendingConnectCall?.reject("discoverServices error: \(err.localizedDescription)")
            pendingConnectCall = nil; return
        }
        guard let svc = peripheral.services?.first(where: { $0.uuid == BleCentralPlugin.serviceUUID }) else {
            pendingConnectCall?.reject("Servicio BLE Pay no encontrado en el peer")
            pendingConnectCall = nil; return
        }
        peripheral.discoverCharacteristics(
            [BleCentralPlugin.intentCharUUID, BleCentralPlugin.ackCharUUID],
            for: svc
        )
    }

    public func peripheral(_ peripheral: CBPeripheral,
                           didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let err = error {
            pendingConnectCall?.reject("discoverChars error: \(err.localizedDescription)")
            pendingConnectCall = nil; return
        }
        intentChar = service.characteristics?.first(where: { $0.uuid == BleCentralPlugin.intentCharUUID })
        ackChar    = service.characteristics?.first(where: { $0.uuid == BleCentralPlugin.ackCharUUID })
        guard let ic = intentChar else {
            pendingConnectCall?.reject("Characteristic INTENT no encontrada")
            pendingConnectCall = nil; return
        }
        // MTU info for debugging.
        let maxRead = peripheral.maximumWriteValueLength(for: .withResponse)
        emitState("chars_found", message: "mtu=\(maxRead) reading INTENT")
        peripheral.readValue(for: ic)
    }

    public func peripheral(_ peripheral: CBPeripheral,
                           didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == BleCentralPlugin.intentCharUUID else { return }
        if let err = error {
            if let call = pendingConnectCall {
                pendingConnectCall = nil; call.reject("read INTENT error: \(err.localizedDescription)")
            }
            return
        }
        guard let data = characteristic.value else {
            pendingConnectCall?.reject("INTENT vacío"); pendingConnectCall = nil; return
        }
        if let call = pendingConnectCall {
            // Initial read resolves the connect call.
            pendingConnectCall = nil
            call.resolve([
                "intentBase64": data.base64EncodedString(),
                "address":      peripheral.identifier.uuidString
            ])
            emitState("intent_read", message: "\(data.count) bytes")
            // Subscribe to INTENT notifications for subsequent sec_intent updates.
            peripheral.setNotifyValue(true, for: characteristic)
        } else {
            // Notification-driven update (sec_intent published by vendor after hello_ack).
            notifyListeners("intent_update", data: ["intentBase64": data.base64EncodedString()])
            emitState("intent_notify", message: "\(data.count) bytes")
        }
    }

    public func peripheral(_ peripheral: CBPeripheral,
                           didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == BleCentralPlugin.ackCharUUID else { return }
        if let err = error {
            pendingWriteCall?.reject("write ACK error: \(err.localizedDescription)")
        } else {
            pendingWriteCall?.resolve(["ok": true])
        }
        pendingWriteCall = nil
        emitState("ack_written", message: error == nil ? "ok" : "error")
    }

    // MARK: - Helpers

    private func ensureCentral() {
        if central == nil {
            central = CBCentralManager(delegate: self, queue: DispatchQueue.main)
        }
    }

    private func bluetoothStateReason() -> String {
        switch central?.state {
        case .poweredOff:   return "Bluetooth apagado"
        case .unauthorized: return "Permiso Bluetooth denegado"
        case .unsupported:  return "BLE no soportado en este dispositivo"
        case .resetting:    return "Bluetooth reiniciándose"
        default:            return "Bluetooth no disponible"
        }
    }

    private func emitState(_ stage: String, message: String) {
        notifyListeners("state", data: ["stage": stage, "message": message])
    }
}
