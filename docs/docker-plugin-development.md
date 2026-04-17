# Docker Plugin Development Workflow

A guide for developing and debugging this plugin with a Docker Compose PeerTube setup.

The key insight is that server-side plugin code is dynamically reloaded by `plugin:install` — you don't need to restart the container on every change.

## Setup

### 1. Mount the plugin source into the container

In your `docker-compose.yml`, add a volume to the peertube service so the container can see the plugin folder:

```yaml
services:
  peertube:
    volumes:
      - ./docker-volume/data:/data
      - ./peertube-plugin-embed-error-events:/plugin-dev/peertube-plugin-embed-error-events
```

Restart once to pick up the mount:

```bash
docker compose up -d
```

### 2. Install the plugin from the mounted path

```bash
docker compose exec -u peertube peertube npm run plugin:install -- --plugin-path /plugin-dev/peertube-plugin-embed-error-events
```

## Iterating

- **Server-side changes** (`main.js`): Re-run the same `plugin:install` command — plugins are dynamically loaded, no container restart needed.
- **Client-side changes** (`client/embed.js`): Re-run `plugin:install`, then hard refresh the browser (Cmd+Shift+R / Ctrl+Shift+R).

## Debugging

### Server-side logging

The `main.js` in this plugin is minimal (only registers a settings page), but if you add server-side hooks, use the injected logger — it lands in PeerTube's log stream:

```js
async function register({ registerHook, peertubeHelpers: { logger } }) {
  logger.info('embed-error-events plugin loaded')
}
```

### Client-side debugging

This plugin runs inside the embed iframe. To debug:

1. Open an embed URL with the API enabled: `https://your-instance/videos/embed/<UUID>?api=1`
2. Open browser devtools and check the console for `[embed-error-events]` messages:
   - `[embed-error-events] Error forwarding active for video: <UUID>`
   - `[embed-error-events] HLS.js error forwarding active`
3. The plugin's client script is visible in devtools under `/plugins/embed-error-events/...`

### Testing error forwarding

Trigger errors to verify `postMessage` works:

- Use a non-existent video UUID (media error)
- Disconnect network mid-playback (offline event)
- Throttle network in devtools (HLS.js `fragLoadError`)

Listen in the parent page console:

```js
window.addEventListener('message', (e) => {
  try {
    const data = JSON.parse(e.data)
    if (data.method && data.method.endsWith('::error')) console.log('Error:', data.params)
  } catch {}
})
```

### Tailing server logs

Live stream:

```bash
docker compose logs -f peertube
```

Structured filtering (filters out request and query noise):

```bash
docker compose exec -u peertube peertube npm run parse-log -- --level debug --not-tags http sql
```

## Things to Know

- Make sure `engine.peertube` in `package.json` (currently `>=6.0.0`) matches the version of the PeerTube container, otherwise install will fail with a version mismatch.
- The `HLS.js instance not found` log is normal in web-video mode (non-HLS). The Video.js error handler still catches fatal errors.

## Publishing

Once you're happy:

1. Bump version in `package.json`
2. `npm publish`
3. PeerTube's plugin index picks it up within about a day
