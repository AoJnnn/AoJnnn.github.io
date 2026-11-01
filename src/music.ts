import './music.css'
import { getCachedUrl, hasCached, listCachedIds, putCachedBlob, touchCached } from './audiocache'

/* ------------------------------------------------------------------ *
 *  类型
 * ------------------------------------------------------------------ */

export type Track = {
  id: string
  title: string
  artist: string
  album: string
  category: string
  duration: number
  synced: boolean
  cover: string | null
  thumb: string | null
  hasLyrics: boolean
  size: number
}

type Manifest = {
  generatedAt: string
  bitrate: string
  totalDuration: number
  categories: string[]
  tracks: Track[]
}

type LyricLine = { time: number; text: string }

type Shell = (content: string, active?: string) => void

/* ------------------------------------------------------------------ *
 *  状态（模块级，跨路由保留，所以播放不会因为切页中断）
 * ------------------------------------------------------------------ */

const BASE = 'music/'
const STATE_KEY = 'aojnnn-music-prefs'

let manifest: Manifest | null = null
let loading: Promise<Manifest> | null = null
let queue: Track[] = []
let current: Track | null = null
let lyrics: LyricLine[] = []
let lyricCursor = -1
let filterCategory = '全部'
let searchTerm = ''
let audio: HTMLAudioElement | null = null
let prefs = { volume: 0.8, muted: false, shuffle: false, repeat: 'all' as 'off' | 'all' | 'one' }

try {
  const saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}')
  prefs = { ...prefs, ...saved }
} catch {
  /* 忽略 */
}

const savePrefs = () => {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(prefs))
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ *
 *  图标
 * ------------------------------------------------------------------ */

const svg = (paths: string, filled = false) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" ${
    filled
      ? 'fill="currentColor" stroke="none"'
      : 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"'
  }>${paths}</svg>`

const ICONS = {
  play: svg('<path d="M8.4 4.9v14.2a1 1 0 0 0 1.53.84l10.5-7.1a1 1 0 0 0 0-1.68L9.93 4.06A1 1 0 0 0 8.4 4.9Z"/>', true),
  pause: svg('<rect x="6.6" y="4.8" width="3.9" height="14.4" rx="1.4"/><rect x="13.5" y="4.8" width="3.9" height="14.4" rx="1.4"/>', true),
  prev: svg('<path d="M19.3 5.1v13.8a.8.8 0 0 1-1.24.67l-9-6.9a.8.8 0 0 1 0-1.34l9-6.9a.8.8 0 0 1 1.24.67Z"/><rect x="4.7" y="4.8" width="2.3" height="14.4" rx="1.15"/>', true),
  next: svg('<path d="M4.7 5.1v13.8a.8.8 0 0 0 1.24.67l9-6.9a.8.8 0 0 0 0-1.34l-9-6.9a.8.8 0 0 0-1.24.67Z"/><rect x="17" y="4.8" width="2.3" height="14.4" rx="1.15"/>', true),
  shuffle: svg('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>'),
  repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  repeatOne: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M11 10.6h1.7V15"/>'),
  volume: svg('<path d="M11 4.8 6.3 9H2.9v6h3.4L11 19.2z"/><path d="M15.3 8.7a4.7 4.7 0 0 1 0 6.6"/><path d="M18.1 5.9a8.6 8.6 0 0 1 0 12.2"/>'),
  volumeLow: svg('<path d="M11 4.8 6.3 9H2.9v6h3.4L11 19.2z"/><path d="M15.3 8.7a4.7 4.7 0 0 1 0 6.6"/>'),
  volumeMute: svg('<path d="M11 4.8 6.3 9H2.9v6h3.4L11 19.2z"/><path d="m15.5 9.5 5 5"/><path d="m20.5 9.5-5 5"/>'),
}

/* ------------------------------------------------------------------ *
 *  工具
 * ------------------------------------------------------------------ */

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const mmss = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const assetUrl = (path: string) => `${BASE}${path}`

/** 解析 LRC，返回按时间排序的行 */
function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    // 时间戳允许尾随噪声，例如 [00:12.34-1] 这种非标准写法
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?[^\]]*\]/g)]
    const body = raw.replace(/\[[^\]]*\]/g, '').trim()
    if (!stamps.length) continue
    for (const m of stamps) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0
      out.push({ time: min * 60 + sec + frac, text: body })
    }
  }
  out.sort((a, b) => a.time - b.time)
  // 同一时间戳的重复行去掉
  return out.filter((line, i) => i === 0 || line.time !== out[i - 1].time || line.text !== out[i - 1].text)
}

/* ------------------------------------------------------------------ *
 *  数据加载
 * ------------------------------------------------------------------ */

function loadManifest(): Promise<Manifest> {
  if (manifest) return Promise.resolve(manifest)
  if (loading) return loading
  loading = fetch(assetUrl('tracks.json'))
    .then((r) => {
      if (!r.ok) throw new Error(`清单加载失败 (${r.status})`)
      return r.json() as Promise<Manifest>
    })
    .then((data) => {
      manifest = data
      return data
    })
    .finally(() => {
      loading = null
    })
  return loading
}

/* ------------------------------------------------------------------ *
 *  音频元素与播放条（挂在 body 上，路由切换不会销毁）
 * ------------------------------------------------------------------ */

/** 冷缓存下首字节可能要等几秒，给个可见反馈 */
function setBuffering(on: boolean) {
  document.getElementById('nmp')?.classList.toggle('is-buffering', on)
  for (const el of document.querySelectorAll<HTMLElement>('.music-now, .nmp-sheet-panel')) {
    el.classList.toggle('is-buffering', on)
  }

  // 顶部扫动条：只在「真的还没出声」时显示，避免播放中短暂缓冲就闪一下
  let loadbar = document.getElementById('nmp-loadbar')
  if (!loadbar) {
    loadbar = document.createElement('div')
    loadbar.id = 'nmp-loadbar'
    loadbar.className = 'nmp-loadbar'
    loadbar.setAttribute('aria-hidden', 'true')
    document.body.appendChild(loadbar)
  }
  if (on) {
    loadbar.classList.add('is-on')
  } else {
    loadbar.classList.remove('is-on')
  }
}

/**
 * 已缓冲比例（0~1）。
 * 取从当前位置往后连续可用、或整段覆盖到当前播放点的那一段——
 * 拖动进度条后 timeRanges 可能有多段，取离当前位置最近且向前覆盖最多的。
 */
function bufferedRatio(duration: number): number {
  if (!audio || !Number.isFinite(duration) || duration <= 0) return 0
  const ranges = audio.buffered
  if (!ranges || !ranges.length) return 0
  const t = audio.currentTime
  let end = 0
  for (let i = 0; i < ranges.length; i++) {
    // 只要这一段盖住了播放点，就认为播放点之后已经有内容
    if (ranges.start(i) <= t + 0.5) end = Math.max(end, ranges.end(i))
  }
  return Math.max(0, Math.min(1, end / duration))
}

/** 当前播放点之后已经缓冲了多少秒 */
function bufferedAhead(): number {
  if (!audio) return 0
  const ranges = audio.buffered
  if (!ranges || !ranges.length) return 0
  const t = audio.currentTime
  let best = 0
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t + 0.5) best = Math.max(best, ranges.end(i) - t)
  }
  return Math.max(0, best)
}

/* ------------------------------------------------------------------ *
 *  本地缓存与预取
 *  —— 不换服务器、不降码率，靠「听过的歌存在本地」来缩短起播时间
 * ------------------------------------------------------------------ */

/** 一次只跑一个抓取任务，避免同时抢占播放带宽 */
let cachingId: string | null = null

/**
 * 已在本地缓存里的曲目 id。
 * 启动时从 IndexedDB 载入一次，之后同步判断——
 * 这样「没缓存过的歌」不会被一次多余的存储查询拖慢起播。
 */
const cachedIds = new Set<string>()
let cachedIdsLoaded = false

async function loadCachedIds() {
  if (cachedIdsLoaded) return
  try {
    for (const id of await listCachedIds()) cachedIds.add(id)
  } catch {
    /* 存储不可用则忽略 */
  }
  cachedIdsLoaded = true
}

/**
 * 把某首歌抓下来存进 IndexedDB。
 * 若该曲目刚刚播过，文件通常还在 HTTP 缓存里，这一步几乎不耗流量。
 */
async function cacheTrack(track: Track): Promise<void> {
  if (cachingId) return
  cachingId = track.id
  try {
    if (cachedIds.has(track.id)) return
    if (await hasCached(track.id)) {
      cachedIds.add(track.id)
      return
    }
    const res = await fetch(assetUrl(`audio/${track.id}.opus`))
    if (!res.ok) return
    const blob = await res.blob()
    if (blob.size === 0) return
    await putCachedBlob(track.id, blob)
    cachedIds.add(track.id)
  } catch {
    /* 配额不足 / 离线 / 被中断，都不影响播放 */
  } finally {
    if (cachingId === track.id) cachingId = null
  }
}

/**
 * 决定何时把音频存进本地缓存。
 *
 * 注意不能等「缓冲很多秒」——浏览器对音频的提前缓冲通常只有十几秒，
 * 阈值设高了永远不触发。这里改成在带宽空闲的时机抓取：
 * - 刚切走的那首（字节基本已在 HTTP 缓存里，几乎零成本）
 * - 一首播完之后
 * - 播放中且缓冲还算充足时的兜底检查
 */
function scheduleCaching(previous?: Track | null) {
  if (previous && previous.id !== current?.id) {
    void cacheTrack(previous)
    return
  }
  if (!current || !audio) return
  if (bufferedAhead() >= 8 && audio.readyState >= 3) void cacheTrack(current)
}

/**
 * 设置音源：优先用本地缓存，未命中再走网络。
 * 用 async 是为了先查一次 IndexedDB（通常几毫秒），
 * 期间若用户又切了歌就直接放弃这次赋值。
 */
async function startSource(track: Track, el: HTMLAudioElement) {
  let cached: string | null = null
  // 只有「确实缓存过」的曲目才去查存储；没缓存过的直接走网络，
  // 避免首次播放被一次无谓的 IndexedDB 查询拖慢。
  if (cachedIds.has(track.id)) {
    try {
      cached = await Promise.race([
        getCachedUrl(track.id).catch(() => null),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 300)),
      ])
    } catch {
      cached = null
    }
  }
  // 已经切走或元素被替换，放弃
  if (current?.id !== track.id || audio !== el) return

  el.src = cached ?? assetUrl(`audio/${track.id}.opus`)
  el.volume = prefs.volume
  el.muted = prefs.muted
  if (cached) void touchCached(track.id)

  void el.play().catch(() => {
    /* 自动播放被拦，等用户手动点 */
  })
}

function wireAudio(el: HTMLAudioElement) {
  el.addEventListener('timeupdate', onTimeUpdate)
  el.addEventListener('loadedmetadata', () => {
    renderBar()
    renderNowPanel()
  })
  el.addEventListener('play', () => {
    renderBar()
    renderNowPanel()
    syncListState()
  })
  el.addEventListener('pause', () => {
    renderBar()
    renderNowPanel()
    syncListState()
  })
  el.addEventListener('ended', () => {
    if (prefs.repeat === 'one') {
      el.currentTime = 0
      void el.play()
    } else {
      step(1, true)
    }
  })
  el.addEventListener('waiting', () => setBuffering(true))
  el.addEventListener('stalled', () => setBuffering(true))
  el.addEventListener('playing', () => setBuffering(false))
  el.addEventListener('canplay', () => setBuffering(false))
  el.addEventListener('error', () => setBuffering(false))
  // progress 事件在下载推进时更频繁，用它刷新缓冲段
  el.addEventListener('progress', () => renderBar())
  el.addEventListener('loadeddata', () => renderBar())
}

function getAudio(): HTMLAudioElement {
  if (audio) return audio
  const el = document.createElement('audio')
  el.preload = 'metadata'
  el.volume = prefs.volume
  el.muted = prefs.muted
  wireAudio(el)
  document.body.appendChild(el)
  audio = el
  return el
}

/**
 * 彻底销毁当前 audio 元素。
 *
 * 只改 src 或调 load() 时，部分浏览器（安卓 Chrome、部分国产内核）仍会把
 * 上一首的残余解码输出留在音频管线里，表现为切歌后「卡一下 + 漏出一声上一首
 * 的尾音」。直接丢弃元素并新建，是隔离旧解码器最彻底的做法。
 */
function disposeAudio() {
  const el = audio
  if (!el) return
  audio = null
  try {
    el.pause()
  } catch {
    /* 忽略 */
  }
  el.removeAttribute('src')
  try {
    el.load()
  } catch {
    /* 忽略 */
  }
  el.remove()
}

/* ------------------------------------------------------------------ *
 *  播放条 / 弹出页共用的按钮动作
 * ------------------------------------------------------------------ */

function handleAction(act: string | undefined) {
  if (act === 'toggle') toggle()
  else if (act === 'next') step(1)
  else if (act === 'prev') step(-1)
  else if (act === 'repeat') {
    prefs.repeat = prefs.repeat === 'all' ? 'one' : prefs.repeat === 'one' ? 'off' : 'all'
    savePrefs()
    renderBar()
  } else if (act === 'shuffle') {
    prefs.shuffle = !prefs.shuffle
    savePrefs()
    renderBar()
  } else if (act === 'mute') {
    prefs.muted = !prefs.muted
    if (!prefs.muted && prefs.volume === 0) prefs.volume = 0.6
    if (audio) {
      audio.muted = prefs.muted
      audio.volume = prefs.volume
    }
    savePrefs()
    renderBar()
  }
}

/* ------------------------------------------------------------------ *
 *  手机端「正在播放」弹出页
 * ------------------------------------------------------------------ */

const isNarrow = () => window.matchMedia('(max-width: 980px)').matches

function sheetOpen(): boolean {
  return Boolean(document.getElementById('nmp-sheet')?.classList.contains('is-open'))
}

function ensureSheet(): HTMLElement {
  let sheet = document.getElementById('nmp-sheet')
  if (sheet) return sheet

  sheet = document.createElement('div')
  sheet.id = 'nmp-sheet'
  sheet.className = 'nmp-sheet'
  sheet.innerHTML = `
    <div class="sheet-backdrop" data-act="close-sheet"></div>
    <section class="nmp-sheet-panel" role="dialog" aria-modal="true" aria-label="正在播放">
      <span class="sheet-grip" aria-hidden="true"></span>
      <button class="sheet-close" type="button" data-act="close-sheet" aria-label="收起">✕</button>
      <div class="now-cover">
        <img alt="" />
        <span class="now-ph">♪</span>
      </div>
      <div class="sheet-text">
        <b class="now-title">未在播放</b>
        <span class="now-artist"></span>
        <small class="now-meta"></small>
      </div>
      <div class="sheet-seek">
        <span class="nmp-time" id="sheet-cur">0:00</span>
        <input class="nmp-range" id="sheet-progress" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
        <span class="nmp-time" id="sheet-dur">0:00</span>
      </div>
      <div class="sheet-controls">
        <button class="nmp-btn" data-act="prev" type="button" aria-label="上一首">${ICONS.prev}</button>
        <button class="nmp-btn nmp-play" data-act="toggle" type="button" aria-label="播放">${ICONS.play}</button>
        <button class="nmp-btn" data-act="next" type="button" aria-label="下一首">${ICONS.next}</button>
      </div>
      <div class="now-lyrics"><p class="lyrics-empty">选一首歌开始播放</p></div>
    </section>`
  document.body.appendChild(sheet)

  sheet.addEventListener('click', (event) => {
    const el = event.target as HTMLElement
    if (el.closest('[data-act="close-sheet"]')) {
      closeSheet()
      return
    }
    const btn = el.closest<HTMLElement>('[data-act]')
    if (btn) handleAction(btn.dataset.act)
  })

  const seek = sheet.querySelector<HTMLInputElement>('#sheet-progress')!
  seek.addEventListener('input', () => {
    const ratio = Number(seek.value) / 1000
    seek.style.setProperty('--p', String(ratio))
    if (audio && Number.isFinite(audio.duration)) audio.currentTime = ratio * audio.duration
  })

  return sheet
}

/**
 * 滚动锁。
 * 只给 html/body 加 overflow:hidden 在部分移动端浏览器（安卓、部分国产内核）
 * 拦不住手势，会被拖动灰色遮罩时带动整页。用 position:fixed 固定 body
 * 并记住滚动位置，关闭时再还原，这是兼容性最好的做法。
 */
let lockedScrollY = 0
let scrollLocked = false
let unlockTimer: number | null = null

function lockScroll() {
  if (scrollLocked) return
  scrollLocked = true
  lockedScrollY = window.scrollY
  const b = document.body
  b.style.position = 'fixed'
  b.style.top = `-${lockedScrollY}px`
  b.style.left = '0'
  b.style.right = '0'
  b.style.width = '100%'
  b.style.overflow = 'hidden'
  document.documentElement.classList.add('sheet-open')
  document.body.classList.add('sheet-open')
}

function unlockScroll() {
  if (!scrollLocked) return
  scrollLocked = false
  const b = document.body
  b.style.position = ''
  b.style.top = ''
  b.style.left = ''
  b.style.right = ''
  b.style.width = ''
  b.style.overflow = ''
  document.documentElement.classList.remove('sheet-open')
  document.body.classList.remove('sheet-open')
  window.scrollTo(0, lockedScrollY)
}

function openSheet() {
  if (!current) return
  // 如果正在退场动画里又重新打开，取消待执行的解锁
  if (unlockTimer !== null) {
    window.clearTimeout(unlockTimer)
    unlockTimer = null
  }
  const sheet = ensureSheet()
  renderNowPanel()
  renderLyrics()
  sheet.classList.add('is-open')
  lockScroll()
}

function closeSheet() {
  const sheet = document.getElementById('nmp-sheet')
  if (!sheet?.classList.contains('is-open')) return
  sheet.classList.remove('is-open')
  // 等下滑 + 遮罩淡出结束再放开滚动，否则背景会在动画中途跳回原位
  if (unlockTimer !== null) window.clearTimeout(unlockTimer)
  unlockTimer = window.setTimeout(() => {
    unlockTimer = null
    unlockScroll()
  }, 340)
}

function toggleSheet() {
  if (sheetOpen()) closeSheet()
  else openSheet()
}

function ensureBar(): HTMLElement {
  let bar = document.getElementById('nmp')
  if (bar) return bar
  bar = document.createElement('div')
  bar.id = 'nmp'
  bar.className = 'nmp'
  bar.innerHTML = `
    <button class="nmp-cover" type="button" aria-label="跳到正在播放">
      <img alt="" />
      <span class="nmp-cover-ph">♪</span>
    </button>
    <div class="nmp-meta">
      <b class="nmp-title">未在播放</b>
      <span class="nmp-artist"></span>
    </div>
    <div class="nmp-controls">
      <button class="nmp-btn nmp-mode" data-act="shuffle" type="button" aria-label="随机播放" title="随机播放">${ICONS.shuffle}</button>
      <button class="nmp-btn" data-act="prev" type="button" aria-label="上一首" title="上一首">${ICONS.prev}</button>
      <button class="nmp-btn nmp-play" data-act="toggle" type="button" aria-label="播放" title="播放 / 暂停">${ICONS.play}</button>
      <button class="nmp-btn" data-act="next" type="button" aria-label="下一首" title="下一首">${ICONS.next}</button>
      <button class="nmp-btn nmp-mode" data-act="repeat" type="button" aria-label="循环模式" title="循环模式">${ICONS.repeat}</button>
    </div>
    <div class="nmp-seek">
      <span class="nmp-time nmp-cur">0:00</span>
      <input class="nmp-range" id="nmp-progress" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
      <span class="nmp-time nmp-dur">0:00</span>
    </div>
    <div class="nmp-extra">
      <button class="nmp-btn nmp-volbtn" data-act="mute" type="button" aria-label="静音" title="静音">${ICONS.volume}</button>
      <input class="nmp-range nmp-vol" id="nmp-volume" type="range" min="0" max="100" value="80" step="1" aria-label="音量" />
    </div>
  `
  document.body.appendChild(bar)

  bar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!target) return
    handleAction(target.dataset.act)
  })

  // 手机端：点封面或歌曲信息弹出「封面 + 歌词」页；桌面端：跳到音乐页
  bar.querySelector<HTMLButtonElement>('.nmp-cover')!.addEventListener('click', () => {
    if (isNarrow()) {
      toggleSheet()
      return
    }
    if (location.hash.startsWith('#/music')) return
    location.hash = '#/music'
  })

  bar.querySelector<HTMLElement>('.nmp-meta')!.addEventListener('click', () => {
    if (isNarrow()) toggleSheet()
  })

  const progress = bar.querySelector<HTMLInputElement>('#nmp-progress')!
  progress.addEventListener('input', () => {
    const ratio = Number(progress.value) / 1000
    progress.style.setProperty('--p', String(ratio))
    if (!audio || !Number.isFinite(audio.duration)) return
    audio.currentTime = ratio * audio.duration
  })

  const volume = bar.querySelector<HTMLInputElement>('#nmp-volume')!
  volume.value = String(Math.round((prefs.muted ? 0 : prefs.volume) * 100))
  volume.style.setProperty('--p', String(prefs.muted ? 0 : prefs.volume))
  volume.addEventListener('input', () => {
    prefs.volume = Number(volume.value) / 100
    prefs.muted = prefs.volume === 0
    volume.style.setProperty('--p', String(prefs.volume))
    if (audio) {
      audio.volume = prefs.volume
      audio.muted = prefs.muted
    }
    savePrefs()
    renderBar()
  })

  return bar
}

function renderBar() {
  const bar = document.getElementById('nmp')
  if (!bar) return
  const active = Boolean(current)
  bar.classList.toggle('is-active', active)
  bar.classList.toggle('is-playing', Boolean(audio && !audio.paused))
  document.body.classList.toggle('has-nmp', active)

  const cover = bar.querySelector<HTMLImageElement>('.nmp-cover img')!
  const ph = bar.querySelector<HTMLElement>('.nmp-cover-ph')!
  if (current?.thumb) {
    cover.src = assetUrl(current.thumb)
    cover.hidden = false
    ph.hidden = true
  } else {
    cover.hidden = true
    ph.hidden = false
  }

  bar.querySelector('.nmp-title')!.textContent = current?.title ?? '未在播放'
  bar.querySelector('.nmp-artist')!.textContent = current?.artist ?? ''

  const playing = Boolean(audio && !audio.paused)
  const playBtn = bar.querySelector<HTMLElement>('.nmp-play')!
  playBtn.innerHTML = playing ? ICONS.pause : ICONS.play
  playBtn.setAttribute('aria-label', playing ? '暂停' : '播放')

  const dur = audio && Number.isFinite(audio.duration) ? audio.duration : (current?.duration ?? 0)
  const cur = audio?.currentTime ?? 0
  bar.querySelector('.nmp-cur')!.textContent = mmss(cur)
  bar.querySelector('.nmp-dur')!.textContent = mmss(dur)

  // 已缓冲到哪里（浅色段），让「还在加载」有可视反馈
  const bufferedPct = bufferedRatio(dur)

  const progress = bar.querySelector<HTMLInputElement>('#nmp-progress')!
  const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0
  if (document.activeElement !== progress) {
    progress.value = String(Math.round(pct * 10))
    progress.style.setProperty('--p', String(pct / 100))
  }
  progress.style.setProperty('--b', String(bufferedPct))

  // 弹出页里的进度与时间
  const sheetProgress = document.getElementById('sheet-progress') as HTMLInputElement | null
  if (sheetProgress && document.activeElement !== sheetProgress) {
    sheetProgress.value = String(Math.round(pct * 10))
    sheetProgress.style.setProperty('--p', String(pct / 100))
  }
  if (sheetProgress) sheetProgress.style.setProperty('--b', String(bufferedPct))
  const sheetCur = document.getElementById('sheet-cur')
  const sheetDur = document.getElementById('sheet-dur')
  if (sheetCur) sheetCur.textContent = mmss(cur)
  if (sheetDur) sheetDur.textContent = mmss(dur)

  const repeatBtn = bar.querySelector<HTMLElement>('[data-act="repeat"]')!
  repeatBtn.innerHTML = prefs.repeat === 'one' ? ICONS.repeatOne : ICONS.repeat
  repeatBtn.title = prefs.repeat === 'one' ? '单曲循环' : prefs.repeat === 'off' ? '不循环' : '列表循环'
  repeatBtn.classList.toggle('is-on', prefs.repeat !== 'off')
  const shuffleBtn = bar.querySelector<HTMLElement>('[data-act="shuffle"]')!
  shuffleBtn.classList.toggle('is-on', prefs.shuffle)

  const volBtn = bar.querySelector<HTMLElement>('[data-act="mute"]')!
  const vol = prefs.muted ? 0 : prefs.volume
  volBtn.innerHTML = vol === 0 ? ICONS.volumeMute : vol < 0.5 ? ICONS.volumeLow : ICONS.volume
  volBtn.classList.toggle('is-on', vol === 0)
  const volInput = bar.querySelector<HTMLInputElement>('#nmp-volume')!
  if (document.activeElement !== volInput) {
    volInput.value = String(Math.round(vol * 100))
    volInput.style.setProperty('--p', String(vol))
  }
  bar.classList.toggle('is-muted', vol === 0)
}

/* ------------------------------------------------------------------ *
 *  播放控制
 * ------------------------------------------------------------------ */

/**
 * 首次播放加速：在用户「真的要播」之前把请求发出去。
 *
 * 冷缓存下每首歌都要从 GitHub 源站回源（实测约 127KB/s），
 * 只有把下载提前到点击之前，才能真正缩短「点下去到出声」的时间。
 *
 * 分两级，避免白白消耗流量：
 * - 悬停 / 开页：只取开头 256KB（够触发 CDN 回源并让起播更快）
 * - 真正按下（并且是鼠标设备）：才整首预取并写入本地缓存
 */
/** 已经发过「分段预热」的曲目，同一首不重复请求 */
const warmed = new Set<string>()
/** 正在整首预取的曲目 */
const prefetching = new Set<string>()

/** 轻量预热：只取开头 256KB */
function warmTrack(track: Track) {
  if (!track || warmed.has(track.id) || cachedIds.has(track.id)) return
  warmed.add(track.id)
  fetch(assetUrl(`audio/${track.id}.opus`), {
    headers: { Range: 'bytes=0-262143' },
    credentials: 'same-origin',
  }).catch(() => {
    warmed.delete(track.id)
  })
}

/** 整首预取并存进本地缓存（仅在用户明确按下时调用） */
function prefetchAudio(track: Track) {
  if (!track || prefetching.has(track.id) || cachedIds.has(track.id)) return
  if (prefetching.size >= 2) return
  prefetching.add(track.id)
  fetch(assetUrl(`audio/${track.id}.opus`), { credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) return
      const blob = await res.blob()
      if (blob.size === 0) return
      await putCachedBlob(track.id, blob)
      cachedIds.add(track.id)
    })
    .catch(() => null)
    .finally(() => {
      prefetching.delete(track.id)
    })
}

/** 只有鼠标这类精确指针才值得整首预取，触屏按流量算太贵 */
const hasPrecisePointer = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true

/** 悬停只预热、按下才预取，把等待藏进用户的操作延迟里 */
function bindPrefetch() {
  const host = document.getElementById('music-list')
  if (!host) return
  const trackOf = (event: Event): Track | undefined => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.ml-row')
    const id = row?.dataset.id
    if (!id) return undefined
    return (manifest?.tracks ?? []).find((t) => t.id === id)
  }
  host.addEventListener('pointerover', (event) => {
    const track = trackOf(event)
    if (track) warmTrack(track)
  })
  host.addEventListener('pointerdown', (event) => {
    const track = trackOf(event)
    if (!track) return
    warmTrack(track)
    if (hasPrecisePointer()) prefetchAudio(track)
  })
}

function playTrack(track: Track, list?: Track[]) {
  if (list) queue = list
  if (!queue.length) queue = manifest?.tracks.slice() ?? []
  const sameTrack = current?.id === track.id
  current = track

  // 换曲：丢掉旧的 audio 元素、新建一个，避免旧解码器的残余输出漏出来
  if (!sameTrack) disposeAudio()
  const el = getAudio()

  if (!sameTrack) {
    // 立刻给出反馈：waiting 事件有时要等到真正卡住才触发
    setBuffering(true)
    el.volume = prefs.volume
    el.muted = prefs.muted
    void startSource(track, el)
  } else {
    void el.play().catch(() => {
      /* 自动播放被拦，等用户手动点 */
    })
  }
  ensureBar()
  renderBar()
  loadLyrics(track)
  renderNowPanel()
  syncListState()
  updateMediaSession(track)

  // 让当前行进入视野
  requestAnimationFrame(() => {
    document.querySelector('.ml-row.is-current')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

function toggle() {
  if (!current) {
    const first = filteredTracks()[0] ?? manifest?.tracks[0]
    if (first) playTrack(first, filteredTracks().length ? filteredTracks() : undefined)
    return
  }
  const el = getAudio()
  if (el.paused) void el.play()
  else el.pause()
}

function step(delta: number, auto = false) {
  if (!queue.length) return
  if (auto && prefs.repeat === 'off' && !prefs.shuffle) {
    const at = current ? queue.findIndex((t) => t.id === current!.id) : -1
    if (at === queue.length - 1) return
  }
  let nextIndex = 0
  if (prefs.shuffle) {
    nextIndex = queue.length === 1 ? 0 : Math.floor(Math.random() * queue.length)
  } else {
    const at = current ? queue.findIndex((t) => t.id === current!.id) : -1
    nextIndex = (at + delta + queue.length) % queue.length
  }
  playTrack(queue[nextIndex], queue)
}

function updateMediaSession(track: Track) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album || 'AoJnnn / Notes',
    artwork: track.cover ? [{ src: assetUrl(track.cover), sizes: '400x400', type: 'image/webp' }] : [],
  })
  navigator.mediaSession.setActionHandler('play', () => void audio?.play())
  navigator.mediaSession.setActionHandler('pause', () => audio?.pause())
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1))
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1))
}

/* ------------------------------------------------------------------ *
 *  歌词
 * ------------------------------------------------------------------ */

/** 歌词请求序号，用来丢弃「已经切走之后才回来」的过期响应 */
let lyricSeq = 0

async function loadLyrics(track: Track) {
  const seq = ++lyricSeq
  // 只认最后一次请求：快速切歌时，慢的那次不能覆盖新的
  const isStale = () => seq !== lyricSeq || current?.id !== track.id

  lyrics = []
  lyricCursor = -1
  if (!track.hasLyrics) {
    renderLyrics()
    return
  }

  let next: LyricLine[] = []
  try {
    const res = await fetch(assetUrl(`lyrics/${track.id}.lrc`))
    if (isStale()) return
    if (!res.ok) throw new Error('no lyrics')
    const text = await res.text()
    if (isStale()) return
    next = parseLrc(text)
    if (!next.length) {
      // 完全无时间轴的纯文本歌词：去掉残留方括号后逐行显示
      next = text
        .split(/\r?\n/)
        .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
        .filter(Boolean)
        .map((l) => ({ time: -1, text: l }))
    }
  } catch {
    if (isStale()) return
    next = []
  }

  if (isStale()) return
  lyrics = next
  renderLyrics()
  renderNowPanel()
}

let lastCacheCheck = 0

function onTimeUpdate() {
  const el = audio
  if (!el) return
  renderBar()

  // 每 5 秒评估一次是否把当前曲目/下一首存进本地缓存
  const now = Date.now()
  if (now - lastCacheCheck > 5000) {
    lastCacheCheck = now
    scheduleCaching()
  }

  if (!lyrics.length) return
  const t = el.currentTime
  let next = lyricCursor
  // 顺序推进；拖动进度条回退时二分查找
  if (next >= 0 && next < lyrics.length && lyrics[next].time <= t) {
    while (next + 1 < lyrics.length && lyrics[next + 1].time <= t) next++
  } else {
    next = -1
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].time <= t) next = i
      else break
    }
  }
  if (next !== lyricCursor) {
    lyricCursor = next
    renderLyrics()
  }
}

function renderLyrics() {
  const boxes = document.querySelectorAll<HTMLElement>('.now-lyrics')
  if (!boxes.length) return

  const html = !lyrics.length
    ? `<p class="lyrics-empty">${current ? (current.hasLyrics ? '歌词加载中…' : '这首歌没有歌词') : '选一首歌开始播放'}</p>`
    : `<div class="lyrics-inner">${lyrics
        .map((line, i) => {
          const cls = i === lyricCursor ? 'ly is-active' : i < lyricCursor ? 'ly is-past' : 'ly'
          const text = line.text ? esc(line.text) : '&#8203;'
          return `<p class="${cls}" data-i="${i}">${text}</p>`
        })
        .join('')}</div>`

  for (const box of boxes) {
    box.innerHTML = html
    const active = box.querySelector<HTMLElement>('.ly.is-active')
    if (active) {
      const target = active.offsetTop - box.clientHeight / 2 + active.clientHeight / 2
      box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
    }
  }
}

/* ------------------------------------------------------------------ *
 *  页面渲染
 * ------------------------------------------------------------------ */

function filteredTracks(): Track[] {
  const all = manifest?.tracks ?? []
  const q = searchTerm.trim().toLowerCase()
  return all.filter((t) => {
    if (filterCategory !== '全部' && t.category !== filterCategory) return false
    if (!q) return true
    return (
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q)
    )
  })
}

/**
 * 列表封面按需加载。
 * 浏览器的 loading="lazy" 在这里并不总能生效（234 行会被一次性请求），
 * 和音频抢带宽会让切歌明显变慢，所以自己用 IntersectionObserver 控制。
 */
let thumbObserver: IntersectionObserver | null = null

function ensureThumbObserver(): IntersectionObserver {
  if (thumbObserver) return thumbObserver
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const img = entry.target as HTMLImageElement
        const src = img.dataset.src
        if (src) {
          img.src = src
          delete img.dataset.src
        }
        thumbObserver!.unobserve(img)
      }
    },
    { rootMargin: '320px 0px' },
  )
  return thumbObserver
}

function observeThumbs() {
  const host = document.getElementById('music-list')
  if (!host) return
  const observer = ensureThumbObserver()
  host.querySelectorAll<HTMLImageElement>('img[data-src]').forEach((img) => observer.observe(img))
}

function renderList() {
  const host = document.getElementById('music-list')
  if (!host) return
  const list = filteredTracks()
  if (!list.length) {
    host.innerHTML = '<p class="ml-empty">没有匹配的歌曲</p>'
    return
  }
  host.innerHTML = list
    .map((t, i) => {
      const isCurrent = current?.id === t.id
      const isPlaying = isCurrent && audio && !audio.paused
      const thumb = t.thumb ? `<img data-src="${assetUrl(t.thumb)}" alt="" decoding="async" />` : '<span class="ml-ph"></span>'
      return `<button class="ml-row${isCurrent ? ' is-current' : ''}${isPlaying ? ' is-playing' : ''}" type="button" data-id="${t.id}" data-index="${i}">
        <span class="ml-index">${isPlaying ? '<span class="ml-eq"><i></i><i></i><i></i></span>' : String(i + 1).padStart(2, '0')}</span>
        <span class="ml-thumb">${thumb}</span>
        <span class="ml-text"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span>
        <span class="ml-dur">${mmss(t.duration)}</span>
      </button>`
    })
    .join('')

  observeThumbs()
}

/**
 * 只更新行的「当前/播放中」状态，不重建 DOM。
 * 播放/暂停会频繁触发，整表重建（234 行）会造成明显卡顿。
 */
function syncListState() {
  const host = document.getElementById('music-list')
  if (!host) return
  const playing = Boolean(audio && !audio.paused)
  for (const row of host.querySelectorAll<HTMLElement>('.ml-row')) {
    const isCurrent = row.dataset.id === current?.id
    const isPlaying = isCurrent && playing
    row.classList.toggle('is-current', isCurrent)
    row.classList.toggle('is-playing', isPlaying)

    const indexEl = row.querySelector<HTMLElement>('.ml-index')
    if (!indexEl) continue
    const hasEq = Boolean(indexEl.querySelector('.ml-eq'))
    if (isPlaying && !hasEq) {
      indexEl.innerHTML = '<span class="ml-eq"><i></i><i></i><i></i></span>'
    } else if (!isPlaying && hasEq) {
      const n = Number(row.dataset.index ?? 0)
      indexEl.textContent = String(n + 1).padStart(2, '0')
    }
  }
}

function renderNowPanel() {
  const panels = document.querySelectorAll<HTMLElement>('.music-now, .nmp-sheet-panel')
  if (!panels.length) return
  const track = current
  const playing = Boolean(audio && !audio.paused)

  for (const panel of panels) {
    panel.classList.toggle('is-playing', playing)

    // 弹层用封面做放大模糊底图。
    // 注意必须用绝对 URL：自定义属性里的相对路径会相对 CSS 文件解析，
    // 会变成 /assets/music/... 而 404。
    if (track?.cover) {
      const abs = new URL(assetUrl(track.cover), document.baseURI).href
      panel.style.setProperty('--sheet-cover', `url("${abs}")`)
    } else {
      panel.style.removeProperty('--sheet-cover')
    }

    const cover = panel.querySelector<HTMLImageElement>('.now-cover img')
    const ph = panel.querySelector<HTMLElement>('.now-ph')
    if (cover) {
      if (track?.cover) {
        cover.src = assetUrl(track.cover)
        cover.hidden = false
        if (ph) ph.hidden = true
      } else {
        cover.hidden = true
        if (ph) ph.hidden = false
      }
    }

    const titleEl = panel.querySelector('.now-title')
    const artistEl = panel.querySelector('.now-artist')
    const metaEl = panel.querySelector('.now-meta')
    if (titleEl) titleEl.textContent = track?.title ?? '未在播放'
    if (artistEl) artistEl.textContent = track ? track.artist : '从列表里选一首歌'
    if (metaEl) {
      metaEl.textContent = track
        ? [track.album, track.category, mmss(track.duration)].filter(Boolean).join(' · ')
        : 'Opus 64k · 完整曲库'
    }
  }

  // 弹出页里的播放/暂停图标
  const sheetPlay = document.querySelector<HTMLElement>('#nmp-sheet .nmp-play')
  if (sheetPlay) {
    sheetPlay.innerHTML = playing ? ICONS.pause : ICONS.play
    sheetPlay.setAttribute('aria-label', playing ? '暂停' : '播放')
  }
}

function renderFilters() {
  const host = document.getElementById('music-filters')
  if (!host) return
  const cats = ['全部', ...(manifest?.categories ?? [])]
  host.innerHTML = cats
    .map(
      (c) =>
        `<button class="chip${c === filterCategory ? ' is-on' : ''}" type="button" data-cat="${esc(c)}">${esc(c)}</button>`,
    )
    .join('')
}

/* ------------------------------------------------------------------ *
 *  对外入口
 * ------------------------------------------------------------------ */

export function musicPage(shell: Shell) {
  shell(
    `<main class="music-page">
      <section class="page-intro">
        <span class="eyebrow">MUSIC LIBRARY</span>
        <h1>音乐</h1>
        <p id="music-summary">正在读取曲库…</p>
      </section>

      <section class="music-toolbar">
        <label class="music-search">
          <span>⌕</span>
          <input id="music-search" type="search" placeholder="搜索歌名 / 歌手 / 专辑" autocomplete="off" />
        </label>
        <div class="music-filters" id="music-filters"></div>
        <button class="music-playall" id="music-playall" type="button">播放全部</button>
      </section>

      <div class="music-layout">
        <section class="music-list-wrap">
          <div class="music-list" id="music-list">
            <p class="ml-empty">正在加载曲库…</p>
          </div>
        </section>

        <aside class="music-now">
          <div class="now-cover">
            <img alt="" />
            <span class="now-ph">♪</span>
          </div>
          <div class="now-text">
            <b class="now-title">未在播放</b>
            <span class="now-artist">从右侧列表选一首歌</span>
            <small class="now-meta">Opus 64k · 完整曲库</small>
          </div>
          <div class="now-lyrics"><p class="lyrics-empty">选一首歌开始播放</p></div>
        </aside>
      </div>
    </main>`,
    '音乐',
  )

  ensureBar()
  renderBar()
  renderNowPanel()

  // 载入本地缓存索引（异步，不阻塞）
  void loadCachedIds()
  // 悬停/按下即预取，把下载提前到点击之前
  bindPrefetch()

  const searchInput = document.getElementById('music-search') as HTMLInputElement | null

  document.getElementById('music-filters')?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-cat]')
    if (!btn) return
    filterCategory = btn.dataset.cat ?? '全部'
    renderFilters()
    renderList()
  })

  document.getElementById('music-list')?.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]')
    if (!row || !row.dataset.id) return
    const list = filteredTracks()
    const track = list.find((t) => t.id === row.dataset.id)
    if (!track) return
    if (current?.id === track.id) toggle()
    else playTrack(track, list)
  })

  document.getElementById('music-playall')?.addEventListener('click', () => {
    const list = filteredTracks()
    if (list.length) playTrack(list[0], list)
  })

  searchInput?.addEventListener('input', () => {
    searchTerm = searchInput.value
    renderList()
    renderNowPanel()
  })

  loadManifest()
    .then((data) => {
      const summary = document.getElementById('music-summary')
      if (summary) {
        const hours = (data.totalDuration / 3600).toFixed(1)
        summary.textContent = `${data.tracks.length} 首 · ${hours} 小时 · ${data.bitrate} Opus · ${data.categories.length} 个分类`
      }
      renderFilters()
      renderList()
      renderNowPanel()
      // 直接进页面时恢复上次的当前曲目展示（不自动播放）
      if (current) renderBar()

      // 页面打开就轻量预热列表第一首，缩短第一次点击的等待
      const first = filteredTracks()[0]
      if (first) window.setTimeout(() => warmTrack(first), 600)
    })
    .catch((error: Error) => {
      const host = document.getElementById('music-list')
      if (host) host.innerHTML = `<p class="ml-empty">曲库加载失败：${esc(error.message)}</p>`
    })

}

// 全局快捷键只注册一次，避免每次进页面就叠加监听
window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && sheetOpen()) {
    closeSheet()
    return
  }
  if (!location.hash.startsWith('#/music')) return
  const tag = (event.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (event.code === 'Space') {
    event.preventDefault()
    toggle()
  } else if (event.code === 'ArrowRight' && event.shiftKey) {
    step(1)
  } else if (event.code === 'ArrowLeft' && event.shiftKey) {
    step(-1)
  }
})
