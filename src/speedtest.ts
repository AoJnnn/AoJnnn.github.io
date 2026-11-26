/**
 * 网站连接测速
 *
 * 目的：判断用户到 GitHub Pages 的连接能不能顺畅播放站内音乐、能不能快速打开番剧页面。
 *
 * 三项指标：
 *   1. 响应延迟 —— 小体积 Range 请求的 TTFB 中位数，反映往返延迟
 *   2. 下载速度 —— 下载一份真实音频片段（256 KB）的吞吐量
 *   3. 点击起播 —— 同等带宽下，点一首代表曲目到能出声的估算耗时
 *
 * 结论阈值参考了站内实测：64k Opus 约 8 KB/s 就能持续播放不卡，
 * 但要做到「点下去马上有声音」，起播前 256 KB 最好在 1.5 秒内到齐。
 */

export type SpeedResult = {
  latency: number | null
  mbps: number | null
  startup: number | null
  probeBytes: number | null
  verdict: 'good' | 'ok' | 'bad' | 'fail'
  /** fail 时说明是哪一段断了 */
  failure?: 'site' | 'github' | null
  /** 测速样本是否来自 CDN 缓存（浏览器里读不到 x-cache，目前恒为 false，保留字段备用） */
  cached?: boolean
}

const PROBE_BYTES = 262144 // 与 music.ts 的 warmTrack 预热窗口对齐
const LARGE_BYTES = 2000000 // 测速用「接近整首」的片段，更能代表持续播放
const LATENCY_BYTES = 1024 // 延迟探针：只要一个响应头，不用大文件
const LATENCY_ROUNDS = 3

// 只用来区分「你的站连不上」和「整个 GitHub 连不上」，不参与速度计算
const API_BASE = 'https://api.github.com/repos/AoJnnn/AoJnnn.github.io'

/** 取 n 个延迟样本的中位数 */
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 下载指定字节并统计耗时。
 *
 * 实现取舍：用 arrayBuffer() 而不是流式 reader。实测在 Chromium 里，
 * 用 reader 且总量卡在文件大小以内时，最后一块永远等不到（数据已经到齐，
 * 但读取循环不结束），流式统计会一直挂着。代价是服务端若不支持 Range
 * 会把整首下完，所以先做一次 1 KB 探测确认返回 206，才敢请求大片段。
 */
async function timedRange(url: string, bytes: number, signal: AbortSignal) {
  const started = performance.now()
  const response = await fetch(url, {
    signal,
    cache: 'no-store',
    headers: { Range: `bytes=0-${bytes - 1}` },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  const finished = performance.now()
  return {
    total: finished - started,
    received: buffer.byteLength,
    status: response.status,
    accepted: response.status === 206,
    // CDN 缓存标记（x-cache / age）在浏览器里读不到，所以这里判断不了是否命中缓存；
    // 函数只负责如实测量，是否可能虚高交给 UI 提示
  }
}

/**
 * 延迟探测。量的就是站内音频本身——那才是用户真正下载东西走的路径。
 */
async function measureLatency(url: string, signal: AbortSignal): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < LATENCY_ROUNDS; i += 1) {
    const result = await timedRange(url, LATENCY_BYTES, signal)
    if (result.received > 0) samples.push(result.total)
  }
  return samples
}

export type SpeedProgress = {
  stage: 'latency' | 'bandwidth' | 'startup' | 'done'
  latency?: number | null
  mbps?: number | null
  /** 测速中途失败时带回来的原因，用于给出更有针对性的建议 */
  failure?: 'site' | 'github' | null
}

/**
 * 跑一次完整测速。onProgress 用于逐步刷新 UI。
 * 返回 null 表示被用户中止。
 */
export async function runSpeedTest(
  audioUrl: string,
  onProgress: (progress: SpeedProgress) => void,
  signal: AbortSignal,
): Promise<SpeedResult | null> {
  const stamp = Date.now()
  const siteUrl = `${audioUrl}${audioUrl.includes('?') ? '&' : '?'}speed=${stamp}`
  let failure: 'site' | 'github' = 'site'
  try {
    // ---- 1. 先确认站内文件能连上，并确认它支持 Range ----
    const probe = await timedRange(siteUrl, LATENCY_BYTES, signal)
    if (!probe.accepted) {
      // 服务端不支持 Range：不能发大请求（会把整首下完），只能用这个 1 KB 探针算延迟
      onProgress({ stage: 'latency', latency: probe.total })
      onProgress({ stage: 'bandwidth', latency: probe.total, mbps: null })
      return { latency: probe.total, mbps: null, startup: null, probeBytes: null, verdict: 'fail', failure: null }
    }

    // ---- 2. 延迟：同一首曲子连打几次，取中位数 ----
    // 探针已经是一次完整的往返了，直接算进样本，省掉一次请求
    onProgress({ stage: 'latency' })
    const latency = median([probe.total, ...(await measureLatency(`${siteUrl}&lat=${stamp}`, signal))])
    onProgress({ stage: 'latency', latency })

    // ---- 3. 带宽：真实音频片段 ----
    onProgress({ stage: 'bandwidth' })
    const large = await timedRange(`${siteUrl}&bw=${stamp}`, LARGE_BYTES, signal)
    const usedBytes = Math.min(large.received, LARGE_BYTES)
    const seconds = Math.max(large.total, 1) / 1000
    // 只收到一点点说明连接极差，这个数字不可信
    const safeMbps = usedBytes > 32768 ? (usedBytes * 8) / seconds / 1e6 : null
    onProgress({ stage: 'bandwidth', latency, mbps: safeMbps })

    // ---- 4. 起播耗时：按实测速度推算 PROBE_BYTES 到齐需要多久 ----
    const startup = safeMbps && safeMbps > 0 ? (PROBE_BYTES / ((safeMbps * 1e6) / 8)) * 1000 : null
    onProgress({ stage: 'startup', latency, mbps: safeMbps })

    return {
      latency,
      mbps: safeMbps,
      startup,
      probeBytes: usedBytes,
      verdict: judge(latency, safeMbps, startup),
      failure: null,
      cached: false,
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') return null
    // 站内连不上：看看 GitHub 本身通不通，好把责任分清楚
    const github = await fetch(`${API_BASE}?t=${Date.now()}`, { signal, cache: 'no-store', mode: 'cors' })
      .then((res) => res.ok)
      .catch(() => false)
    failure = github ? 'site' : 'github'
    return { latency: null, mbps: null, startup: null, probeBytes: null, verdict: 'fail', failure }
  }
}

/** 依据实测值给出结论 */
function judge(latency: number | null, mbps: number | null, startup: number | null): SpeedResult['verdict'] {
  if (mbps === null) return 'fail'
  // 64k Opus 只需约 8 KB/s（0.064 Mbps）就能连续播放，这里留到 0.5 Mbps 的余量
  if (startup !== null && startup <= 1500 && mbps >= 2) return 'good'
  if (startup !== null && startup <= 4000 && mbps >= 0.5) return 'ok'
  if (latency !== null && latency > 1200 && mbps < 0.5) return 'bad'
  return mbps >= 0.5 ? 'ok' : 'bad'
}

/** 人类可读的速度 */
export const formatMbps = (mbps: number | null) =>
  mbps === null ? '—' : mbps >= 10 ? `${mbps.toFixed(1)} Mbps` : mbps >= 1 ? `${mbps.toFixed(2)} Mbps` : `${(mbps * 1000).toFixed(0)} Kbps`

/** 人类可读的耗时 */
export const formatMs = (ms: number | null) => (ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} 秒` : `${Math.round(ms)} ms`)

/** 把「起播耗时 / 速度」翻译成人话 */
export function describe(result: SpeedResult): { title: string; detail: string; tips: string[] } {
  const { verdict, latency, mbps, startup } = result
  if (verdict === 'fail') {
    if (result.failure === 'github') {
      return { title: '连不上 GitHub', detail: '到 GitHub 的线路不通。', tips: ['换个网络再试'] }
    }
    return { title: '连不上这个站点', detail: 'GitHub 通的，是站内文件没下下来。', tips: ['关掉拦截插件后重试'] }
  }

  const frames: Record<Exclude<SpeedResult['verdict'], 'fail'>, { title: string; detail: string; tips: string[] }> = {
    good: { title: '放音乐没问题', detail: '点下去就能出声。', tips: [] },
    ok: { title: '能听，但起播要等一下', detail: '播放不中断，点歌会空 1.5～4 秒。', tips: ['同一首第二次会快很多'] },
    bad: { title: '建议不要在这里听歌', detail: '带宽不够，会频繁卡顿。', tips: ['换 Wi-Fi 或流量再试'] },
  }

  const picked = frames[verdict as Exclude<SpeedResult['verdict'], 'fail'>]
  const facts = [
    startup === null ? '' : `起播 ${formatMs(startup)}`,
    mbps === null ? '' : formatMbps(mbps),
    latency === null ? '' : `延迟 ${formatMs(latency)}`,
  ].filter(Boolean)

  return {
    title: picked.title,
    detail: facts.length ? `${picked.detail}（${facts.join(' · ')}）` : picked.detail,
    // CDN 有缓存，数字偏乐观，这句只在折叠的详细结果里出现一次即可
    tips: [...picked.tips, 'CDN 缓存会让数字偏乐观'],
  }
}
