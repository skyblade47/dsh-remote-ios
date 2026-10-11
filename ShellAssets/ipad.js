/* ipad.js —— iOS 壳侧附加脚本（rewriter 在 sync-net.js 之后、内联 tab 脚本之前注入）
 * 只做两件 spec §7.4 的事：
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
})()
