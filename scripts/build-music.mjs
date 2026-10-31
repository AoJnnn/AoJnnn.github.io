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

/** 大小写、空白都不敏感地取标签 */
function tag(tags, ...names) {
  if (!tags) return ''
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '')
  const flat = Object.fromEntries(Object.entries(tags).map(([k, v]) => [norm(k), v]))
  for (const n of names) {
    const key = norm(n)
    if (flat[key]) return String(flat[key])
  }
  return ''
}

/**
 * 提取歌词。
 * 不能只认 "lyrics"：不同标签工具会写成 "lyrics-   "（尾部带空格）、
 * "lyrics-eng"、"unsyncedlyrics" 等等，精确匹配会漏掉大量歌曲。
 * 这里按名字里是否含 lyric/uslt 来判定，且只接受非空内容。
 */
function extractLyrics(tags) {
  if (!tags) return ''
  const candidates = Object.entries(tags)
    .filter(([k]) => /lyric|uslt|unsync/i.test(k))
    .map(([k, v]) => ({ k: k.toLowerCase().trim(), v: String(v ?? '') }))
    .filter((e) => e.v.trim().length > 0)
  if (!candidates.length) return ''
  // 名字短的优先，通常是原文而不是 xxx-eng 之类的翻译版本
  candidates.sort((a, b) => a.k.length - b.k.length)
  return candidates[0].v
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
let reused = 0

// 增量：读取上一次的清单，源文件没变就直接复用，不重新编码
const prevManifest = (() => {
  try {
    return JSON.parse(readFileSync(join(OUT, 'tracks.json'), 'utf8'))
  } catch {
    return null
  }
})()
const prevById = new Map((prevManifest?.tracks ?? []).map((t) => [t.id, t]))
const FORCE = flags.force === 'true'

// 码率变了就必须全部重编，否则增量逻辑会把旧码率的文件当成「未变化」跳过
const bitrateChanged = Boolean(prevManifest) && prevManifest.bitrate !== BITRATE
if (bitrateChanged) {
  console.log(`检测到码率变化（${prevManifest.bitrate} → ${BITRATE}），将重新编码全部曲目\n`)
}
const reencodeAll = FORCE || bitrateChanged

for (const [index, file] of files.entries()) {
  const rel = relative(SRC, file)
  const id = slugId(rel)
  const label = `[${String(index + 1).padStart(3, ' ')}/${files.length}] ${rel}`
  const audioOut = join(AUDIO_DIR, `${id}.opus`)

  try {
    const stat = statSync(file)
    // 用「大小 + 修改时间」做签名，避免对 1GB 源文件做哈希
    const srcSig = `${stat.size}-${Math.round(stat.mtimeMs)}`

    // 复用条件：清单里有记录、源签名未变、且所有产物都还在
    const prev = prevById.get(id)
    const prevSigOk = prev && (prev.srcSig === undefined || prev.srcSig === srcSig)

    // 歌词来源签名：内嵌歌词改了，或旁边新放了/改了 .lrc，都要重新生成。
    // 只比对音频文件的「大小+时间」会漏掉这两种情况。
    const sidecarPath = file.replace(/\.(mp3|m4a|flac|wav|ogg)$/i, '.lrc')
    const sidecarSig = existsSync(sidecarPath)
      ? `lrc-${statSync(sidecarPath).size}-${Math.round(statSync(sidecarPath).mtimeMs)}`
      : ''
    const lyricsSigOk = prev && (prev.lyricsSig === undefined || prev.lyricsSig === sidecarSig)

    const outputsOk =
      prev &&
      existsSync(audioOut) &&
      (!prev.cover || existsSync(join(OUT, prev.cover))) &&
      (!prev.thumb || existsSync(join(OUT, prev.thumb))) &&
      (!prev.hasLyrics || existsSync(join(LYRIC_DIR, `${id}.lrc`)))

    // 注意：这里不能要求 lyricsSigOk。
    // 歌词来源变化时 audio 不需要重编，但必须进到分支里单独重写歌词，
    // 否则条件一为假就直接跑去完整重建（白白重新编码音频）。
    if (!reencodeAll && prev && prevSigOk && outputsOk) {
      // 之前判定「没有歌词」的，重新扫一遍标签。
      // 歌词提取规则修过（例如 lyrics- 这种带空格的键，
      // 或后来补了 .lrc），这些曲目不能被增量逻辑永远跳过。
      if (!prev.hasLyrics && !prev.lyricsChecked) {
        const info = probe(file)
        const txt = extractLyrics(info.format?.tags)
        const sideText2 = existsSync(sidecarPath) ? readFileSync(sidecarPath, 'utf8').trim() : ''
        const finalTxt = sideText2 || txt
        if (finalTxt.trim()) {
          writeFileSync(join(LYRIC_DIR, `${id}.lrc`), finalTxt.trim(), 'utf8')
          tracks.push({
            ...prev,
            hasLyrics: true,
            synced: hasTimestamp(finalTxt),
            lyricsChecked: true,
            srcSig,
            lyricsSig: sidecarSig,
          })
          reused++
          console.log(`${label}  →  ${prev.title}  (补出歌词)`)
          continue
        }
        tracks.push({ ...prev, lyricsChecked: true, srcSig, lyricsSig: sidecarSig })
        reused++
        console.log(`${label}  →  ${prev.title}  (仍未找到歌词)`)
        continue
      }

      // 音频没变，但歌词来源变了（换了 .lrc 文件或内嵌歌词被改）：只重写歌词
      if (!lyricsSigOk) {
        const existingLyric = join(LYRIC_DIR, `${id}.lrc`)
        const previousText = existsSync(existingLyric) ? readFileSync(existingLyric, 'utf8').trim() : ''
        const info = probe(file)
        const sideText3 = existsSync(sidecarPath) ? readFileSync(sidecarPath, 'utf8').trim() : ''
        const nextText = (sideText3 || extractLyrics(info.format?.tags)).trim()
        if (!nextText) {
          // 歌词被删掉了：产物也一并移除
          if (existsSync(existingLyric)) rmSync(existingLyric, { force: true })
          tracks.push({ ...prev, hasLyrics: false, synced: false, srcSig, lyricsSig: sidecarSig })
          reused++
          console.log(`${label}  →  ${prev.title}  (歌词已移除)`)
          continue
        }
        if (nextText !== previousText) {
          writeFileSync(existingLyric, nextText, 'utf8')
          tracks.push({
            ...prev,
            hasLyrics: true,
            synced: hasTimestamp(nextText),
            srcSig,
            lyricsSig: sidecarSig,
          })
          reused++
          console.log(`${label}  →  ${prev.title}  (更新歌词)`)
          continue
        }
      }

      tracks.push({ ...prev, srcSig, lyricsSig: sidecarSig })
      reused++
      console.log(`${label}  →  ${prev.title}  (未变化，复用)`)
      continue
    }

    const info = probe(file)
    const tags = info.format?.tags ?? {}
    const duration = Number(info.format?.duration ?? 0)
    const title = tag(tags, 'title') || basename(file, extname(file))
    const artist = tag(tags, 'artist') || '未知歌手'
    const album = tag(tags, 'album')
    const category = basename(dirname(rel))

    // 1) 转码
    //    -fflags +bitexact / -flags:a +bitexact 让输出可复现：
    //    Ogg 容器默认写入随机流序列号，不加这两项的话每次重跑
    //    都会产生字节不同的文件，git 会把整个曲库标记为已修改。
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file,
      '-vn', '-map', '0:a:0',
      '-c:a', 'libopus', '-b:a', BITRATE, '-vbr', 'on', '-application', 'audio',
      '-map_metadata', '-1',
      '-fflags', '+bitexact', '-flags:a', '+bitexact',
      audioOut,
    ])

    // 2) 封面（大图 400px + 列表缩略 80px）
    let cover = null
    let thumb = null
    const hasVideo = (info.streams ?? []).some((s) => s.codec_type === 'video')
    if (hasVideo) {
      const big = join(COVER_DIR, `${id}.webp`)
      const small = join(COVER_DIR, `${id}-sm.webp`)
      const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1', '-c:v', 'libwebp']
      const tail = ['-fflags', '+bitexact', '-flags:v', '+bitexact']
      run('ffmpeg', [...common, '-quality', '82', '-vf', 'scale=400:-1', ...tail, big])
      run('ffmpeg', [...common, '-quality', '78', '-vf', 'scale=80:-1', ...tail, small])
      cover = `covers/${id}.webp`
      thumb = `covers/${id}-sm.webp`
    }

    // 3) 歌词：同目录同名 .lrc 优先，其次内嵌标签。
    //    外部文件优先，是为了让人能手动覆盖/修正某首歌的歌词——
    //    否则内嵌歌词永远压过你自己放的文件，改了等于没改。
    const embedded = extractLyrics(tags)
    const sidecar = file.replace(/\.(mp3|m4a|flac|wav|ogg)$/i, '.lrc')
    let lyrics = embedded
    if (existsSync(sidecar)) {
      const sideText = readFileSync(sidecar, 'utf8').trim()
      if (sideText) lyrics = sideText
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
      srcSig,
      lyricsSig: sidecarSig,
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

// 用了 --limit 说明是试跑，绝不能覆盖正式的清单，否则线上会只剩这几首
const isPartial = Number.isFinite(LIMIT)
const manifestPath = join(OUT, isPartial ? 'tracks.partial.json' : 'tracks.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
if (isPartial) {
  console.warn(`\n⚠️  使用了 --limit=${LIMIT}，清单已写入 tracks.partial.json（不会覆盖 tracks.json）`)
} else {
  // 清理孤儿文件：源目录里已经删掉的歌，产物不应继续留在仓库里。
  // 只在完整扫描时执行；--limit 试跑会跳过，否则会把没扫到的曲目当成孤儿删掉。
  const keep = new Set(tracks.map((t) => t.id))
  const orphans = []
  const sweep = (dir, match) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const stem = match(name)
      if (stem && !keep.has(stem)) orphans.push(join(dir, name))
    }
  }
  sweep(AUDIO_DIR, (n) => (n.endsWith('.opus') ? n.slice(0, -5) : null))
  sweep(COVER_DIR, (n) => (n.endsWith('-sm.webp') ? n.slice(0, -8) : n.endsWith('.webp') ? n.slice(0, -5) : null))
  sweep(LYRIC_DIR, (n) => (n.endsWith('.lrc') ? n.slice(0, -4) : null))

  for (const p of orphans) rmSync(p, { force: true })
  if (orphans.length) {
    console.log(`\n清理孤儿文件：${orphans.length} 个（源目录已不存在的曲目）`)
    for (const p of orphans.slice(0, 10)) console.log(`  - ${relative(OUT, p)}`)
    if (orphans.length > 10) console.log(`  ...还有 ${orphans.length - 10} 个`)
  }
}

const totalBytes = tracks.reduce((sum, t) => sum + t.size, 0)
console.log(`\n完成：${tracks.length} 首（复用 ${reused} 首，跳过 ${skipped} 首）`)
console.log(`音频合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
console.log(`总时长 ${(manifest.totalDuration / 3600).toFixed(1)} 小时`)
console.log(`分类：${categories.join(' / ')}`)
