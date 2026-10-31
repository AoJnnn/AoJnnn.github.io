#!/usr/bin/env node
/**
 * 构建期生成 RSS 与 sitemap
 *
 * 从 content/posts/*.md 的 frontmatter 读取文章信息，
 * 生成 public/rss.xml 和 public/sitemap.xml。
 *
 * 这两个文件同样不入库（见 .gitignore），每次构建自动生成。
 *
 * 注意：站点是 hash 路由（#/post/slug），搜索引擎对 hash 片段收录有限，
 * sitemap 的价值主要在「告诉搜索引擎有哪些页面」以及首页/栏目页。
 * RSS 则对读者订阅真实有用。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const POSTS_DIR = join(REPO_ROOT, 'content', 'posts')
const OUT_DIR = join(REPO_ROOT, 'public')

const SITE = process.env.SITE_URL || 'https://aojnnn.github.io'
const TITLE = 'AoJnnn / OurNotes'
const DESC = 'AoJnnn 的个人笔记、动漫记录和实用小工具。'

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])

function parseFrontmatter(raw) {
  const [, fm = ''] = raw.split(/^---\s*$/m)
  const meta = {}
  for (const line of fm.trim().split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key) meta[key] = value
  }
  return meta
}

const posts = readdirSync(POSTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((file) => {
    const meta = parseFrontmatter(readFileSync(join(POSTS_DIR, file), 'utf8'))
    const slug = basename(file, '.md')
    return {
      slug,
      title: meta.title || slug,
      date: meta.date || '',
      category: meta.category || '',
      description: meta.description || '',
      url: `${SITE}/#/post/${encodeURIComponent(slug)}`,
    }
  })
  .filter((p) => p.date)
  .sort((a, b) => b.date.localeCompare(a.date))

mkdirSync(OUT_DIR, { recursive: true })

/* ---------- RSS 2.0 ---------- */

const rfc822 = (d) => {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00+08:00`) : new Date(d)
  return Number.isNaN(t.getTime()) ? new Date().toUTCString() : t.toUTCString()
}

const items = posts
  .map(
    (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${esc(p.url)}</link>
      <guid isPermaLink="true">${esc(p.url)}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
${p.category ? `      <category>${esc(p.category)}</category>\n` : ''}      <description>${esc(p.description)}</description>
    </item>`,
  )
  .join('\n')

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(TITLE)}</title>
    <link>${SITE}/</link>
    <description>${esc(DESC)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`

/* ---------- sitemap ---------- */

const pages = [
  { loc: `${SITE}/`, priority: '1.0' },
  { loc: `${SITE}/#/archive`, priority: '0.9' },
  { loc: `${SITE}/#/music`, priority: '0.8' },
  { loc: `${SITE}/#/tools`, priority: '0.6' },
  { loc: `${SITE}/#/guestbook`, priority: '0.5' },
  { loc: `${SITE}/#/updates`, priority: '0.5' },
  ...posts.map((p) => ({ loc: p.url, priority: '0.7', lastmod: p.date })),
]

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (p) =>
      `  <url>\n    <loc>${esc(p.loc)}</loc>${p.lastmod ? `\n    <lastmod>${p.lastmod}</lastmod>` : ''}\n    <priority>${p.priority}</priority>\n  </url>`,
  )
  .join('\n')}
</urlset>
`

writeFileSync(join(OUT_DIR, 'rss.xml'), rss, 'utf8')
writeFileSync(join(OUT_DIR, 'sitemap.xml'), sitemap, 'utf8')
console.log(`已生成 rss.xml（${posts.length} 篇）与 sitemap.xml（${pages.length} 条 URL）`)
