package com.nikkiro.audiovisualizer

import android.media.session.MediaController

/**
 * In-process pub/sub between NowPlayingListenerService (which owns the real
 * MediaController references and hears every session change) and
 * NowPlayingPlugin (which the JS side talks to). Both live in the same app
 * process, so no IPC is needed here — unlike the Electron main/renderer
 * split, this is just a shared singleton.
 */
object NowPlayingBridge {

    data class NowPlayingState(
        val active: Boolean = false,
        val title: String = "",
        val artist: String = "",
        val source: String = "",
        val positionMs: Long = 0,
        val durationMs: Long = 0,
        val isPlaying: Boolean = false,
        val lastUpdated: Long = System.currentTimeMillis()
    )

    var state: NowPlayingState = NowPlayingState()
        private set

    private var activeController: MediaController? = null
    private val listeners = mutableListOf<(NowPlayingState) -> Unit>()

    fun addListener(listener: (NowPlayingState) -> Unit) {
        listeners.add(listener)
        listener(state)
    }

    fun removeListener(listener: (NowPlayingState) -> Unit) {
        listeners.remove(listener)
    }

    fun update(newState: NowPlayingState, controller: MediaController?) {
        state = newState
        activeController = controller
        listeners.toList().forEach { it(newState) }
    }

    fun clear() {
        if (!state.active) return
        update(NowPlayingState(active = false), null)
    }

    fun play() = activeController?.transportControls?.play()
    fun pause() = activeController?.transportControls?.pause()
    fun next() = activeController?.transportControls?.skipToNext()
    fun previous() = activeController?.transportControls?.skipToPrevious()
}
