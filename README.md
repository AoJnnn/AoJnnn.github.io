# AoJnnn / OurNotes

一个基于 Vite + TypeScript 的静态个人博客，文章使用 Markdown 管理，适合部署到 GitHub Pages，也方便未来迁移到自己的服务器。

## 本地运行

```bash
npm install
npm run dev
```

## 发布文章

在 `content/posts/` 新建 `.md` 文件，写入 frontmatter 和正文：

```md
---
title: "文章标题"
date: "2026-10-15"
category: "技术"
description: "一句话摘要"
cover: "./cover.jpg"
---

正文内容。
```

推送到 GitHub 仓库的 `main` 分支后，`.github/workflows/deploy.yml` 会自动构建并发布到 Pages。首次使用时，在仓库 Settings > Pages > Build and deployment 中选择 GitHub Actions。

## 结构

- `content/posts/`: Markdown 文章
- `src/main.ts`: 页面路由和交互
- `src/music.ts` / `src/music.css`: 音乐库页面与播放器
- `scripts/build-music.mjs`: 音乐库预处理脚本
- `.github/workflows/deploy.yml`: GitHub Pages 自动部署

## 音乐库

音乐页面（`#/music`）读取 `public/music/` 下由脚本生成的静态资源，**不依赖任何外部服务**：

```
public/music/
├─ tracks.json       曲目清单（标题 / 歌手 / 专辑 / 时长 / 分类 / 封面 / 是否有歌词）
├─ audio/<id>.opus   Opus 64k 音频
├─ covers/<id>.webp  封面大图 400px
├─ covers/<id>-sm.webp 封面缩略 80px
└─ lyrics/<id>.lrc   歌词（LRC，带时间轴则自动滚动）
```

### 重新生成

源目录默认是 `D:\AllThing\Music\MUSIC`，可传参覆盖：

```bash
npm run music                                  # 用默认源目录
node scripts/build-music.mjs "D:\其他\音乐目录"  # 指定源目录
node scripts/build-music.mjs "" "" --bitrate=48k --clean=1
```

脚本会：

1. 递归扫描源目录下的音频文件（mp3 / m4a / flac / wav / ogg）
2. 转码为 Opus（默认 64k，VBR），并清除原标签
3. 从内嵌封面抽出 400px 与 80px 两档 WebP
4. 抽出内嵌歌词为 `.lrc`（没有内嵌时回退到同目录同名 `.lrc`）
5. 生成 `tracks.json`，以「所在子目录名」作为分类

`<id>` 是源文件相对路径的 SHA-1 前 10 位，所以增删歌曲不会打乱其他曲目的链接。

### 播放器特性

- 单例 `<audio>`，挂在 `body` 上，切页不中断播放
- 底部播放条在所有页面常驻，支持上一首/播放/下一首、进度拖动、音量、列表循环、单曲循环、随机
- 歌词按 LRC 时间轴高亮并自动居中滚动，支持双语同行
- 支持 Media Session（锁屏 / 系统媒体控件）
- 空格播放暂停，Shift + 左右方向键切歌

