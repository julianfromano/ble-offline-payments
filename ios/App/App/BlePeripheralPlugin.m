#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers BlePeripheral plugin methods with the Capacitor bridge.
// The plugin name "BlePeripheral" must match registerPlugin<BlePeripheralPlugin>('BlePeripheral')
// in src/ble/peripheral.ts.
CAP_PLUGIN(BlePeripheralPlugin, "BlePeripheral",
    CAP_PLUGIN_METHOD(isAvailable,   CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(startServer,   CAPPluginReturnCallback);
    CAP_PLUGIN_METHOD(updateIntent,  CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopServer,    CAPPluginReturnPromise);
)
