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
    handler: function ({ videojs, video }) {
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
      function emitState() {
        try {
          var muted = !!videojs.muted()
          var vol = typeof videojs.volume === 'function' ? videojs.volume() : 1
          notifyParent(scope + '::state', {
            muted: muted,
            // Report the *effective* level: 0 while muted. The host's model treats
            // volume===0 as muted, so this keeps the player UI and host state in sync
            // even at the autoplay-muted start (where muted=true but volume=1).
            volume: muted ? 0 : vol,
            fullscreen: typeof videojs.isFullscreen === 'function' ? videojs.isFullscreen() : false
          })
        } catch (_) {}
      }

      // Couple the muted flag to the level in the MUTING direction only: dragging the
      // volume to 0 mutes the embed. Unmuting stays command-driven (handleCommand
      // 'unmute') so we never fight Safari by re-unmuting in a volumechange loop.
      function syncMutedToVolume() {
        try {
          if (videojs.volume() === 0 && !videojs.muted()) videojs.muted(true)
        } catch (_) {}
      }

      function handleCommand(action) {
        try {
          switch (action) {
            case 'mute':       videojs.muted(true); break
            case 'unmute':     videojs.muted(false); break
            case 'toggleMute': videojs.muted(!videojs.muted()); break
            case 'enterFullscreen': requestFullscreen(); break
            case 'exitFullscreen':  videojs.exitFullscreen && videojs.exitFullscreen(); break
            case 'toggleFullscreen':
              if (videojs.isFullscreen && videojs.isFullscreen()) videojs.exitFullscreen()
              else requestFullscreen()
              break
            default: return
          }
        } catch (e) {
          console.debug('[embed-error-events] command failed:', action, e && e.message)
        }
        emitState()
      }

      // Desktop uses video.js requestFullscreen; iOS Safari has no Fullscreen API
      // on arbitrary elements, so fall back to the native <video> presentation.
      function requestFullscreen() {
        if (videojs.requestFullscreen) {
          videojs.requestFullscreen()
        } else if (videoEl && videoEl.webkitEnterFullscreen) {
          videoEl.webkitEnterFullscreen()
        }
      }

      // Keep the host UI in sync with player-driven changes, and couple mute->volume.
      try {
        videojs.on('volumechange', function () { syncMutedToVolume(); emitState() })
        videojs.on('fullscreenchange', emitState)
      } catch (_) {}

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
