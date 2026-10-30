import './music.css'

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

function getAudio(): HTMLAudioElement {
  if (audio) return audio
  audio = document.createElement('audio')
  audio.preload = 'metadata'
  audio.volume = prefs.volume
  audio.muted = prefs.muted
  audio.addEventListener('timeupdate', onTimeUpdate)
  audio.addEventListener('loadedmetadata', () => {
    renderBar()
    renderNowPanel()
  })
  audio.addEventListener('play', () => {
    renderBar()
    renderNowPanel()
    syncListState()
  })
  audio.addEventListener('pause', () => {
    renderBar()
    renderNowPanel()
    syncListState()
  })
  audio.addEventListener('ended', () => {
    if (prefs.repeat === 'one') {
      audio!.currentTime = 0
      void audio!.play()
    } else {
      step(1, true)
    }
  })
  // 冷缓存下首字节可能要等几秒，给个可见反馈
  const setBuffering = (on: boolean) => {
    document.getElementById('nmp')?.classList.toggle('is-buffering', on)
    document.getElementById('now')?.classList.toggle('is-buffering', on)
  }
  audio.addEventListener('waiting', () => setBuffering(true))
  audio.addEventListener('stalled', () => setBuffering(true))
  audio.addEventListener('playing', () => setBuffering(false))
  audio.addEventListener('canplay', () => setBuffering(false))
  audio.addEventListener('error', () => setBuffering(false))
  document.body.appendChild(audio)
  return audio
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
    const act = target.dataset.act
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
  })

  bar.querySelector<HTMLButtonElement>('.nmp-cover')!.addEventListener('click', () => {
    if (location.hash.startsWith('#/music')) return
    location.hash = '#/music'
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
  const progress = bar.querySelector<HTMLInputElement>('#nmp-progress')!
  const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0
  if (document.activeElement !== progress) {
    progress.value = String(Math.round(pct * 10))
    progress.style.setProperty('--p', String(pct / 100))
  }

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

function playTrack(track: Track, list?: Track[]) {
  if (list) queue = list
  if (!queue.length) queue = manifest?.tracks.slice() ?? []
  const sameTrack = current?.id === track.id
  current = track
  const el = getAudio()

  if (!sameTrack) {
    // 先停下旧曲，避免切换瞬间新旧音源纠缠造成的一声卡顿
    el.pause()
    el.src = assetUrl(`audio/${track.id}.opus`)
    el.load()
  }
  void el.play().catch(() => {
    /* 自动播放被拦，等用户手动点 */
  })
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

async function loadLyrics(track: Track) {
  lyrics = []
  lyricCursor = -1
  if (!track.hasLyrics) {
    renderLyrics()
    return
  }
  try {
    const res = await fetch(assetUrl(`lyrics/${track.id}.lrc`))
    if (!res.ok) throw new Error('no lyrics')
    const text = await res.text()
    lyrics = parseLrc(text)
    if (!lyrics.length) {
      // 完全无时间轴的纯文本歌词：去掉残留方括号后逐行显示
      lyrics = text
        .split(/\r?\n/)
        .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
        .filter(Boolean)
        .map((l) => ({ time: -1, text: l }))
    }
  } catch {
    lyrics = []
  }
  renderLyrics()
  renderNowPanel()
}

function onTimeUpdate() {
  const el = audio
  if (!el) return
  renderBar()
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
  const box = document.getElementById('now-lyrics')
  if (!box) return
  if (!lyrics.length) {
    box.innerHTML = `<p class="lyrics-empty">${current ? (current.hasLyrics ? '歌词加载中…' : '这首歌没有歌词') : '选一首歌开始播放'}</p>`
    return
  }
  box.innerHTML = `<div class="lyrics-inner">${lyrics
    .map((line, i) => {
      const cls = i === lyricCursor ? 'ly is-active' : i < lyricCursor ? 'ly is-past' : 'ly'
      const text = line.text ? esc(line.text) : '&#8203;'
      return `<p class="${cls}" data-i="${i}">${text}</p>`
    })
    .join('')}</div>`

  const active = box.querySelector<HTMLElement>('.ly.is-active')
  if (active) {
    const target = active.offsetTop - box.clientHeight / 2 + active.clientHeight / 2
    box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
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
  const panel = document.getElementById('now')
  if (!panel) return
  const track = current
  const bigCover = panel.querySelector<HTMLImageElement>('#now-cover')
  const ph = panel.querySelector<HTMLElement>('#now-ph')
  if (!bigCover) return

  if (track?.cover) {
    bigCover.src = assetUrl(track.cover)
    bigCover.hidden = false
    if (ph) ph.hidden = true
  } else {
    bigCover.hidden = true
    if (ph) ph.hidden = false
  }
  panel.classList.toggle('is-playing', Boolean(audio && !audio.paused))

  const titleEl = panel.querySelector('#now-title')
  const artistEl = panel.querySelector('#now-artist')
  const metaEl = panel.querySelector('#now-meta')
  if (titleEl) titleEl.textContent = track?.title ?? '未在播放'
  if (artistEl) artistEl.textContent = track ? track.artist : '从右侧列表选一首歌'
  if (metaEl) {
    metaEl.textContent = track
      ? [track.album, track.category, mmss(track.duration)].filter(Boolean).join(' · ')
      : 'Opus 64k · 完整曲库'
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

        <aside class="music-now" id="now">
          <div class="now-cover">
            <img id="now-cover" alt="" />
            <span class="now-ph" id="now-ph">♪</span>
          </div>
          <div class="now-text">
            <b id="now-title">未在播放</b>
            <span id="now-artist">从右侧列表选一首歌</span>
            <small id="now-meta">Opus 64k · 完整曲库</small>
          </div>
          <div class="now-lyrics" id="now-lyrics"><p class="lyrics-empty">选一首歌开始播放</p></div>
        </aside>
      </div>
    </main>`,
    '音乐',
  )

  ensureBar()
  renderBar()
  renderNowPanel()

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
    })
    .catch((error: Error) => {
      const host = document.getElementById('music-list')
      if (host) host.innerHTML = `<p class="ml-empty">曲库加载失败：${esc(error.message)}</p>`
    })

}

// 全局快捷键只注册一次，避免每次进页面就叠加监听
window.addEventListener('keydown', (event) => {
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
