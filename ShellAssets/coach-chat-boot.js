/* coach-chat-boot.js —— iOS 壳侧悬浮流式对话引导（自包含 IIFE，仿 ipad.js 模式）
 * 职责单一：把顶栏「💬 对话」按钮接到 coach-chat-net 暴露的 window.__wcCoachChatOpen。
 * 与 PC 的差异：iOS 没有 send-net 的 relay requestId 回填链，改用原生桥已挂牌的
 *   创作教练会话 id（wcStorage.getState().coachRole），走 sessionId 直连路径，绕开台账。
 * 自动默认会话（2026-11-18 用户拍板）：coachRole 未挂牌时**不让用户手工选取**，
 *   自动 GET /taskkit/api/sessions 拉活跃会话 → 按标题自动匹配一个创作教练会话
 *   （口径对齐服务端 resolveRoleId：先精确「创作教练」，再包含匹配；都没有则回落首个会话）
 *   → saveConfig 持久化为 coachRole.defaultSessionId → 直接打开。仅在拉取/保存失败时 alert。
 * fail-soft：桥超时/字段全空/入口函数缺失一律静默或 alert，绝不抛未捕获异常。
 * 固定到记录板等原生能力（coachPin*）iOS 不具备，由 coach-chat-net 内部判空自行降级，本文件不处理。
 */
(function () {
  'use strict'
  if (window.__wcCoachChatBoot) return
  window.__wcCoachChatBoot = true

  var SESSIONS_PATH = '/taskkit/api/sessions'
  var SESSIONS_TIMEOUT_MS = 10000

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

  /**
   * 从活跃会话列表里自动选定一个创作教练会话（无 UI、无人工干预）。
   * 匹配口径对齐服务端 taskkit resolveRoleId('coach')：
   *   ① 标题精确等于「创作教练」；
   *   ② 标题包含「创作教练」（兼容「创作教练·reader」这类身份拆分会话，取第一个）；
   *   ③ 都没有 ⇒ 回落列表第一个会话（默认先有一个对话可用，而不是堵死用户）。
   * 列表为空 ⇒ 返回 ''。
   */
  function pickDefaultSession(list) {
    if (!Array.isArray(list) || !list.length) return ''
    var fallback = ''
    var containsHit = ''
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {}
      var id = String(item.id || '').trim()
      if (!id) continue
      if (!fallback) fallback = id
      var title = String(item.title || '').trim()
      if (title === '创作教练') return id
      if (!containsHit && title.indexOf('创作教练') >= 0) containsHit = id
    }
    return containsHit || fallback
  }

  // 拉取活跃会话（自带超时，避免永久 pending）；任何异常都抛给调用方统一 alert。
  function fetchSessions() {
    var ctl = ('AbortController' in window) ? new AbortController() : null
    var timer = ctl ? setTimeout(function () { try { ctl.abort() } catch (e) { /* 已结束则忽略 */ } }, SESSIONS_TIMEOUT_MS) : null
    return fetch(SESSIONS_PATH, ctl ? { signal: ctl.signal } : undefined)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (rb) {
        if (!rb || rb.ok !== true) throw new Error((rb && rb.error) || '会话列表返回异常')
        return Array.isArray(rb.sessions) ? rb.sessions : []
      })
      .finally(function () { if (timer) clearTimeout(timer) })
  }

  // 自动绑定并持久化默认会话；成功返回 sid，失败抛错。
  function autoBindSession(wc) {
    return fetchSessions().then(function (list) {
      var sid = pickDefaultSession(list)
      if (!sid) throw new Error('EMPTY')
      // 原生侧 saveConfig 对 coachRole 做浅合并 + sessionPattern 白名单清洗，
      // 只写 defaultSessionId 不会冲掉已有的四身份挂牌。
      return Promise.resolve(wc.saveConfig({ coachRole: { defaultSessionId: sid } }))
        .then(function (res) {
          if (res && res.ok === false) throw new Error((res.error || '保存失败'))
          return sid
        })
    })
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
        // 已挂牌 ⇒ 直接打开，零额外请求。
        if (sid) return sid
        // 未挂牌 ⇒ 自动默认绑定一个会话（不弹选取器），失败才提示。
        if (typeof wc.saveConfig !== 'function') {
          alert('当前壳版本不支持自动配置创作教练会话，请更新应用')
          return ''
        }
        return autoBindSession(wc)
      }).then(function (sid) {
        if (sid) open({ sessionId: sid })
      }).catch(function (err) {
        console.error('[coach-chat-boot] 自动配置创作教练会话失败', err)
        var msg = (err && err.message === 'EMPTY')
          ? '暂无可用对话：请先在 DSH 中创建一个会话后再试'
          : '自动配置创作教练会话失败，请检查网络后重试'
        alert(msg)
      })
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind)
  } else {
    bind()
  }
})()
