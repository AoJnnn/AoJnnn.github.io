# 「番剧筛选」子页面 · 设计与实现规范

> 给实现者：本文是自包含的。你不需要了解这个项目的历史，照着做即可对齐现有风格。
> 有任何与本文冲突的既有代码，**以仓库现状为准**，因为 `src/style.css` 和 `src/main.ts` 仍在被改动。

---

## 1. 项目背景

静态个人博客，部署在 GitHub Pages：

- **技术栈**：Vite + TypeScript，**无前端框架**
- **路由**：手写 hash 路由（`#/archive`、`#/music`、`#/post/slug` …），全部逻辑集中在 `src/main.ts`
- **页面渲染**：函数拼接 HTML 字符串 → 塞进 `#app` 的 `innerHTML`
- **依赖**：只有 `marked`（Markdown）和 `highlight.js`（代码高亮）
- **线上**：<https://aojnnn.github.io/>

**本次任务**：新增一个「番剧筛选」子页面，让访客可以按条件筛选一个约 2.6 万条的 Bangumi 动画数据集。

---

## 2. 必须先读的文件

动手前请先看这几个文件，理解现有写法：

| 文件 | 看什么 |
|---|---|
| `src/main.ts` | `shell()`、`route()`、`archive()`、`postCard()` —— 页面怎么写、路由怎么接 |
| `src/style.css` | 设计令牌（`:root`）、`.page-intro`、`.chip`、`.archive-tools` 等组件 |
| `src/music.ts` | **推荐参照**：一个独立功能模块怎么拆出去、怎么管状态、怎么做移动端适配 |
| `src/music.css` | 页面级样式怎么写、断点怎么用 |

---

## 3. 视觉设计语言（必须统一）

### 3.1 色板

只允许用这些变量，不要引入新色值：

```css
--ink:        #25231f;   /* 正文墨色 */
--muted:      #817c72;   /* 次要文字 */
--paper:      #f5f2ea;   /* 纸张底色 */
--line:       #d9d3c7;   /* 分隔线、边框 */
--red:        #c34d35;   /* 强调色：标题、链接、hover */
--blue:       #315c6b;   /* 次强调：当前项、可点击信息 */
--anime-cyan: #4f9ca8;   /* 点缀：左边线、小标记 */
--serif:      Georgia, 'Noto Serif SC', serif;
--sans:       'Trebuchet MS', 'Microsoft YaHei', sans-serif;
```

配色性格：**米色纸张 + 朱红 + 青灰**，克制的日系排版。不要用纯白背景、不要用高饱和色块、不要用阴影堆叠。

### 3.2 排版

| 元素 | 规范 |
|---|---|
| 页面大标题 `h1` | `var(--serif)`，桌面 64px，移动端 50px，`font-weight: 400` |
| 小标签 `.eyebrow` | 11px，`letter-spacing: .2em`，全大写拉丁文，`color: var(--red)` |
| 列表项标题 | `var(--serif)`，15–18px |
| 正文 / 辅助文字 | `var(--sans)`，12–14px |
| 数字（评分、年份） | `font-variant-numeric: tabular-nums` |

### 3.3 页面骨架（所有页面都长这样）

```html
<main class="anime-page">
  <section class="page-intro">
    <span class="eyebrow">ANIME INDEX</span>
    <h1>番剧</h1>
    <p>一句话说明这里能干什么。</p>
  </section>

  <!-- 工具栏 -->

  <!-- 内容区 -->
</main>
```

`.page-intro` 自带下边框和间距（`padding-bottom: 45px; margin-bottom: 35px`），**不要自己再画一条线**。

页面外边距用：`padding: 72px 0 110px`（与归档页、工具页一致）。

---

## 4. 可复用的现成组件

**直接复用，不要重写。** 都已在 `src/style.css` 中全局可用：

| 类名 | 用途 | 说明 |
|---|---|---|
| `.page-intro` | 页面头部 | 配 `.eyebrow` + `h1` + `p` |
| `.chip` | 筛选按钮 | 已带 hover / `.is-on` 选中态 / 键盘焦点样式 |
| `.button` | 主要操作按钮 | 描边红底风格 |
| `.text-link` | 文字链接 | 红色，13px |
| `.tag` | 分类小标签 | 前面自动带 `✦` |
| `.post-card` | 卡片 | 归档页在用 |
| `.ml-row` | 紧凑列表行 | 音乐页在用，网格布局：序号 / 缩略图 / 文字 / 右侧元信息 |

### 一个值得参照的布局：归档页右侧固定工具栏

归档页（`archive()`）的做法，番剧页可以沿用：

```css
.archive-tools {
  position: fixed;
  right: 10px;
  top: 38%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  width: 54px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(245, 242, 234, .94);
  box-shadow: 0 8px 24px rgba(37, 35, 31, .08);
}
```

竖排的窄 chip（42px 宽）+ 视图切换按钮。**移动端要隐藏这个固定栏**，改成折叠面板。

---

## 5. 页面结构建议

### 5.1 桌面布局

```
┌────────────────────────────────────────────────┐
│ ANIME INDEX                                    │
│ 番剧                                            │
│ 说明文字                          [右侧固定栏] │
├────────────────────────────────────────────────┤
│ [搜索框]  [排序 ▾]  [视图 ▾]      [分类 chip]  │
├────────────────────────────────────────────────┤
│ 共 9,232 部 · 已筛选 342 部                     │
├────────────────────────────────────────────────┤
│ 列表行 / 卡片网格                               │
│ …                                               │
│ [加载更多]                                      │
└────────────────────────────────────────────────┘
```

### 5.2 移动端

- 固定右侧栏 → 隐藏
- 筛选条件 → 收进一个可展开的 `<details>` 或抽屉
- 列表行 → 单列，标题可换行，评分右对齐

断点沿用现有：`980px`（大改布局）、`760px`、`720px`（全局小屏）。

---

## 6. 功能规格

### 6.1 筛选条件（MVP）

| 控件 | 行为 |
|---|---|
| 关键词搜索 | 匹配中文名、原名、标签；输入防抖 200ms |
| 类型 | TV / OVA / 剧场版 / 其他（对应 `platform`） |
| 年份 | 起始年 ~ 结束年（双向滑块或两个下拉） |
| 评分 | 最低分（7.0 / 7.5 / 8.0 / 8.5 / 9.0 快捷 chip） |
| 标签 | 多选，取数据里出现频率最高的 20~30 个 |
| 只看有排名的 | 开关，默认**开**（原因见 §7.2） |
| 显示 R18 | 开关，默认**关** |

### 6.2 排序

评分 ↓ / 排名 ↑（数字小=好）/ 首播年份 ↓ / 集数 ↓。默认：排名 ↑（且有排名的排前面）。

### 6.3 状态与反馈

- 顶部显示「共 N 部，当前筛选出 M 部」
- 无结果：`<p class="anime-empty">没有符合条件的番剧，试试放宽筛选。</p>`（`.anime-empty` 用 `color: var(--muted); font-size: 13px; padding: 28px 0`）
- 加载中：骨架或「正在读取…」文字，**不要放转圈 spinner**（与全站风格不符）
- 筛选后回到列表顶部

### 6.4 渲染策略（2.6 万条不能一次全渲染）

二选一，**优先第二个**：

1. 分页：每页 60 条 + 上一页/下一页
2. 「加载更多」：初始 60 条，每次追加 60 条

禁止：一次性把 2.6 万个 DOM 节点塞进页面。

---

## 7. 数据

### 7.1 数据来源

`G:\AnimenData\output.xlsx`（Bangumi 导出，单表 `Sheet1`）：

- **26,360 行数据 + 1 行表头**
- 列：`date` / `year` / `id` / `name_cn` / `len` / `fst` / `platform` / `rank` / `score` / `series` / `tags` / `nsfw`

### 7.2 已知脏数据（**务必先清洗，否则会出丑**）

| 问题 | 现状 | 处理建议 |
|---|---|---|
| `fst` 列 | **全部是 `#REF!`**（Excel 公式错误） | 整列丢弃，需要首字就取 `name_cn[0]` |
| `nsfw` 列 | 表头在 L 列，**真实数据在 M 列** | 按实际数据列读 |
| `rank = 0` | 占 **65%**（17,128 条）——表示没有排名 | 排序时排到最后，或默认过滤掉 |
| `score = 0` | 占 **16.4%**（4,330 条）——未评分 | 显示为「暂无评分」，不要当 0 分参与平均 |
| `platform` | 有 `0/1/2/3/5` 和 **`2006`**（160 条） | `2006` 是脏值，归入「其他」 |
| `name_cn` | **缺 25%**（6,612 条） | 缺失时回退显示 `id` 或标签，不要显示空白 |
| `date` | 缺 8.1%，且有 `1877-01-01` 这类异常 | 年份超出 1900–2030 的当作未知 |
| `series` | 全部是「否」，无信息量 | 丢弃 |

### 7.3 数据落地方式

**不要把 2.6 万条打进 JS bundle。**

推荐：构建期生成静态 JSON，放 `public/anime/`，由前端 `fetch()` 按需加载。

```ts
// 前端加载（不要 import，避免进 bundle）
const data = await fetch('./anime/data.json').then(r => r.json())
```

生成脚本参考现有做法（`scripts/gen-feeds.mjs` 是同款风格）：

```js
// scripts/gen-anime.mjs
const slim = rows.map(r => ({
  i: r.id,                                  // 编号
  n: r.name_cn || '',                       // 中文名
  y: Number(r.year) || 0,                   // 年份
  s: Number(r.score) || 0,                  // 评分
  r: Number(r.rank) || 0,                   // 排名
  l: Number(r.len) || 0,                    // 集数
  p: platformCode(r.platform),              // 类型（0-4）
  t: r.tags.split(',').slice(0, 8),         // 标签，只留前 8 个
  d: r.date || '',
  x: r.nsfw === '是' ? 1 : 0,
}))
writeFileSync('public/anime/data.json', JSON.stringify(slim))
```

要点：

- **键名压到一个字母**，能省 30%+ 体积
- 标签只留前 6–8 个
- 空值用 `0` / `''` 而不是 `null`（JSON 更短）
- 生成物加进 `.gitignore`（参考现有 `public/updates.json` 的做法）

### 7.4 体积预算

| 项 | 目标 |
|---|---|
| `data.json` 原始 | ≤ 4 MB |
| gzip 后传输 | ≤ 1 MB |
| 首屏可交互 | ≤ 2 秒（本地千兆不算数，按移动网络估） |

**如果超过 4MB，就分片**：

```
public/anime/index.json      # 只有 {id, 名, 年, 分, 排}，约 800KB，首屏加载
public/anime/detail/aa.json  # 按首字/分片，点击详情时才取标签等长字段
```

或者只导「有排名」的 9,232 条做主列表，其余走「显示全部」开关再加载。

---

## 8. 与现有站点的接入

### 8.1 加导航项

`src/main.ts` 里 `shell()` 函数的导航数组：

```ts
([['文章', 'archive'], ['音乐', 'music'], ['工具', 'tools'], ['留言', 'guestbook'], ['动态', 'updates']] as [string, string][])
```

在末尾加一项，建议 `['番剧', 'anime']`。

> 移动端导航是可横向滚动的一行，加第 6 项不会挤爆，但请实机确认。

### 8.2 加路由

`route()` 里加一个分支：

```ts
page === 'anime' ? animePage(shell) : ...
```

### 8.3 页面标题

`shell(content, active)` 已经自动设置 `document.title = "${active} · AoJnnn / OurNotes"`，**不需要自己设**。

### 8.4 底部播放条

全站有一个固定底部播放器（`#nmp`），任意页面都可能出现。它会给 `body` 加 `.has-nmp` 并自带底部内边距。**你的页面不需要处理它**，但如果要加自己的固定底栏，必须避开它（`z-index: 60`）。

---

## 9. 无障碍与移动端要点

- 筛选按钮用 `<button type="button">`，并加 `aria-pressed`
- `.chip` 的键盘焦点样式已经写好，不要覆盖
- 触摸设备点击高亮已全局处理，新元素如自定义请加 `-webkit-tap-highlight-color: transparent`
- 输入框 `font-size` 必须 `≥16px`，否则 iOS 会自动放大页面
- 固定定位元素若贴底，记得 `env(safe-area-inset-bottom)`

---

## 10. 验收清单

提交前逐条确认：

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run build` 通过
- [ ] 桌面 1440px：布局正常，右侧工具栏不遮挡内容
- [ ] 移动 390px：无横向滚动条（`document.documentElement.scrollWidth <= innerWidth`）
- [ ] 筛选任意组合，结果数正确、清空筛选可恢复
- [ ] 空结果有提示文案
- [ ] 快速拖动筛选不会白屏或卡死
- [ ] 键盘 Tab 能走完所有筛选控件
- [ ] 首屏不加载超过 1MB 的数据
- [ ] `data.json` 已加入 `.gitignore`

---

## 11. 不要做的事

- ❌ 不要引入 UI 框架（React/Vue）、不要装组件库
- ❌ 不要引入图表库、日期库
- ❌ 不要用 Tailwind 或其他 CSS 框架
- ❌ 不要改 `style.css` 的 `:root` 色板
- ❌ 不要把数据 `import` 进 bundle
- ❌ 不要一次性渲染 2.6 万行
- ❌ 不要用 emoji 当图标（现有页面用字符符号或内联 SVG）
- ❌ 不要动 `src/music.ts`、`src/audiocache.ts` 等音乐相关模块

---

## 12. 参考：现有页面的代码风格

`main.ts` 里的函数高度压缩（单行），**但新代码请写正常格式**。推荐把整个番剧页拆成独立模块：

```
src/anime.ts      # 页面逻辑
src/anime.css     # 页面样式（在 anime.ts 里 import）
scripts/gen-anime.mjs   # 数据生成脚本
public/anime/data.json  # 生成物，不入库
```

模块对外只暴露一个入口：

```ts
export function animePage(shell: (content: string, active?: string) => void) { ... }
```

与 `src/music.ts` 的 `musicPage(shell)` 保持完全一致的形态即可。
