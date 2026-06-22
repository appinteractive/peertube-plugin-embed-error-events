/**
 * PeerTube Embed Error Events Plugin
 *
 * Runs inside the embed iframe and forwards player errors to the parent window
 * via postMessage using jschannel-compatible message format.
 *
 * The parent page can listen for these messages with:
 *   window.addEventListener('message', (event) => {
 *     const data = JSON.parse(event.data)
 *     if (data.method?.endsWith('::error')) {
 *       const error = data.params
 *       // error.fatal, error.type, error.details, error.message, ...
 *     }
 *   })
 */

async function register({ registerHook }) {
  registerHook({
    target: 'action:embed.player.loaded',
    handler: function ({ player: hookPlayer, videojs, video }) {
      var scope = new URLSearchParams(window.location.search).get('scope') || 'peertube'

      /**
       * Send a notification to the parent window using the jschannel
       * notification format (same structure the PeerTube embed SDK uses for
       * playbackStatusUpdate, volumeChange, etc.).
       *
       * @param {string} method - fully-qualified method, e.g. scope + '::error'
       * @param {object} params - notification payload
       */
      function notifyParent(method, params) {
        try {
          window.parent.postMessage(JSON.stringify({
            method: method,
            params: params
          }), '*')
        } catch (e) {
          console.debug('[embed-error-events] postMessage failed:', e.message)
        }
      }

      // --- 1. Video.js player errors (catches all fatal errors including HLS.js bubbled-up) ---
      // Use try-catch because some PeerTube versions wrap .on() with a WeakMap
      // that cannot accept string keys, causing "WeakMap key must be an object".
      try {
        videojs.on('error', function () {
          var err = videojs.error()
          if (!err) return

          notifyParent(scope + '::error', {
            fatal: true,
            type: 'media',
            code: err.code,
            message: err.message || '',
            details: 'MEDIA_ERR_' + err.code,
            videoId: video.uuid || ''
          })
        })
      } catch (e) {
        console.debug('[embed-error-events] videojs.on("error") not supported, using native fallback:', e.message)
      }

      // --- 2. Native <video> element errors (fallback for errors video.js doesn't catch) ---
      var videoEl = videojs.el && videojs.el() && videojs.el().querySelector('video')
      if (videoEl) {
        videoEl.addEventListener('error', function () {
          var err = videoEl.error
          if (!err) return

          // Avoid duplicate if video.js already caught this
          try {
            var vjsErr = videojs.error && videojs.error()
            if (vjsErr && vjsErr.code === err.code) return
          } catch (_) {
            // videojs.error() may not be available
          }

          notifyParent(scope + '::error', {
            fatal: true,
            type: 'media',
            code: err.code,
            message: err.message || '',
            details: 'VIDEO_ERR_' + err.code,
            videoId: video.uuid || ''
          })
        })
      }

      // --- 3. HLS.js errors (best-effort — provides detailed error types) ---
      try {
        var hls = null
        var tech = videojs.tech({ IWillNotUseThisInPlugins: true })

        // PeerTube uses p2p-media-loader which wraps HLS.js.
        // Try multiple access paths to find the HLS.js instance.
        if (tech && tech.hlsjs) {
          hls = tech.hlsjs
        } else if (tech && tech.hls) {
          hls = tech.hls
        } else if (tech && typeof tech.vhs !== 'undefined' && tech.vhs && tech.vhs.playlists) {
          // VHS/http-streaming tech — no direct HLS.js access
          hls = null
        }

        if (hls && typeof hls.on === 'function') {
          // HLS.js events — Hls.Events.ERROR = 'hlsError'
          hls.on('hlsError', function (_event, data) {
            notifyParent(scope + '::error', {
              fatal: !!data.fatal,
              type: data.type || 'unknown',
              details: data.details || '',
              message: (data.reason || (data.error && data.error.message) || ''),
              url: data.url || '',
              httpStatus: (data.response && data.response.code) || null,
              videoId: video.uuid || ''
            })
          })
          console.debug('[embed-error-events] HLS.js error forwarding active')
        } else {
          console.debug('[embed-error-events] HLS.js instance not found — using video.js errors only')
        }
      } catch (e) {
        // Tech access not available (web-video mode, etc.)
        console.debug('[embed-error-events] Could not access tech layer:', e.message)
      }

      // --- 4. Network state (online/offline) ---
      window.addEventListener('offline', function () {
        notifyParent(scope + '::error', {
          fatal: false,
          type: 'network',
          details: 'offline',
          message: 'Browser went offline',
          videoId: video.uuid || ''
        })
      })

      window.addEventListener('online', function () {
        notifyParent(scope + '::error', {
          fatal: false,
          type: 'recovery',
          details: 'online',
          message: 'Browser back online',
          videoId: video.uuid || ''
        })
      })

      // --- 5. Player control commands (parent -> iframe) ---
      // NOTE: the hook's `videojs` arg is the video.js LIBRARY, not the player —
      // it has no .muted()/.volume()/.tech(). Resolve the real player; fall back to
      // the native <video> element for audio ops (verified to unmute on Safari).
      function resolvePlayer() {
        if (hookPlayer && typeof hookPlayer.muted === 'function') return hookPlayer
        // The embed also exposes the player as window.videojsPlayer (see PeerTube
        // embed.ts) — a stable handle independent of the hook param shape.
        try {
          if (window.videojsPlayer && typeof window.videojsPlayer.muted === 'function') return window.videojsPlayer
        } catch (_) {}
        try {
          if (videojs && typeof videojs.getAllPlayers === 'function') {
            var arr = videojs.getAllPlayers()
            if (arr && arr[0]) return arr[0]
          }
        } catch (_) {}
        try {
          if (videojs && videojs.players) {
            for (var id in videojs.players) {
              if (videojs.players[id]) return videojs.players[id]
            }
          }
        } catch (_) {}
        return null
      }

      var player = resolvePlayer()
      var mediaEl = document.querySelector('video')

      function isMuted() {
        try { if (player && typeof player.muted === 'function') return !!player.muted() } catch (_) {}
        return mediaEl ? !!mediaEl.muted : false
      }
      function getVolume() {
        try { if (player && typeof player.volume === 'function') return player.volume() } catch (_) {}
        return mediaEl ? mediaEl.volume : 1
      }
      // Set BOTH the player (keeps video.js state in sync) and the native element
      // (the lever proven to work on Safari) so the change sticks.
      function setMuted(m) {
        try { if (player && typeof player.muted === 'function') player.muted(m) } catch (_) {}
        if (mediaEl) mediaEl.muted = m
      }

      function emitState() {
        try {
          var muted = isMuted()
          notifyParent(scope + '::state', {
            muted: muted,
            // Effective level: 0 while muted, so the host (which treats volume===0
            // as muted) stays in sync even at the autoplay-muted start.
            volume: muted ? 0 : getVolume(),
            fullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement)
          })
        } catch (_) {}
      }

      // Couple the muted flag to the level in the MUTING direction only: dragging the
      // volume to 0 mutes the embed. Unmuting stays command-driven (handleCommand
      // 'unmute') so we never fight Safari by re-unmuting in a volumechange loop.
      function syncMutedToVolume() {
        try { if (getVolume() === 0 && !isMuted()) setMuted(true) } catch (_) {}
      }

      // Desktop uses player/native requestFullscreen; iOS Safari needs the native
      // <video> presentation mode.
      function requestFullscreen() {
        if (player && typeof player.requestFullscreen === 'function') player.requestFullscreen()
        else if (mediaEl && mediaEl.requestFullscreen) mediaEl.requestFullscreen()
        else if (mediaEl && mediaEl.webkitEnterFullscreen) mediaEl.webkitEnterFullscreen()
      }
      function exitFullscreen() {
        if (player && typeof player.exitFullscreen === 'function') player.exitFullscreen()
        else if (document.exitFullscreen) document.exitFullscreen()
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen()
      }

      function handleCommand(action) {
        try {
          switch (action) {
            case 'mute':       setMuted(true); break
            case 'unmute':     setMuted(false); break
            case 'toggleMute': setMuted(!isMuted()); break
            case 'enterFullscreen': requestFullscreen(); break
            case 'exitFullscreen':  exitFullscreen(); break
            case 'toggleFullscreen':
              if (document.fullscreenElement || document.webkitFullscreenElement) exitFullscreen()
              else requestFullscreen()
              break
            default: return
          }
        } catch (e) {
          console.debug('[embed-error-events] command failed:', action, e && e.message)
        }
        emitState()
      }

      // Listen on the native element/document so events fire regardless of the
      // video.js wrapper, and couple mute->volume.
      if (mediaEl) {
        mediaEl.addEventListener('volumechange', function () { syncMutedToVolume(); emitState() })
      }
      document.addEventListener('fullscreenchange', emitState)
      document.addEventListener('webkitfullscreenchange', emitState)

      // Accept commands from the parent. Origin is intentionally not validated here
      // (mute/fullscreen aren't sensitive, matching the existing ::error channel).
      // To lock this down, gate on event.origin before calling handleCommand:
      //   var ALLOWED = ['https://example.com']
      //   if (ALLOWED.indexOf(event.origin) === -1) return
      window.addEventListener('message', function (event) {
        var data
        try {
          data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        } catch (_) {
          return
        }
        if (data && data.method === scope + '::command' && data.params && data.params.action) {
          handleCommand(data.params.action)
        }
      })

      // Report the initial state once the player is up (catches the autoplay-muted
      // start, where the host otherwise can't tell the embed is muted).
      emitState()

      console.debug('[embed-error-events] Error forwarding active for video:', video.uuid)
    }
  })
}

export { register }
