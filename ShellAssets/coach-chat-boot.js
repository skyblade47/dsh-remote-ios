/* coach-chat-boot.js —— iOS 壳侧悬浮流式对话引导（自包含 IIFE，仿 ipad.js 模式）
 * 职责单一：把顶栏「💬 对话」按钮接到 coach-chat-net 暴露的 window.__wcCoachChatOpen。
 * 与 PC 的差异：iOS 没有 send-net 的 relay requestId 回填链，改用原生桥已挂牌的
 *   创作教练会话 id（wcStorage.getState().coachRole），走 sessionId 直连路径，绕开台账。
 * fail-soft：桥超时/字段全空/入口函数缺失一律静默或 alert，绝不抛未捕获异常。
 * 固定到记录板等原生能力（coachPin*）iOS 不具备，由 coach-chat-net 内部判空自行降级，本文件不处理。
 */
(function () {
  'use strict'
  if (window.__wcCoachChatBoot) return
  window.__wcCoachChatBoot = true

  // 从原生状态解析一个可用的创作教练会话：优先默认会话，其次四身份挂牌里第一个非空。
  // sid 已经原生侧 ^session-...$ 正则校验，非法回落空串；这里再兜底一次空值判断。
  function resolveCoachSessionId(state) {
    var role = state && state.coachRole
    if (!role || typeof role !== 'object') return ''
    var def = String(role.defaultSessionId || '').trim()
    if (def) return def
    var sessions = role.sessions || {}
    var keys = Object.keys(sessions)
    for (var i = 0; i < keys.length; i++) {
      var sid = String(sessions[keys[i]] || '').trim()
      if (sid) return sid
    }
    return ''
  }

  function bind() {
    var btn = document.getElementById('w-chat-open')
    if (!btn) return // 入口节点不存在（异常壳页）⇒ 不接线、不报错
    btn.addEventListener('click', function () {
      var open = window.__wcCoachChatOpen
      if (typeof open !== 'function') {
        console.error('[coach-chat-boot] __wcCoachChatOpen unavailable')
        return
      }
      var wc = window.wcStorage
      if (!wc || typeof wc.getState !== 'function') {
        alert('当前壳版本不支持悬浮流式对话，请更新应用')
        return
      }
      // 桥为异步 Promise，10s 超时会 reject；必须 catch，否则产生未捕获 Promise。
      Promise.resolve(wc.getState()).then(function (state) {
        var sid = resolveCoachSessionId(state)
        if (!sid) {
          alert('请先在设置中配置创作教练会话')
          return
        }
        open({ sessionId: sid })
      }).catch(function (err) {
        console.error('[coach-chat-boot] getState failed', err)
        alert('读取创作教练会话失败，请稍后重试')
      })
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind)
  } else {
    bind()
  }
})()
