/**
 * 标签页小彩蛋
 *
 * - 从别的标签页切回来：标题先显示「嘟嘟噜~」，3 秒后恢复
 * - 切到别的标签页：标题显示「咕咕~」，一直挂着直到你回来
 *
 * 只依赖 visibilitychange，切标签页、切窗口、最小化都能触发。
 */

const GREETING = '嘟嘟噜~'
const AWAY = '咕咕~'
const GREETING_MS = 3000

/** 真实标题（不含彩蛋），用于恢复 */
let baseTitle = document.title
/** 当前显示的标题是不是我们改过的 */
const isOverridden = () => document.title === GREETING || document.title === AWAY

let greetingTimer: number | undefined
let isAway = false

function applyTitle(next: string) {
  // 覆盖前先把真实标题记下来，这样以后页面自己改标题也能被正确恢复
  if (!isOverridden()) baseTitle = document.title
  document.title = next
}

function restoreTitle() {
  document.title = baseTitle
}

function showGreeting() {
  window.clearTimeout(greetingTimer)
  applyTitle(GREETING)
  greetingTimer = window.setTimeout(() => {
    greetingTimer = undefined
    restoreTitle()
  }, GREETING_MS)
}

export function setupTabTitle() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      isAway = true
      window.clearTimeout(greetingTimer)
      greetingTimer = undefined
      applyTitle(AWAY)
      return
    }

    // 首次打开不打招呼，只有「真的离开过再回来」才触发
    if (!isAway) return
    isAway = false
    showGreeting()
  })
}
