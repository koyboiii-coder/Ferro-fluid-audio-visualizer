package com.nikkiro.audiovisualizer

import android.Manifest
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Requests android.permission.RECORD_AUDIO through Capacitor's own plugin
 * permission system (checkPermissions/requestPermissions are inherited from
 * the base Plugin class from the @CapacitorPlugin permissions declaration).
 *
 * This exists because the WebView's own onPermissionRequest -> getUserMedia
 * round-trip does not reliably resolve back to the page in this project
 * (verified on-device: the OS permission ends up granted, but the
 * getUserMedia() promise still rejects with "Permission denied"). Asking
 * for the OS permission here first, then letting MainActivity's
 * onPermissionRequest override do a plain synchronous grant/deny check,
 * sidesteps that broken path entirely.
 */
@CapacitorPlugin(
    name = "MicPermission",
    permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")]
)
class MicPermissionPlugin : Plugin() {

    @PluginMethod
    fun checkPermission(call: PluginCall) {
        val ret = JSObject()
        ret.put("granted", getPermissionState("microphone") == PermissionState.GRANTED)
        call.resolve(ret)
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            val ret = JSObject()
            ret.put("granted", true)
            call.resolve(ret)
            return
        }
        requestPermissionForAlias("microphone", call, "permissionCallback")
    }

    @PermissionCallback
    private fun permissionCallback(call: PluginCall) {
        val ret = JSObject()
        ret.put("granted", getPermissionState("microphone") == PermissionState.GRANTED)
        call.resolve(ret)
    }
}
