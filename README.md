# peertube-plugin-embed-error-events

Forwards video player errors from the PeerTube embed iframe to the parent window via `postMessage`. Enables external error handling for embedded PeerTube players.

## Why This Plugin Exists

The PeerTube embed API (v0.2.0+) exposes playback events like `pause`, `play`, `playbackStatusUpdate`, `resolutionUpdate`, and `volumeChange` -- but **zero error events**. When something goes wrong inside the iframe (HLS manifest 404, network drop, decode failure), the parent page has no way to know.

This is a known limitation tracked in upstream PeerTube issues:

- [PeerTube#468](https://github.com/Chocobozzz/PeerTube/issues/468) -- requesting error events (open since 2019)
- [PeerTube#2522](https://github.com/Chocobozzz/PeerTube/issues/2522) -- `player.ready()` hangs forever with no error signal

### Use Cases

- **Custom player UI on top of the embed API** -- If you build your own controls, overlay, or player chrome around the PeerTube embed iframe, you need error events to show error states, retry buttons, or fallback content. Without this plugin your UI stays in a "playing" state while the iframe shows an error.
- **Video monitoring and analytics** -- Track playback failures across your PeerTube instance or a fleet of embeds to identify broken videos, infrastructure issues, or transcoding problems.
- **Third-party integrations** -- LMS platforms, digital signage, or kiosk apps that embed PeerTube videos can detect failures and react (e.g. skip to the next video, alert an operator).
### Errors that go undetected without this plugin

| Error | What happens | User sees |
|---|---|---|
| HLS.js `manifestLoadError` (fatal) | PeerTube shows error inside iframe | Custom controls still show "playing" |
| `fragLoadError` mid-stream | Playback stalls with spinner inside iframe | Parent page is unaware |
| `bufferStalledError` | Quality degrades silently | No notification possible |
| Network drop during playback | Iframe goes dark | No parent notification |
| Transcoding not finished | Video returns 200 but has no valid streams | Silent failure |

## Compatibility

- **PeerTube**: >= 6.0.0 (tested on v8.0.2)
- **Browsers**: All modern browsers (uses `postMessage` and `addEventListener`)

## Installation

### Option A: Install via npm (recommended for PeerTube Admin UI)

```bash
npm publish  # or publish to your private registry
```

Then in PeerTube Admin UI: **Administration** > **Plugins/Themes** > **Search** > search for `peertube-plugin-embed-error-events` > **Install**.

### Option B: Install from local path via CLI

```bash
# Copy plugin to server
scp -r peertube-plugin-embed-error-events \
  user@your-server:/tmp/peertube-plugin-embed-error-events

# On the server
sudo mv /tmp/peertube-plugin-embed-error-events \
  /var/www/peertube/storage/plugins/node_modules/peertube-plugin-embed-error-events
sudo chown -R peertube:peertube \
  /var/www/peertube/storage/plugins/node_modules/peertube-plugin-embed-error-events

# Register the plugin
cd /var/www/peertube/peertube-latest
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config \
  NODE_ENV=production \
  npx peertube plugins:install \
  --path /var/www/peertube/storage/plugins/node_modules/peertube-plugin-embed-error-events

# Restart PeerTube
sudo systemctl restart peertube
```

### Option C: Install via REST API

```bash
PEERTUBE_URL="https://your-peertube-instance.com"

# Get OAuth credentials
CLIENT_INFO=$(curl -s "$PEERTUBE_URL/api/v1/oauth-clients/local")
CLIENT_ID=$(echo "$CLIENT_INFO" | jq -r '.client_id')
CLIENT_SECRET=$(echo "$CLIENT_INFO" | jq -r '.client_secret')

TOKEN=$(curl -s "$PEERTUBE_URL/api/v1/users/token" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "grant_type=password" \
  -d "username=root" \
  -d "password=YOUR_ADMIN_PASSWORD" | jq -r '.access_token')

# Install from local path on the server
curl -s -X POST "$PEERTUBE_URL/api/v1/plugins/install" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/peertube-plugin-embed-error-events"}'
```

## Usage

Listen for error messages from the embedded PeerTube player in your parent page:

```javascript
window.addEventListener('message', (event) => {
  try {
    const data = JSON.parse(event.data)
    if (data.method && data.method.endsWith('::error')) {
      const error = data.params
      console.log('PeerTube error:', error)

      if (error.fatal) {
        // Show error UI, retry, or fallback
      }
    }
  } catch {}
})
```

## Message Format

Messages use the jschannel notification format (same structure the PeerTube embed SDK uses for other events like `playbackStatusUpdate`):

```json
{
  "method": "peertube::error",
  "params": {
    "fatal": true,
    "type": "networkError",
    "details": "manifestLoadError",
    "message": "A network error occurred while loading the manifest",
    "url": "https://...",
    "httpStatus": 404,
    "videoId": "uuid-of-video"
  }
}
```

### Error types

| `type` | Source | Description |
|---|---|---|
| `media` | Video.js / HTMLMediaElement | Fatal player error (decode, format, network) |
| `networkError` | HLS.js | Network error (manifest/fragment load failure) |
| `mediaError` | HLS.js | Media/decode error |
| `muxError` | HLS.js | Mux/remux error |
| `otherError` | HLS.js | Other HLS.js error |
| `network` | Browser | Browser went offline |
| `recovery` | Browser | Browser back online (not an error; use to dismiss warnings) |

### Fields

| Field | Type | Description |
|---|---|---|
| `fatal` | `boolean` | Whether playback is unrecoverable |
| `type` | `string` | Error category (see table above) |
| `details` | `string` | Specific error code (e.g. `manifestLoadError`, `fragLoadError`, `MEDIA_ERR_3`) |
| `message` | `string` | Human-readable error message |
| `videoId` | `string` | UUID of the video |
| `url` | `string?` | Failed URL (HLS.js errors only) |
| `httpStatus` | `number?` | HTTP status code (HLS.js network errors only) |
| `code` | `number?` | MediaError code (Video.js/native errors only) |

## How It Works

The plugin registers on the `action:embed.player.loaded` hook and attaches error listeners at multiple layers:

1. **Video.js player errors** -- catches all fatal errors including HLS.js bubbled-up errors
2. **Native `<video>` element errors** -- fallback for errors Video.js doesn't catch (with deduplication)
3. **HLS.js errors** -- direct access via `tech.hlsjs` or `tech.hls` for detailed error types and non-fatal warnings
4. **Browser online/offline** -- network state changes

All errors are forwarded to `window.parent.postMessage()` in jschannel format.

## Verification

After installation, open any video embed URL with the API enabled:

```
https://your-peertube.com/videos/embed/<VIDEO_UUID>?api=1
```

Open browser DevTools console and look for:

```
[embed-error-events] Error forwarding active for video: <UUID>
[embed-error-events] HLS.js error forwarding active
```

To test error forwarding, trigger an error:
- Use a non-existent video UUID (media error)
- Disconnect network mid-playback (offline event)
- Throttle network in DevTools (HLS.js `fragLoadError`)

## Uninstallation

**Admin UI**: Administration > Plugins/Themes > Installed > embed-error-events > Uninstall

**CLI**:
```bash
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config \
  NODE_ENV=production \
  npx peertube plugins:uninstall \
  --npm-name peertube-plugin-embed-error-events
```

**API**:
```bash
curl -s -X POST "$PEERTUBE_URL/api/v1/plugins/uninstall" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"npmName": "peertube-plugin-embed-error-events"}'
```

## Troubleshooting

| Issue | Solution |
|---|---|
| Plugin not in installed list | Verify directory is in `storage/plugins/node_modules/` with correct `package.json` |
| No console log in embed page | Clear browser cache; check plugin scope is `["embed"]` in `package.json` |
| `HLS.js instance not found` log | Normal for web-video mode (non-HLS); Video.js error handler still catches fatal errors |
| `postMessage failed` log | Parent and iframe are on different origins with restrictive CSP |

## License

AGPL-3.0 (same as PeerTube)
