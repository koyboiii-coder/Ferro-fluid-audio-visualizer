package com.nikkiro.audiovisualizer

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.PermissionRequest
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebChromeClient

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(MicPermissionPlugin::class.java)
        super.onCreate(savedInstanceState)

        // BridgeWebChromeClient's own permission-launcher round-trip does not
        // reliably resolve back to getUserMedia() here (verified on-device:
        // the OS permission ends up granted, but the JS promise still rejects
        // with "Permission denied"). MicPermissionPlugin already requests
        // RECORD_AUDIO through Capacitor's own working plugin-permission
        // system before the page calls getUserMedia, so by the time this
        // fires we only need a plain synchronous check, not another
        // permission round-trip through the broken path.
        bridge.webView.webChromeClient = object : BridgeWebChromeClient(bridge) {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    val granted = ContextCompat.checkSelfPermission(
                        this@MainActivity,
                        Manifest.permission.RECORD_AUDIO
                    ) == PackageManager.PERMISSION_GRANTED
                    if (granted) request.grant(request.resources) else request.deny()
                } else {
                    super.onPermissionRequest(request)
                }
            }
        }
    }
}
