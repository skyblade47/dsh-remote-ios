'use strict'

// ============================================================================
// 创作教练 · 悬浮流式对话框（2026-11-14，对话职责细分 阶段D，DOM/网络接线层）
//
// 定位：纯接线层，不含判定 —— 流式解析/消息归并/退避全在 coach-chat-core.js
//   （window.WCCoachChatCore，可单测），建议应用/跳过在 coach-actions.js
//   （window.WCCoachActions，台账与对话卡片共用同一份动作）。本文件只做：
//     1) 懒建 position:fixed 悬浮框（挂 body，不进 flex 流），顶栏「对话」按钮开合；
//     2) fetch + response.body.getReader() 流式订阅 POST /taskkit/api/coach/stream
//        （SSE：ready/turn/delta/error + 25s keepalive），parser 喂 WCCoachChatCore.createSseParser；
//     3) reducer（WCCoachChatCore.reduceMessages）驱动气泡 / 建议卡片渲染；
//     4) 追问走 POST /taskkit/api/coach/prompt（同会话 agent.send 'next-turn'，不注纪律块）；
//     5) 三态码处理：202 PENDING_SESSION（pendingRetry 退避重连，上限 60s）、
//        403 SESSION_NOT_COACH（硬错误不重试）、409 SESSION_NOT_ACTIVE（退避重连）；
//        连续失败达 MAX_RECONNECT_FAILS ⇒ shouldFallback ⇒ 关闭流、回落 relay-result 轮询台账；
//     6) 「固定到记录板」：单条 AI 回复经 wcStorage.coachPinSave 落 userData/coach-pins/
//        （按文档隔离、不进工作区），右栏 coach-pins pane 渲染；
//     7) 暴露 window.__wcCoachChatOpen() 供顶栏按钮调用。
//
// 🔴 红线（悬浮流式对话实现计划 §2/§5，2026-11 用户拍板）：
//   ① 冷启动不回放历史：本文件不读任何历史消息，state.messages 每次打开从空开始；
//      仅保留重连 afterSeq 缺口补帧（断线重连带最后 revision，服务端补中间帧）；
//   ② 思考链默认隐藏：reducer 只消费 text-delta（core 已过滤 reasoning/tool-call/usage），
//      本层不解析、不渲染任何 reasoning 内容；
//   ③ 绝不自动改正文：建议卡片只给「应用 / 跳过」，写回只能用户手动点，且复用
//      WCCoachActions（与台账同一份 setText/flush/兄弟重判逻辑）；
//   ④ fail-soft：WCCoachChatCore / WCCoachActions / 任一依赖缺失 ⇒ 不抛到全局，
//      按钮提示不可用并 return，不白屏、不影响既有发送与台账路径。
//
// 会话接入（无独立建会话通道）：
//   首轮必须有会话 id，来源两条 ——（a）用户刚经 relay 发送，send-net 回程把 requestId
//   存到 window.__wcCoachChatRequestId；（b）右栏台账「对话」动作回填。stream 路由
//   带 requestId 时服务端经台账解析 coachSessionId；202 说明台账尚未落会话 ⇒ 退避重连。
// ============================================================================

;(function () {
  'use strict'

  var Core = window.WCCoachChatCore
  var Actions = window.WCCoachActions
  // 依赖缺失不抛全局：记录后在入口处 fail-soft 提示（保持与 coach-net/toolbar 同一纪律）。
  if (!Core) { console.error('[wc-chat] coach-chat-core.js 未加载（window.WCCoachChatCore 缺失）') }

  var STREAM_PATH = '/taskkit/api/coach/stream'
  var PROMPT_PATH = '/taskkit/api/coach/prompt'

  // ── 运行态（模块级单例；悬浮框全局唯一，不随文档切换重建 DOM，只换数据上下文）──────
  var chatEl = null          // 悬浮框根 div.wc-chat
  var state = Core ? Core.initialState() : { status: 'idle', messages: [], sessionId: '', fails: 0, pendingMs: 0, lastError: '' }
  var parser = Core ? Core.createSseParser() : null
  var abortCtl = null        // 在途 fetch 的 AbortController（主动关闭/重连时 abort）
  var reconnectTimer = 0     // 重连/待会话定时器（0 = 无挂起）
  var reader = null          // 在途 body reader（关闭时 cancel）
  var closed = false         // 用户是否主动关闭（关闭后不自动重连）
  var currentRequestId = ''  // 当前订阅锚定的 relay requestId（服务端据此从台账解析会话）
  var lastTurn = 0           // 已收帧最大 turn 号（重连后用于判断是否新一轮；服务端 fanout 透传 turn）
  var pinToken = 0           // 固定 pane 重载自增令牌（防旧异步覆盖新结果）

  function storage() { return window.wcStorage || null }
  function proofBridge() { return window.__wcProofBridge || null }
  function sendBridge() { return window.__wcSendBridge || null }

  function say(text, isError) {
    var b = proofBridge()
    if (b && b.notice) b.notice(text, isError)
    else if (isError) console.error('[wc-chat] ' + text)
  }

  function clearTimers() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0 }
  }

  // ── 悬浮框 DOM（懒创建，挂 body 末尾，position:fixed）──────────────────────────
  function ensureChat() {
    if (chatEl) return chatEl
    chatEl = document.createElement('div')
    chatEl.className = 'wc-chat'
    chatEl.hidden = true
    // mousedown 阻止默认：点框内（尤其按钮/输入框）不让背后写作区失焦丢选区。
    chatEl.addEventListener('mousedown', function (e) { e.preventDefault() })

    var head = document.createElement('div')
    head.className = 'wc-chat-head'
    var title = document.createElement('span')
    title.className = 'wc-chat-title'
    title.textContent = '创作教练 · 对话'
    var closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'wc-chat-close'
    closeBtn.textContent = '✕'
    closeBtn.title = '关闭对话框（不中断后台会话）'
    closeBtn.addEventListener('click', function () { hideChat() })
    head.appendChild(title)
    head.appendChild(closeBtn)

    var scroll = document.createElement('div')
    scroll.className = 'wc-chat-scroll'

    // 输入区：textarea + 发送钮；Enter 发送、Shift+Enter 换行（Electron 无 prompt，同 toolbar 范式）。
    var inputRow = document.createElement('div')
    inputRow.className = 'wc-chat-input-row'
    var ta = document.createElement('textarea')
    ta.className = 'wc-chat-input'
    ta.rows = 2
    ta.placeholder = '继续追问…（Enter 发送，Shift+Enter 换行）'
    var sendBtn = document.createElement('button')
    sendBtn.type = 'button'
    sendBtn.className = 'wc-chat-send'
    sendBtn.textContent = '发送'
    sendBtn.addEventListener('click', function () { submitPrompt() })
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPrompt() }
    })
    inputRow.appendChild(ta)
    inputRow.appendChild(sendBtn)

    var statusLine = document.createElement('div')
    statusLine.className = 'wc-chat-status'

    chatEl.appendChild(head)
    chatEl.appendChild(scroll)
    chatEl.appendChild(statusLine)
    chatEl.appendChild(inputRow)
    document.body.appendChild(chatEl)
    return chatEl
  }

  function scrollBox() { return ensureChat().querySelector('.wc-chat-scroll') }
  function statusBox() { return ensureChat().querySelector('.wc-chat-status') }
  function inputBox() { return ensureChat().querySelector('.wc-chat-input') }

  // ── 渲染：全量重画消息（消息量小，重画简单可靠；滚动位置锚定底部）──────────────────
  function render() {
    var box = scrollBox()
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    while (box.firstChild) box.removeChild(box.firstChild)

    state.messages.forEach(function (m) {
      if (m.kind === 'suggestions') { box.appendChild(renderSuggestionCard(m)); return }
      box.appendChild(renderBubble(m))
    })

    var st = statusBox()
    st.textContent = statusText()
    st.classList.toggle('is-error', state.status === 'error' || state.status === 'fallback')
    if (atBottom) box.scrollTop = box.scrollHeight
  }

  function statusText() {
    switch (state.status) {
      case 'connecting': return '连接中…'
      case 'streaming': return '教练回复中…'
      case 'reconnecting': return '连接中断，重连中（第 ' + state.fails + ' 次）…'
      case 'pending': return '等待会话就绪…'
      case 'fallback': return '流式连接多次失败，已回落到右栏建议清单'
      case 'error': return state.lastError || '连接出错'
      case 'idle': return state.sessionId ? '会话进行中' : ''
      default: return ''
    }
  }

  function renderBubble(m) {
    var wrap = document.createElement('div')
    wrap.className = 'wc-chat-msg is-' + m.role + (m.failed ? ' is-failed' : '')
    var bubble = document.createElement('div')
    bubble.className = 'wc-chat-bubble'
    bubble.textContent = m.text || (m.streaming ? '…' : '')
    wrap.appendChild(bubble)

    // AI 文本气泡：流式中不显示「固定」；完成后给固定钮 + 重开对话锚点。
    if (m.role === 'assistant' && m.kind === 'text' && !m.streaming && m.text) {
      var actions = document.createElement('div')
      actions.className = 'wc-chat-msg-actions'
      var pin = document.createElement('button')
      pin.type = 'button'
      pin.className = 'wc-chat-pin'
      pin.textContent = '固定到记录板'
      pin.addEventListener('click', function () { pinMessage(m) })
      actions.appendChild(pin)
      wrap.appendChild(actions)
    }
    return wrap
  }

  function renderSuggestionCard(m) {
    var wrap = document.createElement('div')
    wrap.className = 'wc-chat-card'
    var head = document.createElement('div')
    head.className = 'wc-chat-card-head'
    head.textContent = '结构化建议（' + (m.items ? m.items.length : 0) + ' 条）'
    wrap.appendChild(head)

    var list = document.createElement('div')
    list.className = 'wc-chat-card-list'
    ;(m.items || []).forEach(function (it) {
      var card = document.createElement('div')
      card.className = 'wc-chat-card-item' + (it.applied ? ' is-applied' : '') + (it.failed ? ' is-failed' : '')
      var body = document.createElement('div')
      body.className = 'wc-chat-card-body'
      var title = document.createElement('div')
      title.className = 'wc-chat-card-title'
      title.textContent = (it.title || it.ruleId || '建议') + (it.applied ? '（已应用）' : (it.failed ? '（定位失败）' : ''))
      var reason = document.createElement('div')
      reason.className = 'wc-chat-card-reason'
      reason.textContent = it.reason || it.explanation || ''
      var sug = document.createElement('div')
      sug.className = 'wc-chat-card-sug'
      sug.textContent = it.suggestion || it.replacement || ''
      body.appendChild(title)
      if (reason.textContent) body.appendChild(reason)
      if (sug.textContent) body.appendChild(sug)
      card.appendChild(body)

      if (!it.applied) {
        var btns = document.createElement('div')
        btns.className = 'wc-chat-card-btns'
        var apply = document.createElement('button')
        apply.type = 'button'
        apply.className = 'wc-chat-card-apply'
        apply.textContent = '应用'
        apply.disabled = !!it.failed
        apply.addEventListener('click', function () { applyCardItem(m, it) })
        var skip = document.createElement('button')
        skip.type = 'button'
        skip.className = 'wc-chat-card-skip'
        skip.textContent = '跳过'
        skip.addEventListener('click', function () { skipCardItem(m, it) })
        btns.appendChild(apply)
        btns.appendChild(skip)
        card.appendChild(btns)
      }
      list.appendChild(card)
    })
    wrap.appendChild(list)
    return wrap
  }

  function dispatch(action) {
    if (!Core) return
    state = Core.reduceMessages(state, action)
    render()
  }

  // ── 建议卡片动作：复用 WCCoachActions（与台账同一份应用/跳过）────────────────────
  function applyCardItem(cardMsg, item) {
    if (!Actions || !Actions.applySuggestion) { say('建议应用模块未加载', true); return }
    var b = proofBridge()
    var Proof = window.WCProofread || null
    if (!b || !Proof) { say('校对桥未就绪，无法应用', true); return }
    Actions.applySuggestion({
      Proof: Proof,
      bridge: b,
      item: item,
      siblings: cardMsg.items || [],
    }).then(function (r) {
      if (!r.ok) {
        dispatch({ type: 'CARD_APPLY', cardId: cardMsg.id, itemId: item.id, ok: false, error: r.error || '应用失败' })
        say(r.error || '应用失败', true)
        return
      }
      dispatch({ type: 'CARD_APPLY', cardId: cardMsg.id, itemId: item.id, ok: true })
      if (r.changed) say('已应用 1 条修改（其余内容未动）')
    }).catch(function (e) {
      dispatch({ type: 'CARD_APPLY', cardId: cardMsg.id, itemId: item.id, ok: false, error: ((e && e.message) || '应用失败') })
      say('应用失败：' + ((e && e.message) || e), true)
    })
  }

  function skipCardItem(cardMsg, item) {
    if (!Actions || !Actions.skipItem) return
    Actions.skipItem(cardMsg.items || [], item.id)
    // reducer 的 CARD_SKIP 作用于嵌套 items（cardId 定位卡片，itemId 定位条目）。
    dispatch({ type: 'CARD_SKIP', cardId: cardMsg.id, itemId: item.id })
    say('已跳过该建议')
  }

  // ── 固定到记录板（userData/coach-pins，按文档隔离，不进工作区）───────────────────
  function currentRelPath() {
    // 两桥都暴露 context() ⇒ {docName, workName, relPath}；无当前文档返回 null。
    var b = proofBridge() || sendBridge()
    var ctx = b && b.context ? b.context() : null
    return ctx && ctx.relPath ? String(ctx.relPath) : ''
  }

  async function pinMessage(m) {
    var wc = storage()
    if (!wc || !wc.coachPinSave) { say('当前版本不支持固定（存储接口缺失）', true); return }
    var relPath = currentRelPath()
    if (!relPath) { say('未打开文档，无法按文档固定', true); return }
    var pin = {
      id: 'pin-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      relPath: relPath,
      role: m.role,
      text: m.text,
      sessionId: state.sessionId || '',
      pinnedAt: Date.now(),
    }
    try {
      var r = await wc.coachPinSave(pin)
      if (!r || !r.ok) throw new Error((r && r.error) || '固定失败')
      say('已固定到右侧记录板')
      reloadPins()
    } catch (e) {
      say('固定失败：' + ((e && e.message) || e), true)
    }
  }

  // ── 右栏 coach-pins pane 渲染（数据来自 wcStorage.coachPinLoad）─────────────────
  async function reloadPins() {
    var wc = storage()
    var pane = document.getElementById('w-board-coach-pins')
    if (!pane) return
    var myToken = ++pinToken
    if (!wc || !wc.coachPinLoad) {
      pane.textContent = '当前版本不支持固定（存储接口缺失）'
      return
    }
    var relPath = currentRelPath()
    if (!relPath) { pane.textContent = '先打开一篇文档' ; return }
    try {
      var r = await wc.coachPinLoad(relPath)
      if (myToken !== pinToken) return // 切文档/重复触发：旧结果作废，防覆盖
      var pins = (r && r.ok && Array.isArray(r.pins)) ? r.pins : []
      renderPinPane(pane, pins)
    } catch (e) {
      if (myToken === pinToken) pane.textContent = '固定内容读取失败：' + ((e && e.message) || e)
    }
  }

  function renderPinPane(pane, pins) {
    while (pane.firstChild) pane.removeChild(pane.firstChild)
    if (!pins.length) {
      var empty = document.createElement('div')
      empty.className = 'wc-pins-empty'
      empty.textContent = '还没有固定内容。在悬浮对话里点 AI 回复下方的「固定到记录板」。'
      pane.appendChild(empty)
      return
    }
    pins.forEach(function (p) {
      var card = document.createElement('div')
      card.className = 'wc-pins-item'
      var text = document.createElement('div')
      text.className = 'wc-pins-text'
      text.textContent = p.text || ''
      var meta = document.createElement('div')
      meta.className = 'wc-pins-meta'
      var d = new Date(p.pinnedAt || Date.now())
      meta.textContent = d.toLocaleString() + (p.sessionId ? ' · 会话 ' + p.sessionId.slice(-6) : '')
      card.appendChild(text)
      card.appendChild(meta)
      pane.appendChild(card)
    })
  }

  // ── 流式订阅（fetch + getReader + SSE parser）────────────────────────────────
  function connect() {
    if (!Core || !parser) { say('对话核心模块未加载', true); return }
    if (abortCtl) return // 已有在途连接，不重复发起
    closed = false
    dispatch({ type: 'CONNECTED' }) // 进入 connecting 态（具体状态由后续帧/错误再收敛）
    state.status = 'connecting'
    render()

    abortCtl = new AbortController()
    var payload = { requestId: currentRequestId || undefined }
    if (state.sessionId && /^session-[\w-]+$/.test(state.sessionId)) payload.sessionId = state.sessionId
    // 注：服务端 stream 路由按 requestId/sessionId 解析目标会话，不消费 afterSeq；
    // 冷启动不回放历史（决策 5），重连只续收之后的新帧，turn 号仅本地记账。

    fetch(STREAM_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abortCtl.signal,
    }).then(function (res) {
      // 三态码先于流处理：202/403/409 各走各的分支，不进 reader。
      if (res.status === 202) { teardownReader(); handlePending(); return null }
      if (res.status === 403) { teardownReader(); handleHardError(403, '当前会话不是创作教练会话，无法流式订阅'); return null }
      if (res.status === 409) { teardownReader(); handleReconnectable(409, '会话尚未激活，稍后重连'); return null }
      if (!res.ok || !res.body) { teardownReader(); handleReconnectable(res.status, '流式连接失败（HTTP ' + res.status + '）'); return null }
      state.fails = 0
      return pump(res)
    }).catch(function (e) {
      teardownReader()
      if (abortCtl && abortCtl.signal.aborted) return // 主动关闭/重连触发的 abort 不算失败
      handleReconnectable(0, '网络中断：' + ((e && e.message) || e))
    })
  }

  // 逐块读取并喂 parser；每个完整 SSE 事件交给 handleEvent。
  async function pump(res) {
    var decoder = new TextDecoder('utf-8')
    reader = res.body.getReader()
    try {
      for (;;) {
        var chunk = await reader.read()
        if (chunk.done) break
        var events = parser.feed(decoder.decode(chunk.value, { stream: true }))
        events.forEach(handleEvent)
      }
      // 服务端正常结束流：按可重连处理（内核侧会话仍在，重连可继续收后续 turn）。
      teardownReader()
      if (!closed) handleReconnectable(0, '流式连接已结束，尝试重连')
    } catch (e) {
      teardownReader()
      if (abortCtl && abortCtl.signal.aborted) return
      handleReconnectable(0, '读流出错：' + ((e && e.message) || e))
    }
  }

  function teardownReader() {
    if (reader) { try { reader.cancel() } catch (e) { /* 忽略 cancel 异常 */ } reader = null }
    if (abortCtl) { abortCtl = null }
  }

  function handleEvent(ev) {
    if (!ev || !ev.event) return
    var data = ev.data || {}
    if (ev.event === 'ready') {
      if (data.sessionId) state.sessionId = data.sessionId
      state.status = 'idle'
      state.fails = 0
      state.lastError = ''
      state.pendingMs = 0
      render()
      return
    }
    if (ev.event === 'turn') {
      // 开合由流帧推导（内核无全局 turn 事件）：open 建占位泡，close 收口并带 outcome。
      if (data.phase === 'open') {
        if (typeof data.turn === 'number') lastTurn = Math.max(lastTurn, data.turn)
        dispatch({ type: 'TURN_OPEN' })
      } else if (data.phase === 'close') {
        if (typeof data.turn === 'number') lastTurn = Math.max(lastTurn, data.turn)
        dispatch({ type: 'TURN_CLOSE', outcome: data.outcome })
      }
      return
    }
    if (ev.event === 'delta') {
      if (typeof data.turn === 'number') lastTurn = Math.max(lastTurn, data.turn)
      dispatch({ type: 'DELTA', text: data.text || '' })
      return
    }
    // 注：结构化建议（coachSuggestions）不经 SSE 下发——服务端 fanout 只透传文本帧，
    // 建议清单仍走既有 relay-result 轮询进右栏台账（决策 3 的兜底路径），故此处无 suggestions 分支。
    if (ev.event === 'error') {
      handleHardError(0, data.error || '服务端报告流式错误')
    }
  }

  // ── 202：会话尚未就绪（台账还没落到 coachSessionId）⇒ pendingRetry 退避，封顶 60s ──
  function handlePending() {
    var pr = Core.pendingRetry(state.pendingMs)
    // 累计等待超 60s 仍无会话：不再空转，回落台账，避免无限重连。
    if (!pr.retry) { fallbackToLedger('等待会话就绪超时（60s）'); return }
    state.pendingMs = pr.nextPendingMs
    state.status = 'pending'
    render()
    if (closed) return
    reconnectTimer = setTimeout(function () { reconnectTimer = 0; connect() }, Core.PENDING_RETRY_MS)
  }

  // 可恢复错误：指数退避（1/2/4… 封顶 10s），达 6 次 ⇒ 回落台账轮询。
  function handleReconnectable(code, message) {
    state.fails += 1
    if (Core.shouldFallback(state.fails)) {
      fallbackToLedger(message)
      return
    }
    state.status = 'reconnecting'
    state.lastError = message
    render()
    if (closed) return
    var delay = Core.backoffMs(state.fails - 1)
    reconnectTimer = setTimeout(function () { reconnectTimer = 0; connect() }, delay)
  }

  // 硬错误（403 脏会话 / 服务端 error 帧）：不重试，提示并停止自动重连。
  function handleHardError(code, message) {
    state.fails = 0
    state.status = 'error'
    state.lastError = message
    render()
    say(message, true)
  }

  // 回落：关流、标记 fallback，调起右栏台账（既有 relay-result 轮询路径），不白屏。
  function fallbackToLedger(message) {
    clearTimers()
    teardownReader()
    state.status = 'fallback'
    state.lastError = message
    render()
    say('流式对话暂不可用，已为你切到右栏建议清单', true)
    try {
      var b = sendBridge()
      if (b && b.coachResult && currentRequestId) b.coachResult(currentRequestId)
    } catch (e) { /* 回落失败不抛 */ }
  }

  // ── 追问：POST /coach/prompt（同会话 next-turn，不注纪律块）────────────────────
  async function submitPrompt() {
    var ta = inputBox()
    var text = String(ta.value || '').trim()
    if (!text) { ta.focus(); return }
    if (!state.sessionId) { say('会话尚未就绪，请稍候再追问', true); return }
    var sendBtn = ensureChat().querySelector('.wc-chat-send')
    sendBtn.disabled = true
    // 先上屏用户气泡 + 空 assistant 占位（reducer USER_ENQUEUE）。
    dispatch({ type: 'USER_ENQUEUE', text: text })
    ta.value = ''
    try {
      var res = await fetch(PROMPT_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId, text: text }),
      })
      var body = await readJson(res)
      if (!res.ok || !body.ok) {
        var code = body.code || ('HTTP_' + res.status)
        if (res.status === 403 || code === 'BAD_SESSION_ID') { handleHardError(403, body.error || '会话 id 非法，无法追问'); return }
        if (res.status === 409) { handleReconnectable(409, body.error || '会话未激活，稍后重连'); return }
        throw new Error(body.error || ('追问失败（HTTP ' + res.status + '）'))
      }
      state.sessionId = body.sessionId || state.sessionId
      state.status = 'streaming'
      render()
      if (!abortCtl && !reconnectTimer) connect()
    } catch (e) {
      state.status = 'error'
      state.lastError = (e && e.message) || '追问失败'
      render()
      say(state.lastError, true)
    } finally {
      sendBtn.disabled = false
    }
  }

  function readJson(res) {
    return res.text().then(function (t) {
      try { return JSON.parse(t) } catch (e) { return {} }
    })
  }

  // ── 开合入口 ────────────────────────────────────────────────────────────────
  function showChat() {
    if (!Core) { say('悬浮对话模块未加载（WCCoachChatCore 缺失）', true); return }
    var el = ensureChat()
    el.hidden = false
    // 锚定当前 relay requestId（send-net 回程写入）；无则提示先发送一次诉求。
    if (!currentRequestId && window.__wcCoachChatRequestId) {
      currentRequestId = window.__wcCoachChatRequestId
    }
    if (!currentRequestId && !state.sessionId) {
      state.status = 'idle'
      render()
      statusBox().textContent = '请先在「发送给任务中心」发出一条诉求，再打开对话'
      return
    }
    reloadPins()
    if (!abortCtl && !reconnectTimer && !closed) connect()
    else if (closed) { closed = false; if (!abortCtl && !reconnectTimer) connect() }
  }

  function hideChat() {
    closed = true
    clearTimers()
    teardownReader()
    if (chatEl) chatEl.hidden = true
    // 注意：只断开 SSE，不结束内核会话；重开可继续（冷启动不回放历史，仅续收之后的新帧）。
  }

  // 文档切换：重置固定 pane 上下文（消息与会话保留——同文档回来仍在；pane 按新文档重载）。
  function onDocChanged() {
    lastTurn = 0
    pinToken++
    reloadPins()
  }

  // ── 对外入口 ────────────────────────────────────────────────────────────────
  // 顶栏「对话」按钮调它；可选传入 requestId（右栏台账「对话」动作）。
  window.__wcCoachChatOpen = function (opts) {
    opts = opts || {}
    if (opts.requestId) currentRequestId = String(opts.requestId)
    if (opts.sessionId && /^session-[\w-]+$/.test(String(opts.sessionId))) {
      state.sessionId = String(opts.sessionId)
    }
    ensureChat()
    if (chatEl.hidden) showChat()
    else hideChat() // 已开 ⇒ 同按钮再点收起
  }
  window.__wcCoachChatOnDocChanged = onDocChanged
  // 台账轮询拿到结构化建议后回调（coach-net 调用）：在对话流里渲染成 apply/skip 卡片。
  // 服务端不单独推 suggestions 帧，卡片数据权威来源仍是 relay-result（决策 3 兜底路径复用）。
  window.__wcCoachChatSuggestions = function (requestId, items) {
    if (!Array.isArray(items) || !items.length) return
    // 非当前会话的结果不串流（两者都有值且不一致才拦；任一缺失则放行，兼容仅按 sessionId 订阅的场景）。
    if (requestId && currentRequestId && String(requestId) !== String(currentRequestId)) return
    dispatch({ type: 'SUGGESTIONS', items: items })
  }
  // writing.js 进「固定」tab 时按当前文档重载固定内容（boardSwitchTab 调用，缺失安全）。
  window.__wcCoachChatReloadPins = function () { try { reloadPins() } catch (e) { /* 不影响右栏 */ } }
  // 供 send-net 回程 / 台账动作回填首轮锚点。
  window.__wcCoachChatSetRequest = function (requestId) {
    if (requestId) currentRequestId = String(requestId)
  }
})()
