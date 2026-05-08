#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers BleCentral plugin methods with the Capacitor bridge.
// The plugin name "BleCentral" must match registerPlugin<BleCentralPlugin>('BleCentral')
// in src/ble/central.ts.
CAP_PLUGIN(BleCentralPlugin, "BleCentral",
    CAP_PLUGIN_METHOD(isAvailable,      CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(scanList,         CAPPluginReturnCallback);
    CAP_PLUGIN_METHOD(stopScan,         CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(connectByAddress, CAPPluginReturnCallback);
    CAP_PLUGIN_METHOD(writeAck,         CAPPluginReturnCallback);
    CAP_PLUGIN_METHOD(disconnect,       CAPPluginReturnPromise);
)
