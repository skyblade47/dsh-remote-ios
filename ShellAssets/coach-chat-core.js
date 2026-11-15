'use strict'

// ============================================================================
// 创作教练 · 悬浮流式对话纯逻辑（2026-11-14）
//
// 定位：**零 DOM、零网络、可 node require、可壳页 <script>** 的 UMD 模块（同 coach-poll-core）。
// 网络与渲染在 coach-chat-net.js，这里只负责三件可单测的事：
//   ① createSseParser —— SSE 字节流半包/粘包解析（fetch ReadableStream 每次 chunk 边界随意，
//      一个事件可能跨 chunk，多个事件也可能挤在一个 chunk；事件以空行 \n\n 分隔）；
//   ② reduceMessages  —— 把服务端事件归一成「对话消息数组 + 连接态」的纯 reducer（不改入参）；
//   ③ 退避/回落策略    —— 重连退避序列、失败上限、202 重试上限，全部纯计算。
//
// 服务端 SSE 事件（见 taskkit/lib/index.js coachStreamHandler）：
//   ready / turn{phase:open|close} / delta{text} / suggestions / error，外加 ': keepalive' 注释行。
// 冷启动不回放历史（决策 5）：reducer 的初始消息只来自本地，ready 不清空已有消息。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCCoachChatCore = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  // ── 退避/重试策略常量（集中一处，便于单测钉死）──────────────────────────────
  var BACKOFF_BASE_MS = 1000      // 首次重连等 1s
  var BACKOFF_STEP_MS = 1000      // 每次翻倍的步长（1→2→4…）
  var BACKOFF_CAP_MS = 10000      // 封顶 10s
  var MAX_RECONNECT_FAILS = 6     // 连续失败 6 次回落 relay-result 轮询
  var PENDING_RETRY_CAP_MS = 60000 // 202 PENDING_SESSION 累计重试上限 60s
  var PENDING_RETRY_MS = 2000     // 202 空窗期每 2s 探一次

  /**
   * SSE 增量解析器（有状态）。feed(text) 返回本次拼出的完整事件数组：
   *   [{event:'delta', data:{...}}, {event:'keepalive'}, ...]
   * 半包：末尾没有空行的残片留在内部 buffer，下次 feed 拼接；注释行（: 开头）给 event='keepalive'。
   * 兼容 \r\n：统一按行处理。data 不是合法 JSON 时跳过该事件（不抛，防止一帧坏数据掐断整条流）。
   */
  function createSseParser() {
    var buffer = ''
    function feed(chunk) {
      if (typeof chunk !== 'string' || !chunk) return []
      // 先归一化 CRLF：事件分隔符与行尾统一成 \n，否则 \r\n\r\n 不会被 '\n\n' 命中。
      buffer += chunk.replace(/\r\n/g, '\n')
      var out = []
      var sep
      // SSE 事件以空行分隔；indexOf 逐一切出完整事件块，残片留 buffer。
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        var raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        var ev = parseBlock(raw)
        if (ev) out.push(ev)
      }
      return out
    }
    function parseBlock(raw) {
      var lines = raw.split('\n')
      var event = 'message'
      var dataLines = []
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        if (line.charAt(0) === ':') { event = 'keepalive'; continue }
        if (line.indexOf('event:') === 0) event = line.slice(6).trim()
        else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''))
      }
      if (event === 'keepalive' || dataLines.length === 0) return { event: 'keepalive' }
      var dataStr = dataLines.join('\n')
      try { return { event: event, data: JSON.parse(dataStr) } }
      catch (e) { return null } // 坏 JSON：跳过，不影响后续事件
    }
    return { feed: feed, buffered: function () { return buffer.length } }
  }

  // ── 对话消息 reducer ────────────────────────────────────────────────────────
  // 消息形态（UI 层据此渲染气泡/卡片）：
  //   {id, role:'user'|'assistant', kind:'text'|'suggestions', text, items?, streaming, failed}
  // state 形态：
  //   {status:'idle'|'connecting'|'streaming'|'error'|'fallback',
  //    messages:[...], sessionId, fails, pendingMs, lastError}
  function initialState() {
    return { status: 'idle', messages: [], sessionId: '', fails: 0, pendingMs: 0, lastError: '' }
  }

  // 追加一条 assistant 文本消息（streaming=true 表示后续还有 delta）。
  function pushAssistantText(state) {
    var msg = { id: 'a-' + (state.messages.length + 1) + '-' + Date.now(), role: 'assistant',
      kind: 'text', text: '', streaming: true, failed: false }
    state.messages.push(msg)
    return msg
  }

  function lastStreamingAssistant(state) {
    for (var i = state.messages.length - 1; i >= 0; i--) {
      var m = state.messages[i]
      if (m.role === 'assistant' && m.kind === 'text' && m.streaming) return m
    }
    return null
  }

  /**
   * 纯 reducer：返回新 state（浅拷贝 + 新 messages 数组），绝不就地改入参。
   * action 类型对齐计划 §5.2：CONNECTED/TURN_OPEN/TURN_CLOSE/DELTA/SUGGESTIONS/
   *   USER_ENQUEUE/DONE/ERROR/RESET/CARD_APPLY/CARD_SKIP。
   */
  function reduceMessages(prev, action) {
    var state = {
      status: prev.status, messages: prev.messages.slice(), sessionId: prev.sessionId,
      fails: prev.fails, pendingMs: prev.pendingMs, lastError: prev.lastError || ''
    }
    switch (action.type) {
      case 'CONNECTED':
        state.status = 'idle'
        state.fails = 0
        state.pendingMs = 0
        if (action.sessionId) state.sessionId = action.sessionId
        break
      case 'USER_ENQUEUE': {
        // 用户消息立即上屏；同时开一个空的 assistant 占位气泡承接流式回复。
        state.messages.push({ id: 'u-' + (state.messages.length + 1) + '-' + Date.now(),
          role: 'user', kind: 'text', text: String(action.text || ''), streaming: false, failed: false })
        pushAssistantText(state)
        state.status = 'connecting'
        break
      }
      case 'TURN_OPEN':
        state.status = 'streaming'
        if (!lastStreamingAssistant(state)) pushAssistantText(state)
        break
      case 'DELTA': {
        var m = lastStreamingAssistant(state)
        if (!m) m = pushAssistantText(state) // 没等到 turn/open 也能承接（事件丢失容错）
        m.text += String(action.text || '')
        state.status = 'streaming'
        break
      }
      case 'TURN_CLOSE':
        state.status = 'idle'
        var close = lastStreamingAssistant(state)
        if (close) close.streaming = false
        // abandoned（模型放弃本轮）且一个字没吐：把占位气泡标失败，避免留个空泡
        if (close && !close.text && action.outcome === 'abandoned') { close.failed = true; close.streaming = false }
        break
      case 'SUGGESTIONS':
        // 结构化建议以独立卡片消息入流（对话取代台账的主路径，卡片自带 apply/skip）。
        state.messages.push({ id: 's-' + (state.messages.length + 1) + '-' + Date.now(),
          role: 'assistant', kind: 'suggestions', text: '', items: Array.isArray(action.items) ? action.items : [],
          streaming: false, failed: false })
        break
      case 'DONE':
        state.status = 'idle'
        state.messages.forEach(function (x) { x.streaming = false })
        break
      case 'ERROR':
        state.status = 'error'
        state.lastError = String(action.error || '未知错误')
        state.messages.forEach(function (x) { x.streaming = false })
        break
      case 'FALLBACK':
        state.status = 'fallback' // 重连耗尽，UI 提示并回落 relay-result 轮询
        state.messages.forEach(function (x) { x.streaming = false })
        break
      case 'RESET':
        return initialState()
      case 'CARD_SKIP': {
        // 从建议卡片里剔除一条（纯函数 skipItem 的 reducer 版，作用于嵌套 items）。
        state.messages = state.messages.map(function (msg) {
          if (msg.id !== action.cardId || msg.kind !== 'suggestions') return msg
          var copy = Object.assign({}, msg)
          copy.items = msg.items.filter(function (it) { return it.id !== action.itemId })
          return copy
        })
        break
      }
      case 'CARD_APPLY':
        // 应用副作用由 net 层执行；reducer 只负责把该条标成已应用/失败，驱动按钮态。
        state.messages = state.messages.map(function (msg) {
          if (msg.id !== action.cardId || msg.kind !== 'suggestions') return msg
          var copy = Object.assign({}, msg)
          copy.items = msg.items.map(function (it) {
            if (it.id !== action.itemId) return it
            var n = Object.assign({}, it)
            if (action.ok) n.applied = true
            else n.failed = action.error || '应用失败'
            return n
          })
          return copy
        })
        break
      default:
        break
    }
    return state
  }

  // ── 退避/回落纯计算 ─────────────────────────────────────────────────────────
  /** 第 n 次（从 0 起）重连等待毫秒：min(BASE·2^n, CAP)。非法 n 按 0 处理。 */
  function backoffMs(fails) {
    var n = Math.max(0, Math.floor(Number(fails) || 0))
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, n), BACKOFF_CAP_MS)
  }
  /** 连续失败是否已到回落轮询的上限。 */
  function shouldFallback(fails) {
    return (Number(fails) || 0) >= MAX_RECONNECT_FAILS
  }
  /**
   * 202 PENDING_SESSION 空窗：累计已等 + 本次间隔是否超限。
   * 返回 {retry:boolean, nextPendingMs:number}。
   */
  function pendingRetry(pendingMs) {
    var acc = Number(pendingMs) || 0
    var next = acc + PENDING_RETRY_MS
    return { retry: next <= PENDING_RETRY_CAP_MS, nextPendingMs: next }
  }

  return {
    createSseParser: createSseParser,
    initialState: initialState,
    reduceMessages: reduceMessages,
    backoffMs: backoffMs,
    shouldFallback: shouldFallback,
    pendingRetry: pendingRetry,
    BACKOFF_BASE_MS: BACKOFF_BASE_MS,
    BACKOFF_CAP_MS: BACKOFF_CAP_MS,
    MAX_RECONNECT_FAILS: MAX_RECONNECT_FAILS,
    PENDING_RETRY_CAP_MS: PENDING_RETRY_CAP_MS,
    PENDING_RETRY_MS: PENDING_RETRY_MS,
  }
})
