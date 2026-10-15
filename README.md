# Lian / Notes

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
---

正文内容。
```

推送到 GitHub 仓库的 `main` 分支后，`.github/workflows/deploy.yml` 会自动构建并发布到 Pages。首次使用时，在仓库 Settings > Pages > Build and deployment 中选择 GitHub Actions。

## 结构

- `content/posts/`: Markdown 文章
- `src/main.ts`: 页面路由和交互
- `src/style.css`: 视觉样式
- `.github/workflows/deploy.yml`: GitHub Pages 自动部署
