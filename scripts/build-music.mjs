#!/usr/bin/env node
/**
 * 音乐库预处理脚本
 *
 * 扫描本地音乐目录，把 mp3 转成 Opus、抽出内嵌封面与歌词、生成清单 JSON。
 * 输出到 public/music/，供前端播放器直接使用（不进 Vite 打包，走静态托管）。
 *
 * 用法：
 *   node scripts/build-music.mjs [源目录] [输出目录] [--limit=N] [--bitrate=64k]
 *
 * 默认：
 *   源目录   D:\AllThing\Music\MUSIC
 *   输出目录 <repo>/public/music
 *   码率     64k
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs'
import { join, relative, basename, dirname, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)

const SRC = positional[0] || 'D:\\AllThing\\Music\\MUSIC'
const OUT = positional[1] || join(REPO, 'public', 'music')
const BITRATE = flags.bitrate || '64k'
const LIMIT = flags.limit ? Number(flags.limit) : Infinity
const CLEAN = flags.clean === 'true'

const AUDIO_DIR = join(OUT, 'audio')
const COVER_DIR = join(OUT, 'covers')
const LYRIC_DIR = join(OUT, 'lyrics')

/* ---------- 工具 ---------- */

function run(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

function probe(file) {
  const raw = run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file])
  return JSON.parse(raw)
}

/** 递归收集 mp3 */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (/\.(mp3|m4a|flac|wav|ogg)$/i.test(entry.name)) acc.push(full)
  }
  return acc
}

/** 大小写不敏感地取标签 */
function tag(tags, ...names) {
  if (!tags) return ''
  const lower = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]))
  for (const n of names) {
    const key = n.toLowerCase()
    if (lower[key]) return String(lower[key])
  }
  return ''
}

// 时间戳允许尾随噪声（如 [00:12.34-1]），与前端解析保持一致
const hasTimestamp = (text) => /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?[^\]]*\]/.test(text)

function slugId(relPath) {
  return createHash('sha1').update(relPath).digest('hex').slice(0, 10)
}

/* ---------- 主流程 ---------- */

if (!existsSync(SRC)) {
  console.error(`源目录不存在：${SRC}`)
  process.exit(1)
}

if (CLEAN) {
  for (const d of [AUDIO_DIR, COVER_DIR, LYRIC_DIR]) rmSync(d, { recursive: true, force: true })
}
for (const d of [AUDIO_DIR, COVER_DIR, LYRIC_DIR]) mkdirSync(d, { recursive: true })

const files = walk(SRC).slice(0, LIMIT)
console.log(`找到 ${files.length} 个音频文件`)
console.log(`码率 ${BITRATE} → ${OUT}\n`)

const tracks = []
let skipped = 0

for (const [index, file] of files.entries()) {
  const rel = relative(SRC, file)
  const id = slugId(rel)
  const label = `[${String(index + 1).padStart(3, ' ')}/${files.length}] ${rel}`

  try {
    const info = probe(file)
    const tags = info.format?.tags ?? {}
    const duration = Number(info.format?.duration ?? 0)
    const title = tag(tags, 'title') || basename(file, extname(file))
    const artist = tag(tags, 'artist') || '未知歌手'
    const album = tag(tags, 'album')
    const category = basename(dirname(rel))

    // 1) 转码
    const audioOut = join(AUDIO_DIR, `${id}.opus`)
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file,
      '-vn', '-map', '0:a:0',
      '-c:a', 'libopus', '-b:a', BITRATE, '-vbr', 'on', '-application', 'audio',
      '-map_metadata', '-1',
      audioOut,
    ])

    // 2) 封面（大图 400px + 列表缩略 80px）
    let cover = null
    let thumb = null
    const hasVideo = (info.streams ?? []).some((s) => s.codec_type === 'video')
    if (hasVideo) {
      const big = join(COVER_DIR, `${id}.webp`)
      const small = join(COVER_DIR, `${id}-sm.webp`)
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', '-vf', 'scale=400:-1', big])
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1', '-c:v', 'libwebp', '-quality', '78', '-vf', 'scale=80:-1', small])
      cover = `covers/${id}.webp`
      thumb = `covers/${id}-sm.webp`
    }

    // 3) 歌词：优先内嵌，其次同目录同名 .lrc
    const embedded = tag(tags, 'lyrics', 'unsyncedlyrics', 'unsynchronised_lyric', 'uslt')
    const sidecar = file.replace(/\.(mp3|m4a|flac|wav|ogg)$/i, '.lrc')
    let lyrics = embedded
    if (!lyrics && existsSync(sidecar)) {
      lyrics = readFileSync(sidecar, 'utf8')
    }
    let hasLyrics = false
    if (lyrics && lyrics.trim()) {
      writeFileSync(join(LYRIC_DIR, `${id}.lrc`), lyrics.trim(), 'utf8')
      hasLyrics = true
    }

    tracks.push({
      id,
      title: title.trim(),
      artist: artist.trim(),
      album: album.trim(),
      category,
      duration: Math.round(duration * 10) / 10,
      synced: hasLyrics ? hasTimestamp(lyrics) : false,
      cover,
      thumb,
      hasLyrics,
      size: statSync(audioOut).size,
    })

    console.log(`${label}  →  ${title}`)
  } catch (error) {
    skipped++
    console.warn(`${label}  !! 跳过：${error.message.split('\n')[0]}`)
  }
}

tracks.sort((a, b) => a.category.localeCompare(b.category, 'zh') || a.title.localeCompare(b.title, 'zh'))

const categories = [...new Set(tracks.map((t) => t.category))]
const manifest = {
  generatedAt: new Date().toISOString(),
  bitrate: BITRATE,
  totalDuration: Math.round(tracks.reduce((sum, t) => sum + t.duration, 0)),
  categories,
  tracks,
}
writeFileSync(join(OUT, 'tracks.json'), JSON.stringify(manifest, null, 2), 'utf8')

const totalBytes = tracks.reduce((sum, t) => sum + t.size, 0)
console.log(`\n完成：${tracks.length} 首，跳过 ${skipped} 首`)
console.log(`音频合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
console.log(`总时长 ${(manifest.totalDuration / 3600).toFixed(1)} 小时`)
console.log(`分类：${categories.join(' / ')}`)
