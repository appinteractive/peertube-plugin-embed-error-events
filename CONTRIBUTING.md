# Contributing

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install the plugin on a local PeerTube instance (see README for installation options)
4. Make your changes
5. Test on a running PeerTube instance with an embedded video (`/videos/embed/<UUID>?api=1`)
6. Open a pull request

## Testing

There is no build step. The plugin runs plain JavaScript directly. To verify your changes:

1. Install the plugin on a PeerTube instance
2. Open an embed URL with `?api=1`
3. Check the browser console for `[embed-error-events]` log messages
4. Trigger errors (invalid video UUID, network throttling, offline toggle) and confirm they are forwarded via `postMessage`

## Guidelines

- Keep it simple -- this plugin is intentionally small and dependency-free
- Use plain JavaScript (no transpilation, no build tools)
- Test on PeerTube >= 6.0.0
- Follow the existing code style

## Reporting Bugs

Open an issue using the bug report template. Include your PeerTube version, browser, and any console output.
