# Proposal: add `setMuted` / `getMuted` to the embed API (+ `muted` in volume state)

Draft for an issue/PR against [Chocobozzz/PeerTube](https://github.com/Chocobozzz/PeerTube).
Paste into a new issue, or open a PR with the sketch below.

---

## Summary

The embed API (`@peertube/embed-api`) can change the **volume level** but cannot
change the **muted flag**, and never reports muted state to the host. This makes it
impossible for an embedding page to reliably restore audio after a muted autoplay —
the single most common embed scenario on Safari.

## Why `setVolume` is not enough

Browsers (Safari especially) only allow autoplay when the media is **muted**
(the real `muted` property, not `volume = 0`). To unmute, the host must clear that
flag. But:

- The SDK exposes only `play/pause/setVolume/getVolume/setCaption/seek/setResolution/setPlaybackRate/...`
  — there is no `setMuted`/`getMuted`
  (`client/src/standalone/embed-player-api/player.ts`).
- `setVolume` maps to `player.volume(value)` only — it never touches `muted`:
  ```ts
  // client/src/standalone/videos/embed-api.ts
  channel.bind('setVolume', (txn, value) => this.player.volume(value))
  ```
  So `setVolume(1)` on a muted player sets the level but produces no sound.
- The `volumeChange` event reports `this.player.volume()` (raw level), never the
  muted flag — so the host can't even tell the embed is muted (e.g. at the
  autoplay-muted start, `volume` is 1 but there's no audio).

Because the embed is cross-origin, the host also cannot reach the `<video>` element
directly. Today the only workaround is a custom embed **plugin** that calls
`player.muted(false)` in-iframe — which works, but every integrator has to ship one.

## Proposal

Add to the embed API, mirroring the existing volume methods:

- `setMuted(muted: boolean): Promise<void>` → `player.muted(muted)`
- `getMuted(): Promise<boolean>` → `player.muted()`
- include `muted` in the `volumeChange` event payload (and/or add a `mutedChange`
  event) so hosts can sync their UI.

This is additive and backward-compatible.

## Patch sketch

**`client/src/standalone/videos/embed-api.ts`** — bind the channel methods + emit muted:
```ts
channel.bind('setMuted', (txn, value) => this.player.muted(!!value))
channel.bind('getMuted', txn => this.player.muted())
// in the volumechange handler, include muted alongside volume:
//   params: { volume: this.player.volume(), muted: this.player.muted() }
```

**`client/src/standalone/embed-player-api/player.ts`** — SDK wrappers:
```ts
async setMuted (muted: boolean) { await this.sendMessage('setMuted', muted) }
async getMuted (): Promise<boolean> { return this.sendMessage('getMuted') }
```

**`definitions.ts` / `events.ts`** — add the `setMuted`/`getMuted` types and extend
the `volumeChange` payload (or add `mutedChange`).

## Use case

```ts
const player = new PeerTubePlayer(iframe)
await player.ready
// after a muted autoplay, on a user gesture:
await player.setMuted(false)   // restores audio — impossible today
```

Without this, integrators must autoplay muted (Safari requirement) with no
supported way to ever turn sound back on.
