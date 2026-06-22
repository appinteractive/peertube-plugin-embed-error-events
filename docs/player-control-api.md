# Player Control API (mute / unmute / fullscreen)

Extends the embed plugin with a **parent → iframe command channel** so the host
page can drive player state that the official `@peertube/embed-api` cannot reach.

## Why this is needed

`@peertube/embed-api` exposes only `setVolume(value)` / `getVolume()`. It has **no
`setMuted`/`unmute`**, and `setVolume` maps to video.js `player.volume(v)`, which
sets the volume *level* but does **not** clear the `muted` flag. PeerTube starts
the embed with the real `muted` property (Safari's autoplay policy requires it),
so on Safari the video plays muted and **nothing in the public API can un-mute it**
— the host's volume/mute controls "respond" but produce no sound.

A plugin runs *inside* the iframe with direct `player` access, so it can call
`player.muted(false)` (verified to restore audio on Safari desktop) and
`player.requestFullscreen()`. This file specifies that command channel.

## Message protocol

All messages are JSON **strings** (same format the plugin already uses for
`::error`). `scope` is the embed scope (URL `?scope=`, default `peertube`),
identical to the existing `::error` handler.

### Parent → iframe (commands)

```jsonc
{ "method": "peertube::command", "params": { "action": "unmute" } }
```

| `action`           | Effect (video.js)                                  |
| ------------------ | -------------------------------------------------- |
| `mute`             | `player.muted(true)`                               |
| `unmute`           | `player.muted(false)`                              |
| `toggleMute`       | `player.muted(!player.muted())`                    |
| `enterFullscreen`  | `player.requestFullscreen()`                       |
| `exitFullscreen`   | `player.exitFullscreen()`                          |
| `toggleFullscreen` | request/exit based on `player.isFullscreen()`      |

### iframe → parent (state)

Once at player load, after every command, and on `volumechange` /
`fullscreenchange`, the plugin emits the ground-truth audio/fullscreen state so
the host can sync its UI:

```jsonc
{ "method": "peertube::state", "params": { "muted": false, "volume": 1, "fullscreen": false } }
```

`volume` is the **effective** level — reported as `0` while `muted` is true — so
the host (which treats `volume === 0` as muted) stays consistent even at the
autoplay-muted start, where `player.muted()` is true but `player.volume()` is 1.
This event is **required** for correct host behavior: the host shows a fallback
"unmute" button while muted, needs the `muted:false` confirmation to hide it once
sound is actually on (and to re-show it if an unmute was refused), and relies on
the initial emit to learn the embed started muted.

## Reference implementation (drop into `client/embed.js`)

Inside the existing `action:embed.player.loaded` handler (`videojs` is the player
instance, `videoEl` is the native `<video>`), add:

```js
// --- 6. Player control commands (parent → iframe) ---
function emitState () {
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
function syncMutedToVolume () {
  try {
    if (videojs.volume() === 0 && !videojs.muted()) videojs.muted(true)
  } catch (_) {}
}

function handleCommand (action) {
  try {
    switch (action) {
      case 'mute':       videojs.muted(true); break
      case 'unmute':     videojs.muted(false); break
      case 'toggleMute': videojs.muted(!videojs.muted()); break
      case 'enterFullscreen': videojs.requestFullscreen && videojs.requestFullscreen(); break
      case 'exitFullscreen':  videojs.exitFullscreen && videojs.exitFullscreen(); break
      case 'toggleFullscreen':
        if (videojs.isFullscreen && videojs.isFullscreen()) videojs.exitFullscreen()
        else videojs.requestFullscreen && videojs.requestFullscreen()
        break
      default: return
    }
  } catch (e) {
    console.debug('[embed-error-events] command failed:', action, e && e.message)
  }
  emitState()
}

// Keep the host UI in sync with player-driven changes, and couple mute→volume.
try {
  videojs.on('volumechange', function () { syncMutedToVolume(); emitState() })
  videojs.on('fullscreenchange', emitState)
} catch (_) {}

// Report the initial state once the player is up (catches the autoplay-muted
// start, where the host otherwise can't tell the embed is muted).
emitState()
```

Add a `window.addEventListener('message', …)` handler that parses the incoming
JSON and dispatches commands:

```js
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
```

Notes:
- **iOS native fullscreen:** `player.requestFullscreen()` covers desktop. For iOS
  you may need `videoEl.webkitEnterFullscreen()` as a fallback inside
  `enterFullscreen`/`toggleFullscreen`.
- **Fullscreen is activation-gated:** the Fullscreen API requires transient user
  activation, which a `postMessage` does not carry across the cross-origin frame.
  Unmute (`player.muted(false)`) was verified to work on Safari desktop without a
  gesture, but fullscreen-via-postMessage may be refused there — test it the same
  way (`document.querySelector('video').webkitEnterFullscreen?.()` from the iframe
  console). The host keeps its own container-fullscreen as the desktop default;
  the plugin fullscreen is primarily for native in-iframe / iOS fullscreen.

## Security

The command handler accepts any origin (same as the `::error` channel). Since
these commands mutate player state, you **may** validate the sender against the
embedding host before acting:

```js
var ALLOWED_PARENT_ORIGINS = ['https://your-host.example']
// inside the message handler, before handleCommand:
if (ALLOWED_PARENT_ORIGINS.indexOf(event.origin) === -1) return
```

(Mute/fullscreen aren't sensitive, but an allowlist avoids any cross-site
surprises and is cheap.)

## Versioning

Bump `package.json` to **1.2.0** (additive, backward-compatible). The host treats
the channel as best-effort: commands are no-ops on older plugin versions, and the
host falls back to its prominent unmute button if `::state` never confirms sound.

## Host (storefront) contract — already implemented

- Sends `peertube::command` `{ action: 'unmute' }` (a) automatically once playback
  starts muted on Safari, and (b) from the prominent "Ton aktivieren" button click;
  `mute`/`unmute` also on the mute toggle.
- Listens for `peertube::state` and feeds `{ muted, volume }` into the player state
  machine so the unmute button hides once `muted:false` is confirmed (and re-shows
  if still muted).
- Origin-validates `::state` messages against the PeerTube host (same pattern as
  the existing `::error` listener in `use-peertube-watchdog.ts`).
