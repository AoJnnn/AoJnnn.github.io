/**
 * 音频本地缓存（IndexedDB）
 *
 * 目的：不换服务器、不降码率，让「听过的歌」和「下一首」几乎瞬间起播。
 *
 * 策略：
 * - 第一次播放照常流式加载（保证起播快，不整包下载）
 * - 播完 / 缓冲充足后，把整首歌抓一次存进 IndexedDB。
 *   此时文件通常还在 HTTP 缓存里（GitHub Pages 有 10 分钟 max-age），
 *   所以这一次抓取几乎不额外消耗流量。
 * - 之后再次播放直接走 blob URL，无需网络
 *
 * 缓存容量按条数上限 + LRU 淘汰，避免把浏览器存储塞爆。
 */

const DB_NAME = 'aojnnn-music'
const DB_VERSION = 1
const STORE_AUDIO = 'audio'
const STORE_META = 'meta'
const MAX_TRACKS = 60

/** id -> objectURL，避免重复 createObjectURL 造成内存泄漏 */
const urlCache = new Map<string, string>()
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    // 兜底：某些环境（隐私模式、存储被禁用、容器里）打开会一直挂着。
    // 这里最多等 1.5 秒，超时就当没有缓存，绝不能拖住播放。
    let settled = false
    const done = (db: IDBDatabase | null) => {
      if (settled) return
      settled = true
      resolve(db)
    }
    setTimeout(() => done(null), 1500)

    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      done(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_AUDIO)) db.createObjectStore(STORE_AUDIO)
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META)
    }
    req.onsuccess = () => done(req.result)
    req.onerror = () => done(null)
    req.onblocked = () => done(null)
  })
  return dbPromise
}

function readBlob(db: IDBDatabase, id: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_AUDIO, 'readonly')
      const get = tx.objectStore(STORE_AUDIO).get(id)
      get.onsuccess = () => resolve(get.result instanceof Blob ? get.result : null)
      get.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** 列出已缓存的所有曲目 id（页面启动时载入内存，供同步判断） */
export async function listCachedIds(): Promise<string[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_AUDIO, 'readonly')
      const keys = tx.objectStore(STORE_AUDIO).getAllKeys()
      keys.onsuccess = () => resolve((keys.result ?? []).map(String))
      keys.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

/**
 * 取本地缓存并转成可播放的 blob URL。
 * 命中返回 url，未命中返回 null（调用方回退到网络地址）。
 */
export async function getCachedUrl(id: string): Promise<string | null> {
  const hit = urlCache.get(id)
  if (hit) return hit
  const db = await openDb()
  if (!db) return null
  const blob = await readBlob(db, id)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(id, url)
  return url
}

/** 是否已有缓存（不创建 URL） */
export async function hasCached(id: string): Promise<boolean> {
  if (urlCache.has(id)) return true
  const db = await openDb()
  if (!db) return false
  return (await readBlob(db, id)) !== null
}

function putValue(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

function getAllMeta(db: IDBDatabase): Promise<Array<{ id: string; at: number }>> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_META, 'readonly')
      const store = tx.objectStore(STORE_META)
      const keys = store.getAllKeys()
      const vals = store.getAll()
      tx.oncomplete = () => {
        const out: Array<{ id: string; at: number }> = []
        const ks = keys.result ?? []
        const vs = vals.result ?? []
        for (let i = 0; i < ks.length; i++) {
          const at = (vs[i] as { at?: number } | undefined)?.at ?? 0
          out.push({ id: String(ks[i]), at })
        }
        resolve(out)
      }
      tx.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

function deleteKeys(db: IDBDatabase, ids: string[]): Promise<void> {
  return new Promise((resolve) => {
    if (!ids.length) {
      resolve()
      return
    }
    try {
      const tx = db.transaction([STORE_AUDIO, STORE_META], 'readwrite')
      const audioStore = tx.objectStore(STORE_AUDIO)
      const metaStore = tx.objectStore(STORE_META)
      for (const id of ids) {
        audioStore.delete(id)
        metaStore.delete(id)
        const url = urlCache.get(id)
        if (url) {
          URL.revokeObjectURL(url)
          urlCache.delete(id)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

/**
 * 写入缓存。超出 MAX_TRACKS 时按最后访问时间淘汰最旧的。
 * 存储配额不足时静默放弃（不影响播放）。
 */
export async function putCachedBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb()
  if (!db) return
  await putValue(db, STORE_AUDIO, id, blob)
  await putValue(db, STORE_META, id, { at: Date.now() })

  const meta = await getAllMeta(db)
  if (meta.length > MAX_TRACKS) {
    const stale = meta.sort((a, b) => a.at - b.at).slice(0, meta.length - MAX_TRACKS)
    await deleteKeys(db, stale.map((m) => m.id))
  }
}

/** 更新最后访问时间（命中缓存时调用，保证 LRU 准确） */
export async function touchCached(id: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  await putValue(db, STORE_META, id, { at: Date.now() })
}
