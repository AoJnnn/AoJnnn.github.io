#!/usr/bin/env node
/**
 * 构建期生成动态页数据
 *
 * 在 GitHub Actions 里运行，用自带的 GITHUB_TOKEN 调 API（不限流），
 * 把最近若干条 commit 写成 public/updates.json，随构建一起发布。
 *
 * 这个文件不提交进仓库（见 .gitignore），每次部署自动生成。
 * 本地开发时没有它，页面会自动回退到直连 GitHub API。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx GITHUB_REPOSITORY=owner/repo node scripts/fetch-updates.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const REPO = process.env.GITHUB_REPOSITORY || 'AoJnnn/AoJnnn.github.io'
const TOKEN = process.env.GITHUB_TOKEN || ''
const PER_PAGE = Number(process.env.UPDATES_PER_PAGE || 15)
const OUT = join(REPO_ROOT, 'public', 'updates.json')

const url = `https://api.github.com/repos/${REPO}/commits?per_page=${PER_PAGE}`
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'aojnnn-build',
  'X-GitHub-Api-Version': '2022-11-28',
}
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`

function shape(commit) {
  return {
    sha: commit.sha,
    html_url: commit.html_url,
    commit: {
      message: commit.commit?.message ?? '',
      author: { date: commit.commit?.author?.date ?? '' },
    },
    author: { login: commit.author?.login ?? '' },
  }
}

try {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const raw = await res.json()
  if (!Array.isArray(raw)) throw new Error('响应不是数组')

  const commits = raw.map(shape)
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(commits, null, 2), 'utf8')
  console.log(`已写入 ${commits.length} 条提交到 public/updates.json（${TOKEN ? '带 token' : '匿名'}）`)
} catch (error) {
  // 生成失败不阻断构建：前端会自动回退到直连 API
  console.warn(`生成 updates.json 失败，跳过：${error.message}`)
}
