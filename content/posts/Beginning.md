---
title: "Beginning"
date: "2026-10-08"
category: "技术"
description: "第一篇文章，此blog的由来"
---

水群时候有人问是怎么实现@我后在句子之后加喵~的
<img src="./Beginning_P1.jpg" style="width: 50%; max-width: 100%; height: auto;">

## 内容和代码放在一起

文章使用 Markdown 保存，正文和页面代码分开，但都可以被 Git 记录。这样每一次修改都有痕迹，迁移也不会被某个平台绑住。

```ts
const posts = import.meta.glob('../content/posts/*.md', {
  eager: true,
  query: '?raw',
})
```

这套方式很适合个人博客：图片可以放在 `public`，文章放在 `content/posts`，以后需要接 CMS 或服务器 API 时，再把数据来源换掉即可。

## 推送就是发布

GitHub Actions 负责运行构建命令，并把 `dist` 目录交给 Pages。日常写作不需要打开后台，编辑器就是后台。
