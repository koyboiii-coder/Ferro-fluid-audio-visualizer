package com.nikkiro.audiovisualizer

import android.content.ComponentName
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Android's equivalent of the Windows SMTC bridge in
 * electron/media-session.cjs. The notification-listener permission this
 * service requires is only what GRANTS access to
 * MediaSessionManager.getActiveSessions() — actual now-playing data is read
 * from the structured MediaController (metadata/playback state), not by
 * parsing notification content, same as the SMTC bridge reads structured
 * session data rather than scraping the tray.
 */
class NowPlayingListenerService : NotificationListenerService() {

    private lateinit var sessionManager: MediaSessionManager
    private val controllerCallbacks = mutableMapOf<MediaController, MediaController.Callback>()

    private val sessionsChangedListener =
        MediaSessionManager.OnActiveSessionsChangedListener { controllers -> refreshControllers(controllers ?: emptyList()) }

    override fun onListenerConnected() {
        super.onListenerConnected()
        sessionManager = getSystemService(MediaSessionManager::class.java)
        val componentName = ComponentName(this, NowPlayingListenerService::class.java)
        sessionManager.addOnActiveSessionsChangedListener(sessionsChangedListener, componentName)
        refreshControllers(sessionManager.getActiveSessions(componentName))
    }

    override fun onListenerDisconnected() {
        controllerCallbacks.forEach { (controller, callback) -> controller.unregisterCallback(callback) }
        controllerCallbacks.clear()
        if (::sessionManager.isInitialized) {
            sessionManager.removeOnActiveSessionsChangedListener(sessionsChangedListener)
        }
        NowPlayingBridge.clear()
        super.onListenerDisconnected()
    }

    private fun refreshControllers(controllers: List<MediaController>) {
        val gone = controllerCallbacks.keys.filter { existing -> controllers.none { it.packageName == existing.packageName } }
        gone.forEach { controller ->
            controllerCallbacks[controller]?.let { controller.unregisterCallback(it) }
            controllerCallbacks.remove(controller)
        }
        controllers.forEach { controller ->
            if (controllerCallbacks.keys.none { it.packageName == controller.packageName }) {
                val callback = object : MediaController.Callback() {
                    override fun onMetadataChanged(metadata: MediaMetadata?) = pickAndPublish()
                    override fun onPlaybackStateChanged(state: PlaybackState?) = pickAndPublish()
                    override fun onSessionDestroyed() = pickAndPublish()
                }
                controller.registerCallback(callback)
                controllerCallbacks[controller] = callback
            }
        }
        pickAndPublish()
    }

    // Prefers whichever session is actually STATE_PLAYING, falling back to
    // any other *meaningfully loaded* one — mirrors media-session.cjs's
    // "PlaybackStatus -eq Playing | Select-Object -First 1" precedent.
    // Sessions sitting at NONE/STOPPED/ERROR (e.g. Google Assistant's own
    // idle session, or an app that failed to sign in) are excluded
    // entirely rather than just deprioritized — those aren't "now playing"
    // anything, so showing them would just be a confusing empty bar.
    private fun pickAndPublish() {
        val relevant = controllerCallbacks.keys.filter {
            when (it.playbackState?.state) {
                null, PlaybackState.STATE_NONE, PlaybackState.STATE_STOPPED, PlaybackState.STATE_ERROR -> false
                else -> true
            }
        }
        val chosen = relevant.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: relevant.firstOrNull()

        if (chosen == null) {
            NowPlayingBridge.clear()
            return
        }

        val metadata = chosen.metadata
        val playbackState = chosen.playbackState
        val isPlaying = playbackState?.state == PlaybackState.STATE_PLAYING

        NowPlayingBridge.update(
            NowPlayingBridge.NowPlayingState(
                active = true,
                title = metadata?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: "",
                artist = metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: "",
                source = appLabelFor(chosen.packageName),
                positionMs = playbackState?.position ?: 0,
                durationMs = metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0,
                isPlaying = isPlaying,
                lastUpdated = System.currentTimeMillis()
            ),
            chosen
        )
    }

    private fun appLabelFor(packageName: String): String {
        return try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, 0)).toString()
        } catch (e: Exception) {
            packageName
        }
    }

    // Metadata comes from MediaController (see above), not notification
    // content, so these are no-ops — only the listener-connection
    // permission this service grants is actually needed.
    override fun onNotificationPosted(sbn: StatusBarNotification) {}
    override fun onNotificationRemoved(sbn: StatusBarNotification) {}
}
