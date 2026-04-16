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
       * Send an error notification to the parent window using the jschannel
       * notification format (same structure the PeerTube embed SDK uses for
       * playbackStatusUpdate, volumeChange, etc.).
       */
      function notifyParent(errorData) {
        try {
          window.parent.postMessage(JSON.stringify({
            method: scope + '::error',
            params: errorData
          }), '*')
        } catch (e) {
          // postMessage can fail if parent is cross-origin restricted
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

          notifyParent({
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

          notifyParent({
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
        var tech = videojs.tech({ IWillNotUseThisInPlugins: true })

        // PeerTube uses p2p-media-loader which wraps HLS.js.
        // Try multiple access paths to find the HLS.js instance.
        var hls = null

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
            notifyParent({
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
        notifyParent({
          fatal: false,
          type: 'network',
          details: 'offline',
          message: 'Browser went offline',
          videoId: video.uuid || ''
        })
      })

      window.addEventListener('online', function () {
        notifyParent({
          fatal: false,
          type: 'recovery',
          details: 'online',
          message: 'Browser back online',
          videoId: video.uuid || ''
        })
      })

      console.debug('[embed-error-events] Error forwarding active for video:', video.uuid)
    }
  })
}

export { register }
