'use strict'

// ============================================================================
// 写作客户端 · 「AI 校对」链路层（B5 / CR-4①：S2 投递 · S3 回程轮询 · S4 渲染 · S5 应用）
//
// 分工（与 `send.js` / `send-net.js` 同一套切法）：
//   · proofread.js      —— 纯逻辑（提示词 / JSON 抽取 / 校验 / 定位 / 应用 / 回程认领），node 可单测
//   · proofread-net.js  —— 本文件：HTTP + 轮询 + UI + 高亮
//
// 链路：① 取**校对专用会话 id**（用户自己在 [DSH] 页建；id 走「设置 → AI 校对」/ 内置默认）
//      ② 投固定提示词（`POST /api/session/prompt`，与阶段⑤ 同一信封）
//      ③ **轮询** `POST /api/session/page` 取回记录 ⇒ 认领本次 `requestId` 的 `assistant/message`
//      ④ 右栏建议列表 + 正文 `::highlight()` 高亮（**DOM 与 .md 一字不动**）
//      ⑤ 用户点「应用」⇒ 只改那一条（`Proof.applySuggestion`）⇒ 立刻保存
//
// 🔴 硬约束（用户拍）：**正文绝不被自动改写** —— 本文件里唯一会改正文的地方是「应用」按钮的
//   点击回调（`applyItem`），轮询与渲染全程只读。
//
// ⚠️ 可整段撤销：删掉本文件 + shell.html 里三处引用 + writing.js 里那段桥 + writing.css 里的
//   高亮段 = 回到加本批之前（与 `send-net.js` 的取向一致）。
// ============================================================================

;(function () {
  'use strict'

  var Proof = window.WCProofread
  var Send = window.WCSend

  // ── 常量（一处可改）──────────────────────────────────────────────────────
  var PROMPT_PATH = '/api/session/prompt'
  // ── 轮询参数（2026-10-19 用户拍板：**删掉一切自动判死，永不超时**）──────────
  // 起因：约 1 万字的校对因网络不稳定，曾被「连续 5 次读会话失败 / 无进展 / 总时长」之一误杀，
  // 但任务本身未必失败。用户决策：客户端**不再自行判定失败**，唯一退出方式是右栏头部的
  // 「取消等待」按钮（AbortController，全链路可中断）；若怀疑结果异常，用户会自己切到对话页确认。
  // 所以轮询只做两件事：
  //   ① **认领到本次回复** ⇒ 立刻收工（正常路径，与时间无关）；
  //   ② **这一轮答完了却没有可解析 JSON** ⇒ 只在状态行**提示**（非致命），轮询继续，
  //      由用户决定切对话页核实、继续等、还是手动取消。
  // 读会话失败只累加计数并在状态行如实展示，**永不 throw**；网络恢复后计数清零。
  var POLL_MS = 2000          // 前 20 次用 2s
  var POLL_MS_SLOW = 5000     // 之后降到 5s（长任务少打点请求；仍是只读）
  var POLL_FAST_TIMES = 20
  var PAGE_LIMIT = 120              // 每次取回的尾部事件条数
  var HL = { must: 'wc-must', should: 'wc-should', nice: 'wc-nice' }
  var SEV_LABEL = { must: '必改', should: '建议', nice: '可选' }

  var els = {}
  var st = {
    sessionId: '',
    requestId: '',
    items: [],
    matched: false,
    activeId: '',
    busy: false,
    run: null,      // 本次运行的 AbortController（取消按钮/换文档时 abort）
    noteExtra: '',  // 高亮不可用之类的附加说明
  }

  function bridge() { return window.__wcProofBridge || null }

  function say(text, isError) {
    var b = bridge()
    if (b && b.notice) b.notice(text, isError)
    else console.error('[wc-proof] ' + text)
  }

  function msgOf(e) { return (e && e.message) || String(e || '未知错误') }

  function isAbort(e) {
    if (!e) return false
    if (e.name === 'AbortError') return true
    if (e.code === 20) return true
    return /aborted|abort/i.test(String(e.message || ''))
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(resolve, ms)
      if (signal && signal.addEventListener) {
        signal.addEventListener('abort', function () { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      }
    })
  }

  function uuid() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID() } catch (e) { /* 回退 */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16)
    })
  }

  function ianaZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch (e) { return 'UTC' }
  }

  // ── RPC（typert 信封；形参名从 `missing "xxx"` 报错里自学，见 rob-probe 的踩坑）─────

  var paramName = {}   // method → 学到的形参名（默认 _request；session/page 实测要 request）

  function rpcOnce(method, param, request, signal) {
    // 🔴 信封的 `method` 由 Proof.buildEnvelope 统一写成**斜杠形式**（与 URL 路径一致）：
    //    内核会对不上就拒绝（`method "session.page" does not match endpoint "session/page"`）。
    var env = Proof.buildEnvelope(method, param, request, 'proof-' + uuid())
    return fetch('/api/' + String(method).replace(/\./g, '/'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(env),
      signal: signal,
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null
        try { json = text ? JSON.parse(text) : null } catch (e) { json = null }
        return { status: res.status, text: text, json: json }
      })
    })
  }

  async function rpc(method, request, signal) {
    var p = paramName[method] || '_request'
    var r = await rpcOnce(method, p, request, signal)
    var err = r.json && r.json.result && r.json.result.error && r.json.result.error.message
    var learned = Send && Send.parseMissingParam ? Send.parseMissingParam(err || '') : null
    if (learned && learned !== p) {
      paramName[method] = learned
      r = await rpcOnce(method, learned, request, signal)
    }
    return r
  }

  /** 把 RPC 回复拆成 {ok, value|error}（把"传输失败/信封不合法/业务错误"分开报） */
  function unwrap(r) {
    if (!r || r.status !== 200) return { ok: false, error: 'HTTP ' + (r && r.status) }
    var res = r.json && r.json.result
    if (!res) return { ok: false, error: '回复里没有 result 字段（内核未受理）' }
    if (res.error) return { ok: false, error: (res.error.message || res.error.code || '业务错误') }
    return { ok: true, value: res.value }
  }

  // ── ② 校对会话（**不再由客户端新建**，只取配置里的 id）────────────────────

  /**
   * 会话 id 的来源（用户 2026-09-28 拍"简单化"）：
   *   **客户端不再自动建会话** —— 那条路要 `session/list`（取 cwd）+ `session/create` 两个
   *   客户端不可控的契约，真机第一跑就卡在"列表里读不到 cwd"。
   *   改为：会话由用户在 `[DSH]` 页自己建好 ⇒ id 存「设置 → AI 校对」（`config.json` 的
   *   `proofread.sessionId`）⇒ 主进程在配置为空时回退到**写死在程序里的默认值**。
   *   ⇒ 这里**只读一个字符串**，没有任何网络探测。
   */
  function ensureSession() {
    var b = bridge()
    var sid = b && b.sessionId ? String(b.sessionId() || '') : ''
    if (!sid) {
      throw new Error('还没有配置校对会话 —— 请在「设置 → AI 校对 → 校对会话 id」里填入会话 id')
    }
    st.sessionId = sid
    return sid
  }

  // ── ③ 投递 ──────────────────────────────────────────────────────────────

  function postEnvelope(env, signal) {
    return fetch(PROMPT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(env),
      signal: signal,
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null
        try { json = text ? JSON.parse(text) : null } catch (e) { json = null }
        return { status: res.status, text: text, json: json }
      })
    })
  }

  /** 投递提示词（与阶段⑤ 同一个信封：`payload.args.request`） */
  async function deliverPrompt(sessionId, requestId, prompt, signal) {
    var env = Send.buildEnvelope({
      sessionId: sessionId,
      mode: 'queue',
      text: prompt,
      requestId: requestId,
      timeZone: ianaZone(),
    })
    var r = await postEnvelope(env, signal)
    var res = r.json && r.json.result
    if (r.status !== 200) return { ok: false, error: 'HTTP ' + r.status + '：' + String(r.text || '').slice(0, 200) }
    if (!res) return { ok: false, error: '回复里没有 result 字段（内核未受理）' }
    if (res.error) return { ok: false, error: res.error.message || res.error.code || '业务错误' }
    return { ok: true }
  }

  // ── ③-b 轮询读回（`session/page`：先探游标，再按游标取尾部）──────────────

  /**
   * 取会话**尾部**一段记录（事件数组的"泛取"判据在 `proofread.js` 的 `Proof.pickRecords`，有单测）。
   * ⚠️ `throughSeq` 必须是真实游标：先发 `MAX_SAFE_INTEGER` ⇒ 内核回 `past cursor N` ⇒ 用 N 重取
   *   （`tools/rob-probe.mjs` 的实测口径）。
   */
  async function pageTail(sessionId, signal) {
    var address = { kind: 'session', sessionId: sessionId }
    var probe = unwrap(await rpc('session.page', { address: address, throughSeq: Number.MAX_SAFE_INTEGER, maxMessages: PAGE_LIMIT }, signal))
    var value = null
    if (probe.ok) {
      value = probe.value
    } else {
      var m = /past cursor (\d+)/.exec(probe.error || '')
      if (!m) throw new Error('读会话失败：' + probe.error + '（value 字段：' + Proof.valueKeys(probe.value) + '）')
      var cursor = Number(m[1])
      var got = unwrap(await rpc('session.page', { address: address, throughSeq: cursor, maxMessages: PAGE_LIMIT }, signal))
      if (!got.ok) throw new Error('读会话失败：' + got.error)
      value = got.value
    }
    var records = Proof.pickRecords(value)
    if (records === null) {
      // 形状完全不符 ⇒ 立刻报准（附实际字段名），别让用户干等三分钟
      throw new Error('读会话失败：返回里找不到事件数组（value 的字段：' + Proof.valueKeys(value) + '）')
    }
    return records
  }

  /** 「有进展」的判据：尾部窗口的**末条事件**变了（seq 或内容长度）⇒ 会话确实在动 */
  function progressKey(records) {
    var n = records.length
    if (!n) return '0'
    var last = records[n - 1]
    var seq = last && (last.seq != null ? last.seq : (last.event && last.event.seq != null ? last.event.seq : null))
    return n + '|' + (seq != null ? seq : '?') + '|' + JSON.stringify(last).length
  }

  /**
   * 轮询到"认领到本次回复"为止（2026-10-19 起**永不自动判死、永不超时**，见常量处说明）。
   * 读会话失败只累加计数并在状态行如实展示，网络恢复即清零；唯一退出路径＝认领到结果
   * 或用户点「取消等待」（signal abort）。
   */
  async function pollReport(requestId, signal) {
    var t0 = Date.now()
    var lastProgressAt = t0
    var lastKey = ''
    var fetchFails = 0
    var lastFetchErr = ''
    var lastCount = -1
    var doneHintShown = false
    for (var n = 1; ; n++) {
      await sleep(n <= POLL_FAST_TIMES ? POLL_MS : POLL_MS_SLOW, signal)
      var waited = Math.round((Date.now() - t0) / 1000)
      var idle = Math.round((Date.now() - lastProgressAt) / 1000)
      var tail = lastFetchErr ? ('读会话失败 ' + fetchFails + ' 次：' + lastFetchErr)
        : ('读到 ' + (lastCount < 0 ? '—' : lastCount + ' 条'))
      setStatus('校对中…（已等 ' + waited + ' 秒；会话最近一次更新 ' + idle + ' 秒前；' + tail +
        '；可随时点「取消等待」，或切到对话页确认进展）')

      var page = null
      try { page = await pageTail(st.sessionId, signal) } catch (e) {
        if (isAbort(e)) throw e
        // 网络抖动不再判死：只计数、在状态行展示，下一轮继续读
        fetchFails++
        lastFetchErr = msgOf(e)
      }
      var records = page || null
      if (records) {
        fetchFails = 0
        lastFetchErr = ''
        lastCount = records.length

        // ① 有进展？（先判进展，再判结果 —— 否则"刚好这一轮答完"会被误当停滞）
        var key = progressKey(records)
        if (key !== lastKey) { lastKey = key; lastProgressAt = Date.now() }

        if (records.length) {
          var got = Proof.pickReport(records, requestId)
          if (got.ok) return got

          // ② 这一轮**答完了**却没有可解析的 JSON：只提示一次（非致命），轮询继续。
          //    用户可切到对话页核实它实际答了什么，或继续等 / 手动取消。
          var ts = Proof.turnState(records, requestId)
          if (ts.done && !doneHintShown) {
            doneHintShown = true
            say('模型似乎已经答完这一轮，但回复里暂未解析出校对 JSON。' +
              '可切到 [DSH] 页的「文章校对」会话确认实际回复；若确认无望请点「取消等待」。本条提示只出现一次，轮询继续。', false)
          }
          if (!ts.sawPrompt && waited > 30) {
            setStatus('校对中…（已等 ' + waited + ' 秒；还没在会话里看到本次请求，可能在排队；读到 ' + records.length + ' 条；可点「取消等待」）')
          }
        }
      }
    }
  }

  // ── 主流程 ──────────────────────────────────────────────────────────────

  async function runProofread() {
    if (st.busy) return
    var b = bridge()
    if (!b || !b.context) { say('校对模块尚未就绪', true); return }
    var ctx = b.context()
    if (!ctx) { say('请先打开一个文档再校对', true); return }
    var text = b.text() || ''
    if (Send.countChars(text) === 0) { say('正文为空，无法校对', true); return }
    if (text.length > 20000) { say('正文超过 2 万字，请先剪切到 2 万字以内再校对', true); return }

    var ctl = new AbortController()
    st.run = ctl
    st.items = []
    st.activeId = ''
    st.noteExtra = ''
    paint()
    setBusy(true)

    try {
      var sid = ensureSession()
      var rid = uuid()
      st.requestId = rid
      setStatus('投递中…')
      var prompt = Proof.buildPrompt({ docName: ctx.docName, requestId: rid, text: text })
      var d = await deliverPrompt(sid, rid, prompt, ctl.signal)
      if (!d.ok) throw new Error('投递失败：' + d.error)
      var got = await pollReport(rid, ctl.signal)
      // 🔴 校对期间用户可能已经切走 ⇒ 这份结果属于**另一篇**，丢弃（否则会给当前文档挂上不相干的建议）
      var nowCtx = bridge().context()
      if (!nowCtx || nowCtx.relPath !== ctx.relPath) {
        say('校对完成，但期间已切换到别的文档 ⇒ 结果未应用（回到原文档时它还在）')
        return
      }
      st.items = Proof.sortItems(got.items)
      st.matched = got.matched
      st.noteExtra = got.matched ? '' : '未能确认这条回复属于本次请求（模型没回显 requestId），请自行核对'
      paint()
      setStatus(statusSummary())
      saveCache() // ⑥ 持久化：切文档/重启后能恢复（模型跑一次要 1~2 分钟，别浪费）
      if (st.items.length) say('校对完成：' + st.items.length + ' 条建议（点「应用」才改正文）')
      else say('校对完成：没有发现需要修改的地方')
    } catch (e) {
      if (isAbort(e)) { setStatus('已取消'); say('已取消校对', true) }
      else { setStatus('校对失败：' + msgOf(e)); say('校对失败：' + msgOf(e), true) }
    } finally {
      st.run = null
      setBusy(false)
      paint()
    }
  }

  function cancelRun() {
    if (st.run) { try { st.run.abort() } catch (e) { /* 已结束 */ } }
  }

  // ── ⑤ 应用（**唯一会改正文的地方**）──────────────────────────────────────

  async function applyItem(id) {
    var it = null
    for (var i = 0; i < st.items.length; i++) if (st.items[i].id === id) it = st.items[i]
    if (!it) return
    var b = bridge()
    if (!b) return
    if (b.editable && !b.editable()) { say('没有打开文档，无法应用', true); return }

    var r = Proof.applySuggestion(b.text() || '', it)
    if (!r.ok) {
      // 🔴 定位失败（原文已被改动）⇒ **拒绝**，绝不猜着改；把这条标出来但不删
      it.failed = r.error
      paint()
      say('无法应用这条：' + r.error, true)
      return
    }
    if (!r.changed) { dropItem(id); paint(); return }

    b.setText(r.text)
    dropItem(id)
    // 文本变了 ⇒ 其余条目的偏移全漂（后续以文本匹配为准，定位不到的当场标出来，不静默）
    for (var k = 0; k < st.items.length; k++) {
      var chk = Proof.locateItem(b.text() || '', st.items[k])
      st.items[k].failed = chk.ok ? '' : chk.error
    }
    paint()
    setStatus(statusSummary())
    saveCache() // ⑥ 应用之后立刻更新缓存（否则这条会随着"切文档恢复"又冒出来）
    if (b.flush) {
      var f = await b.flush()
      if (!f || !f.ok) say('已应用到编辑器，但保存失败：' + ((f && f.error) || '未知错误'), true)
      else say('已应用 1 条修改（其余内容未动）')
    } else {
      say('已应用 1 条修改（其余内容未动）')
    }
  }

  function dropItem(id) {
    st.items = st.items.filter(function (x) { return x.id !== id })
    if (st.activeId === id) st.activeId = ''
  }

  // ── ④ 渲染：状态行 + 建议列表 + 正文高亮 ─────────────────────────────────

  function supportsHighlight() {
    return !!(window.CSS && CSS.highlights && typeof window.Highlight === 'function')
  }

  function clearHighlights() {
    if (!supportsHighlight()) return
    for (var k in HL) { try { CSS.highlights.delete(HL[k]) } catch (e) { /* 没设过 */ } }
  }

  /**
   * 把写作区拆成"节点序列 + 拼接文本"。
   * · 文本节点 ⇒ 记它本身；`<br>` ⇒ 记 `null`（占 1 个字符，同 `domToText` 的 `\n`）；其它元素递归。
   * · 顺序与 `Plain.domToText` 一致 ⇒ 拼接文本应当与 `Editor.getText()` **逐字相等**（下面会校验）。
   */
  function domTextSegments(root) {
    var segs = []
    var text = ''
    function walk(node) {
      var kids = node.childNodes || []
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i]
        if (n.nodeType === 3) { segs.push(n); text += n.data }
        else if (n.nodeType === 1) {
          if (n.tagName === 'BR') { segs.push(null); text += '\n' }
          else walk(n)
        }
      }
    }
    if (root) walk(root)
    return { segs: segs, text: text }
  }

  /** 节点文本长度（`<br>` ⇒ null，交给 Proof.mapRange 当 1 个字符） */
  function lenOf(n) { return n ? n.data.length : null }

  /** 定位某条建议：**逐字优先，不成再忽略空白** ⇒ `{ok, start, end, fuzzy}` */
  function locOf(doc, item) {
    var loc = Proof.locateItem(doc, item)
    if (loc.ok) return { ok: true, start: loc.start, end: loc.end, fuzzy: false }
    var fz = Proof.locateFuzzy(doc, item.original)
    if (fz.ok) return { ok: true, start: fz.start, end: fz.end, fuzzy: true }
    return { ok: false, error: loc.error }
  }

  /** 按 `loc` 建 Range（`seg/lens` 必须与**当前 DOM** 对应） */
  function rangeFromLoc(seg, lens, loc) {
    var m = Proof.mapRange(lens, loc.start, loc.end)
    if (!m.ok) return null
    try {
      var r = document.createRange()
      r.setStart(seg.segs[m.si], m.so)
      r.setEnd(seg.segs[m.ei], m.eo)
      return r
    } catch (e) { return null }
  }

  /** 把某条建议映射成 Range；`fuzzy=true` ⇒ 忽略空白差异（只用于高亮） */
  function rangeOf(seg, lens, doc, item, fuzzy) {
    var loc = fuzzy ? Proof.locateFuzzy(doc, item.original) : Proof.locateItem(doc, item)
    if (!loc.ok) return null
    return rangeFromLoc(seg, lens, loc)
  }

  /**
   * 🔴 把某条建议**滚进视野**。
   *
   * 为什么不能像原来那样 `r.startContainer.parentElement.scrollIntoView()`：
   *   纯文本写作区里正文是**一个文本节点**，它的父元素就是**整个编辑器**（`.w-editor` 自己
   *   `overflow-y:auto` 是滚动容器）—— 对一个"本来就完整可见的容器"调 `scrollIntoView`
   *   等于什么都没做 ⇒ 用户看到"点了没反应"（2026-09-28 真机实测，就是这一处）。
   * ⇒ 在选区**起点**插一个**空标记 span**（无文本 ⇒ `domToText` 一字不变、不触发 input 不标脏），
   *   滚**它**（`scrollIntoView` 会自己找出所有可滚动祖先），随即移除。
   */
  function scrollRangeToView(seg, lens, loc) {
    var r = rangeFromLoc(seg, lens, loc)
    if (!r) return
    var span = document.createElement('span')
    span.setAttribute('data-wc-jump', '1')
    try {
      var collapsed = document.createRange()
      collapsed.setStart(r.startContainer, r.startOffset)
      collapsed.collapse(true)
      collapsed.insertNode(span)
      span.scrollIntoView({ block: 'center', inline: 'nearest' })
    } catch (e) {
      /* 插不进去（极少见）⇒ 退一步：直接在编辑器上按 rect 调 scrollTop */
      try {
        var host = r.startContainer.parentElement
        var rr = r.getBoundingClientRect()
        var br = host.getBoundingClientRect()
        if (rr.top < br.top || rr.bottom > br.bottom) {
          host.scrollTop += rr.top - br.top - (br.height - rr.height) / 2
        }
      } catch (e2) { /* 兜不住就算了：选区仍会选中，用户自己也能滚 */ }
    } finally {
      if (span.parentNode) span.parentNode.removeChild(span)
    }
  }

  function applyHighlights() {
    clearHighlights()
    var b = bridge()
    var box = b && b.editorEl ? b.editorEl() : null
    if (!box || !st.items.length) return
    if (!supportsHighlight()) {
      st.noteExtra = st.noteExtra || '本机不支持 CSS Highlight API ⇒ 只出列表，点条目可跳到正文位置'
      return
    }
    var doc = b.text() || ''
    var seg = domTextSegments(box)
    // 🔴 拼接文本必须与 Editor.getText() 逐字相等 —— 否则偏移会错位，宁可不画
    if (seg.text !== doc) {
      st.noteExtra = '正文里有特殊结构（domToText 与节点拼接不一致）⇒ 本轮不做高亮，只用列表定位'
      return
    }
    var lens = seg.segs.map(function (n) { return n ? n.data.length : null })
    var groups = {}
    for (var i = 0; i < st.items.length; i++) {
      var it = st.items[i]
      // 逐字匹配优先；不成再用"忽略空白"（与点条目跳转同一口径 ⇒ 列表能点的、正文就能看到）
      var r = rangeOf(seg, lens, doc, it, false) || rangeOf(seg, lens, doc, it, true)
      if (!r) continue
      var name = HL[Proof.normSeverity(it.severity)]
      if (!groups[name]) groups[name] = []
      groups[name].push(r)
    }
    for (var k in groups) {
      try { CSS.highlights.set(k, new Highlight(...groups[k])) } catch (e) { /* 建不上就算了 */ }
    }
  }

  function sevClass(s) { return 'w-proof-sev is-' + Proof.normSeverity(s) }

  function renderList() {
    if (!els.list) return
    els.list.textContent = ''
    if (!st.items.length) return
    for (var i = 0; i < st.items.length; i++) {
      ;(function (it) {
        var row = document.createElement('div')
        row.className = 'w-proof-item' + (it.failed ? ' is-failed' : '') + (st.activeId === it.id ? ' is-active' : '')
        row.setAttribute('data-id', it.id)

        var head = document.createElement('div')
        head.className = 'w-proof-item-head'
        var sev = document.createElement('span')
        sev.className = sevClass(it.severity)
        sev.textContent = SEV_LABEL[Proof.normSeverity(it.severity)] || '建议'
        head.appendChild(sev)
        var body = document.createElement('span')
        body.className = 'w-proof-diff'
        var orig = document.createElement('span')
        orig.className = 'w-proof-orig'
        orig.textContent = it.original
        var arrow = document.createElement('span')
        arrow.className = 'w-proof-arrow'
        arrow.textContent = ' → '
        var sug = document.createElement('span')
        sug.className = 'w-proof-sug'
        sug.textContent = it.suggestion === '' ? '（删除）' : it.suggestion
        body.appendChild(orig); body.appendChild(arrow); body.appendChild(sug)
        head.appendChild(body)
        row.appendChild(head)

        if (it.reason) {
          var why = document.createElement('div')
          why.className = 'w-proof-reason'
          why.textContent = it.reason
          row.appendChild(why)
        }
        if (it.failed) {
          var bad = document.createElement('div')
          bad.className = 'w-proof-fail'
          bad.textContent = '⚠ ' + it.failed
          row.appendChild(bad)
        }

        var acts = document.createElement('div')
        acts.className = 'w-proof-acts'
        var go = document.createElement('button')
        go.className = 'w-mini'
        go.setAttribute('data-act', 'apply')
        go.textContent = '应用'
        go.title = '只改这一处；正文其余内容不动'
        acts.appendChild(go)
        var skip = document.createElement('button')
        skip.className = 'w-mini'
        skip.setAttribute('data-act', 'skip')
        skip.textContent = '忽略'
        skip.title = '从列表里去掉这条（不改正文）'
        acts.appendChild(skip)
        row.appendChild(acts)

        row.addEventListener('click', function (e) {
          var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act')
          if (act === 'apply') { e.stopPropagation(); applyItem(it.id); return }
          if (act === 'skip') { e.stopPropagation(); dropItem(it.id); saveCache(); paint(); return }
          focusItem(it)
        })
        els.list.appendChild(row)
      })(st.items[i])
    }
  }

  /**
   * 点条目 ⇒ 选中正文里对应片段并滚到视野内（**不改任何内容**）。
   * 🔴 定位失败**必须看得见**（2026-09-28 真机：有一处点条目毫无反应 —— 因为这里当时什么都没做）。
   * 先逐字匹配；不成再"忽略空白"匹配一次（模型给的原文常与正文只差空白）；两次都不成 ⇒ 提示 + 标出来。
   */
  function focusItem(it) {
    st.activeId = it.id
    var b = bridge()
    var box = b && b.editorEl ? b.editorEl() : null
    if (!box) { paint(); return }
    var doc = b.text() || ''
    var seg = domTextSegments(box)
    if (seg.text !== doc) {
      say('正文里有特殊结构（domToText 与节点拼接不一致）⇒ 暂不能定位，只能用列表', true)
      paint()
      return
    }
    var loc = locOf(doc, it)
    if (!loc.ok) {
      it.failed = '正文里定位不到这段原文（可能已被改动）'
      say('定位失败：' + it.failed, true)
      paint()
      return
    }

    // ① 先滚进视野（插临时标记 → 滚 → 移除，见 scrollRangeToView 的注释与实测记录）
    scrollRangeToView(seg, seg.segs.map(lenOf), loc)

    // ② 再设选区：上一步会**拆分文本节点** ⇒ 必须**重新取**一次节点序列再建 Range，
    //    否则用的是"被拆掉一半"的旧节点引用，选区会偏。
    var seg2 = domTextSegments(box)
    if (seg2.text === doc) {
      var r = rangeFromLoc(seg2, seg2.segs.map(lenOf), loc)
      if (r) {
        try {
          var sel = window.getSelection()
          sel.removeAllRanges()
          sel.addRange(r)
        } catch (e) { /* 选区建不上就算了：视野已经滚过去了 */ }
      }
    }
    if (loc.fuzzy) say('这条原文与正文只差空白 ⇒ 已按"忽略空白"定位（应用时仍要求逐字一致）')
    paint()
  }

  /**
   * 重画右栏（计数 + 列表 + 高亮 + 忙态）。
   * ⚠️ **不碰状态行**：状态行是"过程与结果"的叙述（投递中 / 校对失败 / 已取消…），
   * 由流程各步自己 `setStatus`；把它塞进 paint() 会被"任何一次重画"覆盖掉（踩过）。
   */
  function paint() {
    var sum = Proof.summarize(st.items)
    if (els.count) {
      els.count.textContent = sum.total
        ? (sum.total + ' 条（必改 ' + sum.must + ' · 建议 ' + sum.should + ' · 可选 ' + sum.nice + '）')
        : ''
    }
    renderList()
    applyHighlights()
    setBusy(st.busy)
  }

  /** 结果摘要（成功拿到报告后 / 应用一条之后，用它更新状态行） */
  function statusSummary() {
    var sum = Proof.summarize(st.items)
    if (!sum.total) return '没有发现错字 / 病句' + (st.noteExtra ? ' · ' + st.noteExtra : '')
    return '共 ' + sum.total + ' 条建议' + (st.noteExtra ? ' · ' + st.noteExtra : '') + '（点「应用」才改正文）'
  }

  function setStatus(t) { if (els.status) els.status.textContent = t || '' }

  function setBusy(v) {
    st.busy = !!v
    if (els.go) els.go.disabled = st.busy
    if (els.cancel) els.cancel.hidden = !st.busy
  }

  // ── 复位 / 缓存（切文档或重启后能恢复上次结果）───────────────────────────

  function fmtTime(ms) {
    if (!ms) return '上次'
    var d = new Date(ms)
    var p = function (n) { return (n < 10 ? '0' : '') + n }
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  /**
   * ⑥ 把当前建议**存下来**（成功拿到报告 / 应用一条 / 忽略一条之后都会调）。
   * 用户 2026-09-28 反馈：「切出再切回原文档，剩余校对内容全丢；关闭程序再开启还得重复校对同一文本」
   * —— 一次校对要等模型 1~2 分钟 ⇒ 必须持久化。
   * 落点在主进程（`userData/proofread/`，不进工作区）；写失败只记 console，不打扰用户（下次重跑即可）。
   */
  function saveCache() {
    var b = bridge()
    if (!b || !b.context || !b.saveReport) return
    var ctx = b.context()
    if (!ctx) return
    try {
      var doc = b.text() || ''
      var r = b.saveReport(ctx.relPath, {
        docHash: Proof.hashText(doc),
        requestId: st.requestId || '',
        items: st.items.map(function (x) {
          return {
            id: x.id, original: x.original, suggestion: x.suggestion,
            reason: x.reason, severity: x.severity, start: x.start, end: x.end,
          }
        }),
      })
      if (r && r.catch) r.catch(function (e) { console.error('[wc-proof] 缓存写入失败：' + msgOf(e)) })
    } catch (e) {
      console.error('[wc-proof] 缓存写入异常：' + msgOf(e))
    }
  }

  /**
   * ⑥ 把这篇文档**上次**的校对结果恢复出来（切回来 / 重启后）。
   * 逐条按当前正文重新定位：定位得到的照常可用；定位不到的**保留并标出**（不静默丢、也不假装有效）。
   * 期间用户若已跑了新的（`st.busy` 或有 items）⇒ 不覆盖。
   */
  async function restoreCached() {
    var b = bridge()
    if (!b || !b.context || !b.loadReport) return
    var ctx = b.context()
    if (!ctx) return
    var res = null
    try { res = await b.loadReport(ctx.relPath) } catch (e) { return }
    if (!res || !res.ok || !res.report || !Array.isArray(res.report.items) || !res.report.items.length) return
    if (st.items.length) return // 期间已经有内容（或已恢复过）⇒ 不覆盖
    var doc = b.text() || ''
    var rv = Proof.reviveReport(res.report.items, doc, res.report.docHash, Proof.hashText(doc))
    // 🔴 异步往返期间用户可能已经切走 ⇒ 别把 A 篇的建议放到 B 篇上
    var now = bridge()
    var nowCtx = now && now.context ? now.context() : null
    if (!nowCtx || nowCtx.relPath !== ctx.relPath) return
    st.items = Proof.sortItems(rv.items)
    st.matched = true
    st.noteExtra = rv.missing
      ? ('正文改动后 ' + rv.missing + ' 条已定位不到（已标出）')
      : (rv.docChanged ? '正文有改动，建议已按当前正文重新定位' : '')
    paint()
    setStatus('已恢复上次校对结果（' + fmtTime(res.report.at) + ' · ' + st.items.length + ' 条）' +
      (st.noteExtra ? ' · ' + st.noteExtra : '') + ' —— 想重跑就再点一次「✎ 校对」')
  }

  function reset() {
    cancelRun()
    st.items = []
    st.activeId = ''
    st.matched = false
    st.noteExtra = ''
    st.requestId = ''
    clearHighlights()
    if (els.list) els.list.textContent = ''
    if (els.count) els.count.textContent = ''
    if (!st.busy) setStatus('点工具栏「✎ 校对」开始（只给建议，不改正文）')
    restoreCached() // ⑥ 切回同一篇 / 重启后：把上次结果拿回来（异步，不阻塞）
  }
  window.__wcProofReset = reset

  // ── 接线 ────────────────────────────────────────────────────────────────

  function collectEls() {
    var byId = function (id) { return document.getElementById(id) }
    els = {
      go: byId('w-proof'),
      cancel: byId('w-proof-cancel'),
      status: byId('w-proof-status'),
      count: byId('w-proof-count'),
      list: byId('w-proof-list'),
    }
  }

  /**
   * 初始化失败必须**看得见**。
   * 🔴 2026-09-28 真机踩过：`proofread.js` 没被壳层白名单放行（404）⇒ 本文件 `init()` 在拿到
   * `Proof` 之前就 `return`，**连点击监听都没绑上** ⇒ 用户点「校对」**毫无反应**、也没有任何提示。
   * ⇒ 现在一律把原因写到右栏状态行 + 状态条上，绝不再"死了不响"。
   */
  function fail(reason) {
    console.error('[wc-proof] ' + reason)
    var box = document.getElementById('w-proof-status')
    if (box) box.textContent = '校对不可用：' + reason
    try {
      if (window.__wcProofBridge && window.__wcProofBridge.notice) {
        window.__wcProofBridge.notice('校对不可用：' + reason, true)
      }
    } catch (e) { /* 连提示都失败就不再抛 */ }
  }

  function init() {
    if (!Proof) { fail('proofread.js 没加载（壳层静态资源白名单里少了它？）'); return }
    if (!Send) { fail('send.js 没加载（信封/形参自学要用它）'); return }
    collectEls()
    if (!els.go || !els.list) { fail('右栏面板或工具栏按钮没找到（shell.html 版本不匹配？）'); return }
    els.go.addEventListener('click', function () { runProofread() })
    if (els.cancel) els.cancel.addEventListener('click', function () { cancelRun() })
    reset()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
