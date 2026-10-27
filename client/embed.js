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

/**
 * The HLS.js instance behind the player. PeerTube >= 7 keeps it in the
 * p2p-media-loader plugin (and as the Hlsjs tech's `hlsProvider`); older
 * versions exposed it on the tech directly.
 */
function findHls(player) {
  if (!player) return null
  try {
    var loader = typeof player.p2pMediaLoader === 'function' && player.p2pMediaLoader()
    var fromLoader = loader && typeof loader.getHLSJS === 'function' && loader.getHLSJS()
    if (fromLoader) return fromLoader
  } catch (_) {}
  try {
    var tech = player.tech({ IWillNotUseThisInPlugins: true })
    if (tech) return tech.hlsjs || tech.hls || (tech.hlsProvider && tech.hlsProvider.hls) || null
  } catch (_) {}
  return null
}

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

      // The hook's `videojs` arg is the video.js LIBRARY, not the player: calling
      // .on()/.error()/.el()/.tech() on it throws or finds nothing, so every error
      // listener below must hang off the resolved player.
      var player = resolvePlayer()
      var mediaEl = (player && typeof player.el === 'function' && player.el() && player.el().querySelector('video')) ||
        document.querySelector('video')

      // --- 1. Video.js player errors (catches all fatal errors including HLS.js bubbled-up) ---
      // PeerTube gives up after repeated HLS load failures (e.g. an expired file
      // token) and reports it here as MEDIA_ERR_NETWORK.
      try {
        player.on('error', function () {
          var err = player.error()
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
        console.debug('[embed-error-events] player.on("error") not supported, using native fallback:', e.message)
      }

      // --- 2. Native <video> element errors (fallback for errors video.js doesn't catch) ---
      if (mediaEl) {
        mediaEl.addEventListener('error', function () {
          var err = mediaEl.error
          if (!err) return

          // Avoid duplicate if video.js already caught this
          try {
            var vjsErr = player && player.error()
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
      // PeerTube usually creates HLS.js after this hook ran (and again for a new
      // source), announcing it with `hlsjs-initialized`; attach to each instance once.
      var hlsInstances = []
      function forwardHlsErrors(hls) {
        if (!hls || typeof hls.on !== 'function' || hlsInstances.indexOf(hls) !== -1) return
        hlsInstances.push(hls)
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
      }

      try {
        forwardHlsErrors(findHls(player))
        player.on('hlsjs-initialized', function (_event, data) {
          forwardHlsErrors((data && data.hlsjs) || findHls(player))
        })
      } catch (e) {
        // No player or tech access (web-video mode, etc.)
        console.debug('[embed-error-events] Could not access HLS.js:', e.message)
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
      // Audio ops fall back to the native <video> element (verified to unmute on Safari).
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
