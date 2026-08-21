package com.nikkiro.audiovisualizer

import android.content.Intent
import android.media.AudioManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * JS-facing bridge for NowPlayingBridge/NowPlayingListenerService — the
 * Android equivalent of electronAPI.media. Payload shape mirrors
 * electron/preload.cjs's media:update contract ({active, title, artist,
 * source, position, duration, status, lastUpdated}, position/duration in
 * seconds) so src/main.js's mediaBridge adapter can treat both platforms
 * the same way.
 */
@CapacitorPlugin(name = "NowPlaying")
class NowPlayingPlugin : Plugin() {

    private var stateListener: ((NowPlayingBridge.NowPlayingState) -> Unit)? = null

    override fun load() {
        super.load()
        val listener: (NowPlayingBridge.NowPlayingState) -> Unit = { state -> notifyListeners("nowPlayingUpdate", stateToJs(state)) }
        stateListener = listener
        NowPlayingBridge.addListener(listener)
    }

    override fun handleOnDestroy() {
        stateListener?.let { NowPlayingBridge.removeListener(it) }
        super.handleOnDestroy()
    }

    private fun stateToJs(state: NowPlayingBridge.NowPlayingState): JSObject {
        val obj = JSObject()
        obj.put("active", state.active)
        obj.put("title", state.title)
        obj.put("artist", state.artist)
        obj.put("source", state.source)
        obj.put("position", state.positionMs / 1000.0)
        obj.put("duration", state.durationMs / 1000.0)
        obj.put("status", if (state.isPlaying) "Playing" else "Paused")
        obj.put("lastUpdated", state.lastUpdated)
        obj.put("volume", currentVolume())
        return obj
    }

    @PluginMethod
    fun getCurrentState(call: PluginCall) {
        call.resolve(stateToJs(NowPlayingBridge.state))
    }

    @PluginMethod
    fun checkNotificationAccess(call: PluginCall) {
        val ret = JSObject()
        ret.put("granted", isNotificationAccessGranted())
        call.resolve(ret)
    }

    @PluginMethod
    fun requestNotificationAccess(call: PluginCall) {
        // Settings deep-link, not a permission dialog — there's no grant
        // callback, so the JS side re-checks checkNotificationAccess() on
        // resume (Capacitor App plugin's appStateChange) after the user
        // comes back from Settings.
        activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        call.resolve()
    }

    @PluginMethod
    fun play(call: PluginCall) {
        NowPlayingBridge.play()
        call.resolve()
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        NowPlayingBridge.pause()
        call.resolve()
    }

    @PluginMethod
    fun next(call: PluginCall) {
        NowPlayingBridge.next()
        call.resolve()
    }

    @PluginMethod
    fun previous(call: PluginCall) {
        NowPlayingBridge.previous()
        call.resolve()
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val level = call.getDouble("level") ?: run {
            call.reject("level is required")
            return
        }
        val audioManager = context.getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val target = (level.coerceIn(0.0, 1.0) * max).toInt()
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
        call.resolve()
    }

    private fun currentVolume(): Double {
        val audioManager = context.getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        if (max <= 0) return 0.0
        return audioManager.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max
    }

    private fun isNotificationAccessGranted(): Boolean {
        return NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
    }
}
