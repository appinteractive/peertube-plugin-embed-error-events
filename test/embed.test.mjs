// Runs client/embed.js against fake video.js / HLS.js / DOM objects, so no
// PeerTube instance or browser is needed. Shapes follow PeerTube 8.3 (checked
// against a live embed): the hook gets the video.js LIBRARY as `videojs`, the
// player as `player`, and HLS.js sits behind player.p2pMediaLoader().getHLSJS().
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The package is CommonJS (main.js) and the client script is an ES module
// without a .mjs extension, so load it as a data: module (works on Node 20).
const source = await readFile(new URL('../client/embed.js', import.meta.url), 'utf8')
const { register } = await import('data:text/javascript,' + encodeURIComponent(source))

function emitter() {
  const listeners = {}
  return {
    on(type, fn) { (listeners[type] ||= []).push(fn) },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn) },
    emit(type, ...args) { for (const fn of listeners[type] || []) fn(...args) }
  }
}

function fakeMediaEl() {
  return Object.assign(emitter(), { error: null, muted: false, volume: 1 })
}

function fakeHls() {
  return emitter()
}

function fakePlayer({ mediaEl = fakeMediaEl(), hls = fakeHls(), tech = { name_: 'Hlsjs' } } = {}) {
  const player = emitter()
  let error = null
  let muted = false
  return Object.assign(player, {
    mediaEl,
    hls,
    error: () => error,
    fail(code, message) { error = { code, message }; player.emit('error') },
    recover() { error = null; player.emit('playing') },
    el: () => ({ querySelector: () => mediaEl }),
    tech: () => tech,
    p2pMediaLoader: () => ({ getHLSJS: () => hls }),
    muted: (value) => { if (value === undefined) return muted; muted = value },
    volume: () => 1
  })
}

/** The video.js library as PeerTube passes it: .on() throws, no player methods. */
const videojsLibrary = {
  on() { throw new TypeError('WeakMap key must be an object') },
  getAllPlayers: () => []
}

let sent
let win
let doc

beforeEach(() => {
  sent = []
  win = Object.assign(emitter(), {
    location: { search: '?api=1' },
    parent: { postMessage: (message) => sent.push(JSON.parse(message)) }
  })
  doc = Object.assign(emitter(), { querySelector: () => null, fullscreenElement: null })
  globalThis.window = win
  globalThis.document = doc
})

function load(params) {
  // In a real embed the page's only <video> is the player's
  const mediaEl = params.player?.mediaEl ?? win.videojsPlayer?.mediaEl ?? null
  doc.querySelector = () => mediaEl
  let handler
  register({ registerHook: (hook) => { handler = hook.handler } })
  handler({ videojs: videojsLibrary, video: { uuid: 'video-1' }, ...params })
}

const errors = () => sent.filter((m) => m.method === 'peertube::error').map((m) => m.params)

test('forwards the player error PeerTube raises when it gives up', () => {
  const player = fakePlayer()
  load({ player })
  player.fail(2, 'HLS.js error: networkError - fatal: false - levelLoadError')

  assert.deepEqual(errors(), [{
    fatal: true,
    type: 'media',
    code: 2,
    message: 'HLS.js error: networkError - fatal: false - levelLoadError',
    details: 'MEDIA_ERR_2',
    videoId: 'video-1'
  }])
})

test('forwards a repeated give-up once, and again after playback resumed', () => {
  const player = fakePlayer()
  load({ player })
  player.fail(2, 'gave up')
  player.fail(2, 'gave up')
  assert.equal(errors().length, 1)

  player.recover()
  player.fail(2, 'gave up')
  assert.equal(errors().length, 2)
})

test('forwards HLS.js errors with the HTTP status', () => {
  const player = fakePlayer()
  load({ player })
  player.hls.emit('hlsError', 'hlsError', {
    fatal: false,
    type: 'networkError',
    details: 'levelLoadError',
    reason: 'A network error (status 403) occurred while loading level: 1',
    url: 'https://tube.example/hls/private/a-480.m3u8',
    response: { code: 403 }
  })

  assert.deepEqual(errors(), [{
    fatal: false,
    type: 'networkError',
    details: 'levelLoadError',
    message: 'A network error (status 403) occurred while loading level: 1',
    url: 'https://tube.example/hls/private/a-480.m3u8',
    httpStatus: 403,
    videoId: 'video-1'
  }])
})

test('attaches to HLS.js created after the hook ran, once per instance', () => {
  const player = fakePlayer()
  const late = player.hls
  player.p2pMediaLoader = () => ({ getHLSJS: () => undefined })
  load({ player })

  player.emit('hlsjs-initialized', {}, { hlsjs: late })
  player.emit('hlsjs-initialized', {}, { hlsjs: late })
  late.emit('hlsError', 'hlsError', { fatal: false, type: 'networkError', details: 'fragLoadError' })

  assert.deepEqual(errors().map((e) => e.details), ['fragLoadError'])
})

test('finds HLS.js through the tech when p2p-media-loader is missing', () => {
  for (const tech of [{ hlsProvider: { hls: fakeHls() } }, { hlsjs: fakeHls() }]) {
    sent = []
    const player = fakePlayer({ tech })
    delete player.p2pMediaLoader
    load({ player })
    const hls = tech.hlsjs || tech.hlsProvider.hls
    hls.emit('hlsError', 'hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError' })
    assert.equal(errors()[0]?.details, 'manifestLoadError')
  }
})

test('drops the element error that follows a player error', () => {
  const player = fakePlayer()
  load({ player })
  player.fail(2, 'gave up')
  player.mediaEl.error = { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' }
  player.mediaEl.emit('error')

  assert.deepEqual(errors().map((e) => e.details), ['MEDIA_ERR_2'])
})

test('forwards an element error video.js did not report', () => {
  const player = fakePlayer()
  load({ player })
  player.mediaEl.error = { code: 3, message: 'decode' }
  player.mediaEl.emit('error')

  assert.deepEqual(errors().map((e) => [e.details, e.fatal]), [['VIDEO_ERR_3', true]])
})

test('falls back to window.videojsPlayer when the hook passes no usable player', () => {
  const player = fakePlayer()
  win.videojsPlayer = player
  load({ player: {} })
  player.fail(2, 'gave up')

  assert.equal(errors()[0]?.details, 'MEDIA_ERR_2')
})

test('survives a missing player and still forwards offline/online', () => {
  assert.doesNotThrow(() => load({ player: null }))
  win.emit('offline')
  win.emit('online')

  assert.deepEqual(errors().map((e) => [e.type, e.details, e.fatal]), [
    ['network', 'offline', false],
    ['recovery', 'online', false]
  ])
})

test('uses the scope from the embed URL', () => {
  win.location.search = '?api=1&scope=custom'
  const player = fakePlayer()
  load({ player })
  player.fail(2, 'gave up')

  assert.ok(sent.some((m) => m.method === 'custom::error'))
  assert.ok(!sent.some((m) => m.method === 'peertube::error'))
})

test('reports the initial audio state and applies mute commands', () => {
  const player = fakePlayer()
  load({ player })
  assert.deepEqual(sent.find((m) => m.method === 'peertube::state')?.params, { muted: false, volume: 1, fullscreen: false })

  win.emit('message', { data: JSON.stringify({ method: 'peertube::command', params: { action: 'mute' } }) })
  assert.equal(player.muted(), true)
  assert.equal(player.mediaEl.muted, true)
  assert.deepEqual(sent.at(-1), { method: 'peertube::state', params: { muted: true, volume: 0, fullscreen: false } })

  win.emit('message', { data: JSON.stringify({ method: 'other::command', params: { action: 'unmute' } }) })
  assert.equal(player.muted(), true)
})
