/* ipad.js —— iOS 壳侧附加脚本（rewriter 在 sync-net.js 之后、内联 tab 脚本之前注入）
 * 本地优先壳的 iPad 适配，做三件事：
 *   0. 默认落在[写作]页（本地程序与工作区）；未配网关时让 [DSH] iframe 不发无效请求，
 *      配了网关则恢复同源 /app#/（对话=网关虚拟同源）；
 *   1. visualViewport resize 时让光标行保持可见（interactive-widget=resizes-content
 *      已由 rewriter 写进 viewport meta，此为 WebKit 支持不全时的兜底）；
 *   2. 点编辑区/输入框之外的空白主动 blur 收键盘，并暴露 window.__wciPadDismissKeyboard。
 * 明确不做：online 回网补推（writing.js 核心已绑 online 钩子，不重复）、
 *           分栏 pointer 交互（核心已实现，CSS touch-action 即够）、横幅/主题/手机形态。
 */
(function () {
  'use strict'
  if (window.__wciPadShell) return
  window.__wciPadShell = true

  // 未配网关时，壳文档 baseURL 是原生侧固定占位 origin（主机名 local.dsh-remote.invalid）。
  // 据此区分「离线/未配置」与「已配网关」，不必再让原生注入配置。
  var PLACEHOLDER_HOST = 'local.dsh-remote.invalid'
  function gatewayConfigured() {
    return location.hostname !== PLACEHOLDER_HOST && location.hostname !== ''
  }

  // shell.html 的 [DSH] iframe 默认写死 src="/app#/"。占位 origin 下它会解析成
  // 一个永不连通的 https://local.dsh-remote.invalid/app 请求；默认又停在[写作]页，
  // 故未配网关时把 src 撤成 about:blank（等设置页/网关就绪后再恢复）。
  function neutralizeDshFrameWhenOffline() {
    var frame = document.getElementById('dsh-frame')
    if (!frame) return
    if (gatewayConfigured()) {
      if (frame.getAttribute('src') !== '/app#/') frame.setAttribute('src', '/app#/')
    } else if (frame.getAttribute('src') !== 'about:blank') {
      frame.setAttribute('src', 'about:blank')
    }
  }

  // 默认进[写作]页。rewriter 把本脚本插在内联 tab 脚本**之前**，此时 __wcTabs 尚未定义；
  // 轮询到它出现即切（只切一次，之后显隐交还给 shell.html / writing.js 的既有逻辑）。
  function showWritingByDefault() {
    var tries = 0
    var timer = setInterval(function () {
      tries += 1
      if (window.__wcTabs && typeof window.__wcTabs.show === 'function') {
        window.__wcTabs.show('writing')
        clearInterval(timer)
      } else if (tries > 50) { // ~5s 兜底，避免异常时永久轮询
        clearInterval(timer)
      }
    }, 100)
  }

  function activeEditable() {
    var el = document.activeElement
    if (!el) return null
    var tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'SELECT') return el
    if (tag === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t !== 'button' && t !== 'submit' && t !== 'reset' &&
          t !== 'checkbox' && t !== 'radio' && t !== 'range' && t !== 'color') {
        return el
      }
      return null
    }
    if (el.isContentEditable) return el
    return null
  }

  function dismissKeyboard() {
    var el = activeEditable()
    if (el && typeof el.blur === 'function') el.blur()
  }
  window.__wciPadDismissKeyboard = dismissKeyboard

  function keepCaretVisible() {
    var el = activeEditable()
    if (!el || typeof el.scrollIntoView === 'undefined') return
    // block:'nearest' 只在被键盘遮挡时最小滚动，不把页面顶飞
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  var vv = window.visualViewport
  if (vv) {
    var pending = false
    vv.addEventListener('resize', function () {
      if (pending) return
      pending = true
      // 一帧内合并：键盘动画过程中连续 resize 只滚一次
      requestAnimationFrame(function () {
        pending = false
        keepCaretVisible()
      })
    })
    vv.addEventListener('scroll', function () {
      if (pending) return
      pending = true
      requestAnimationFrame(function () {
        pending = false
        keepCaretVisible()
      })
    })
  }

  // 点空白收键盘：命中的不是可编辑元素本身，也不在其内部，且不是分割条拖拽，
  // 也不是任何按钮/链接/开关（那些点按有自己的语义，不该顺带收键盘）
  document.addEventListener('pointerdown', function (e) {
    if (activeEditable() === null) return
    var t = e.target
    if (!(t instanceof Element)) return
    if (t.closest('input, textarea, select, [contenteditable="true"], button, a, label, .w-split-handle')) return
    dismissKeyboard()
  }, true)

  // 未配网关：尽早撤掉 [DSH] iframe 的 /app#/ 请求（本脚本在解析到尾部外链时同步执行，
  // 即便 iframe 已发起一次占位请求，改成 about:blank 也会立即中止它）。
  neutralizeDshFrameWhenOffline()
  // 默认进[写作]页（__wcTabs 由其后的内联脚本定义，故内部轮询）。
  showWritingByDefault()
})()
