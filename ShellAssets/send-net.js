'use strict'

// ============================================================================
// 写作客户端 · 「发送给任务中心」渲染层链路（阶段⑤）
//
// 分工：
//   · send.js      —— 纯逻辑（消息模板 / 字数 / typert 信封 / 形参名自学），node 可单测
//   · send-net.js  —— 本文件：HTTP + UI + 记账
//
// 🔑 为什么能直接 fetch('/api/...')：壳页与 [DSH] iframe 都从 `http://127.0.0.1:<port>` 加载，
//   main.js 在回环上反代到网关 ⇒ 对 /api/* 是**同源**（Cookie 自动带上）。
//   ⇒ 不需要改 main.js 的反代，也不需要给 preload.js 加桥。
//
// 链路（⑩ C5 起为「落盘 + 路径」）：flush 本地 → **落盘到客户端区（拿 relPath+version）**
//   → 组装消息（只有路径，**不带正文**）→ 投递 → 记账。
//   另有 C12「提交给 agent」：把客户端区的当前稿**复制**进 `写作训练/草稿/…`（见 submitCurrent）。
//   落盘走 `POST /writing-studio/api/clientZoneSave`（同上源；客户端区，agent 不自动看见）。
//   🔴 fail-closed：落盘失败**不自动降级**成内联，只给用户一个**显式出口**（见 §C5 那段）；
//      409 冲突 ⇒ 覆盖 / 另存为 / 取消 三选。
//   🔑 为什么这条路解决了老问题：网关 /api/workspaces/* 是网关自己的沙箱（稿子写进去 agent 看不见），
//      而这支落盘直接把文件写进**内核工作区**⇒ agent 能按路径自己读，省掉整篇正文的 token。
//      失败时复制到剪贴板，由用户到 [DSH] 页手动粘贴。
//
// B1 缺陷修复（联调实测，见证据 §9）：
//   · D-1a 投递加 30s 超时（AbortController）⇒ 超时按"网络失败"走剪贴板，不再永久卡住；
//   · D-1b 忙时**不禁用**取消/关闭，且它们会 abort 在途请求 ⇒ 弹窗永远关得掉；
//   · D-4  空白（含只有空格/换行）一律拒发，不再发出"约 0 字"的空壳消息；
//   · D-2  弹窗内用文字指示"已捕获选区（失焦/点别处都不会丢）"+ 清除入口（D-3 是浏览器原生行为，不修）。
//
// 与既有功能的耦合面：只读 `window.__wcSendBridge`（writing.js 提供：当前文档上下文 /
//   编辑器文本与选区 / flush / 状态提示）与 `window.WCSend`。
//   ⇒ 删掉本文件 + shell.html 里两处 DOM/脚本引用 + writing.js 里那段桥，即完全回到本阶段之前。
// ============================================================================

;(function () {
  'use strict'

  var Send = window.WCSend
  var api = window.wcStorage

  // ── 常量（一处可改）──────────────────────────────────────────────────────
  var LOG_FILE = '发送记录.md'              // 本地发送记录（工作区根下的 md）
  var RELAY_PATH = '/taskkit/api/relay'     // 服务端通用中转口（客户端不持有会话 id）
  var SEND_TIMEOUT_MS = 30000               // D-1a：投递超时（超时按"网络失败"走剪贴板回退）
  // ⑩ C5（形态 B）落盘路由 —— 2026-09-29 起客户端写的是**与 `写作训练/` 平级的 `客户端区/`**
  //   （agent 不自动看见）。同源（壳页与 [DSH] iframe 都在 `http://127.0.0.1:<port>` 上，main.js
  //   反代到网关）⇒ Cookie 自动带。请求里的 `relPath` **相对 `客户端区/`**，不带前缀。
  var DRAFT_SAVE_PATH = '/writing-studio/api/clientZoneSave'
  // 「提交给 agent」：把 `客户端区/正文/<作品>/<文档>.md` **复制**进 `写作训练/草稿/…`（源保留）。
  var SUBMIT_PATH = '/writing-studio/api/submit'

  var INTENT_OTHER = '__other__'

  var els = {}
  var busy = false
  // ⑩ C5：通道与冲突处理
  var channelChose = null                    // 用户在**本窗内**手选过的通道；'inline' = 显式要求内联发送（每次开窗复位）
  var versionCache = Object.create(null)     // relPath → 上次成功落盘的 version（冲突三选的前置；
                                             //   重启后为空 ⇒ 对已存在的稿件会先弹一次三选：安全但不烦人）
  var resolveRef = null                      // 关窗时把 askResolve 判为"取消"的钩子
  var pending = null        // { ctx, text, selected, scope }
  var inflight = null       // 在途投递的 AbortController（超时/用户取消都走它）
  var logChain = Promise.resolve()

  function bridge() { return window.__wcSendBridge || null }

  function say(text, isError) {
    var b = bridge()
    if (b && b.notice) b.notice(text, isError)
    else console.error('[wc-send] ' + text)
  }

  function p2(n) { return (n < 10 ? '0' : '') + n }

  /** 'YYYY-MM-DD HH:MM'（本地时间） */
  function stamp(d) {
    d = d || new Date()
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
      ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
  }

  // ── 小工具：uuid / 时区 / 剪贴板 ─────────────────────────────────────────

  function uuid() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID() } catch (e) { /* 回退 */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16)
    })
  }

  /** IANA 时区名（形参类型是 string；取不到就 UTC，不编造） */
  function ianaZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch (e) { return 'UTC' }
  }

  /** 复制到剪贴板（首选异步 API；不可用/被拒则回退 execCommand） */
  function copyToClipboard(text) {
    return new Promise(function (resolve) {
      var fallback = function () { resolve(fallbackCopy(text)) }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { resolve(true) }, fallback)
          return
        }
      } catch (e) { /* 落到下面的回退 */ }
      fallback()
    })
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      document.body.appendChild(ta)
      ta.select()
      var ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return !!ok
    } catch (e) { return false }
  }

  // ── HTTP（同源 fetch）────────────────────────────────────────────────────

  function jsonOpts(method, body, signal) {
    var o = { method: method, headers: { accept: 'application/json' } }
    if (signal) o.signal = signal
    if (body !== undefined) {
      o.headers['content-type'] = 'application/json'
      o.body = JSON.stringify(body)
    }
    return o
  }

  async function readBody(res) {
    var text = ''
    try { text = await res.text() } catch (e) { /* 无体 */ }
    var json = null
    try { json = text ? JSON.parse(text) : null } catch (e) { json = null }
    return { text: text, json: json }
  }

  // ── ① 投递（POST /taskkit/api/relay）───────────────────────────────────

  function responseText(r) {
    if (r.rb && r.rb.text) return String(r.rb.text)
    return ''
  }

  /** 服务端失败 code → 可操作提示；非配置类 code 返回 ''（由调用方走网络失败/剪贴板） */
  function relayMessage(code) {
    switch (code) {
      case 'TASKCENTER_MISSING':
        return '未找到任务中心：请先在 DSH 中创建「任务中心」会话后再发送'
      case 'TASKCENTER_ARCHIVED':
        return '任务中心会话已归档：请取消归档或指定新的任务中心后再发送'
      case 'TASKCENTER_UNREACHABLE':
        return '任务中心暂时不可达：唤醒失败，请稍后重试'
      default:
        return ''
    }
  }

  /**
   * 投递消息到服务端 relay。成功 ⇒ {ok:true}；失败 ⇒ {ok:false, code, message}。
   * 成功判据是响应体 ok === true（不再看内核 RPC 的 result 字段）。
   * `signal` 来自调用方（超时 / 用户取消）⇒ 中止时 fetch 抛 AbortError，由调用方兜。
   */
  async function deliver(text, signal) {
    var r = await fetch(RELAY_PATH, jsonOpts('POST', { text: text, requestId: uuid(), timeZone: ianaZone() }, signal))
      .then(function (res) { return readBody(res).then(function (rb) { return { status: res.status, ok: res.ok, rb: rb } }) })
    var body = (r.rb && r.rb.json) || {}
    if (r.ok && body.ok === true) return { ok: true }
    var code = body.code || ('HTTP_' + r.status)
    return { ok: false, code: code, message: relayMessage(code) || ('投递失败（HTTP ' + r.status + '）：' + (responseText(r).slice(0, 300) || '')) }
  }

  /** 异常是否来自 AbortController.abort()（超时或用户取消） */
  function isAbort(e) {
    if (!e) return false
    if (e.name === 'AbortError') return true
    if (e.code === 20) return true               // DOMException.ABORT_ERR
    return /aborted|abort/i.test(String(e.message || ''))
  }

  // ── ② 记账（本地工作区 发送记录.md，逐条追加）───────────────────────────

  /** 一行：时间 · 文档 · 诉求 · 范围 · 结果（不写远端路径/版本 —— 首版没有这些东西） */
  function logLine(when, docName, intent, scopeLabel, result) {
    return '- ' + when + ' · 《' + Send.stripMd(Send.baseSeg(docName)) + '》 · ' +
      intent + ' · ' + scopeLabel + ' · ' + result
  }

  /** 串行追加一行（读→改→写；失败只记 console，不打扰用户） */
  function appendLog(line) {
    logChain = logChain.then(function () {
      if (!api || !api.readDoc || !api.writeDoc) return null
      return api.readDoc(LOG_FILE).then(function (res) {
        var prev = (res && res.ok) ? String(res.content || '') : ''
        var head = prev ? '' : '# 发送记录\n\n（写作客户端「发送给任务中心」的逐条记录）\n\n'
        var sep = (prev && !/\n$/.test(prev)) ? '\n' : ''
        return api.writeDoc(LOG_FILE, head + prev + sep + line + '\n')
      })
    }).catch(function (e) {
      console.error('[wc-send] 写发送记录失败：' + ((e && e.message) || e))
    })
    return logChain
  }

  // ── UI ──────────────────────────────────────────────────────────────────

  function collectEls() {
    var byId = function (id) { return document.getElementById(id) }
    els = {
      fullBtn: byId('w-send-full'),
      selBtn: byId('w-send-sel'),
      submitBtn: byId('w-submit'),
      box: byId('w-send'),
      close: byId('w-send-close'),
      cancel: byId('w-send-cancel'),
      go: byId('w-send-go'),
      doc: byId('w-send-doc'),
      intent: byId('w-send-intent'),
      otherRow: byId('w-send-other-row'),
      other: byId('w-send-other'),
      saveIntent: byId('w-send-save-intent'),
      // ⑩ C5：需要用户拍板的一行（三个复用槽位，文案/回调由 askResolve 填）
      resolveRow: byId('w-send-resolve'),
      resolveMsg: byId('w-send-resolve-msg'),
      resolve1: byId('w-send-resolve-1'),
      resolve2: byId('w-send-resolve-2'),
      resolve3: byId('w-send-resolve-3'),
      scope: byId('w-send-scope'),
      selRow: byId('w-send-sel-row'),
      selInfo: byId('w-send-sel-info'),
      selClear: byId('w-send-sel-clear'),
      preview: byId('w-send-preview'),
      note: byId('w-send-note'),
      progress: byId('w-send-progress'),
    }
  }

  function currentIntent() {
    var v = els.intent.value
    if (v === INTENT_OTHER) return (els.other.value || '').trim()
    return v
  }

  /**
   * ⑨ 诉求下拉的选项由**设置里的 `send.intents`** 驱动（**可自定义** —— 用户 2026-09-28 要求，
   * 他一直在手填「成果」）。末尾**恒有**「其他…」；列表为空时下拉只剩它。
   * 默认选中**第一项**（= 加"可自定义"之前的行为：那时第一个 option 就是默认值）。
   */
  function fillIntents() {
    if (!els.intent) return
    var b = bridge()
    var list = (b && b.intents) ? b.intents() : []
    var prev = els.intent.value
    while (els.intent.firstChild) els.intent.removeChild(els.intent.firstChild)
    for (var i = 0; i < list.length; i++) {
      var o = document.createElement('option')
      o.value = list[i]
      o.textContent = list[i]
      els.intent.appendChild(o)
    }
    var other = document.createElement('option')
    other.value = INTENT_OTHER
    other.textContent = '其他…'
    els.intent.appendChild(other)
    // 尽量保住用户原来选的；原值已被删 ⇒ 回落到第一项；列表空 ⇒ 只能「其他…」
    var keep = list.indexOf(prev) >= 0 ? prev : (list.length ? list[0] : INTENT_OTHER)
    els.intent.value = keep
    els.otherRow.hidden = keep !== INTENT_OTHER
  }

  /** ⑨「＋ 存为常用」：把当前手填的诉求存进预设（下次直接在下拉里选）—— **失败不静默** */
  function saveCurrentIntentAsPreset() {
    var v = (els.other.value || '').trim()
    if (!v) { els.note.textContent = '请先在上面填好诉求，再点「＋ 存为常用」'; return }
    var b = bridge()
    var cur = (b && b.intents) ? b.intents() : []
    var r = Send.addIntent(cur, v)
    if (!r.added) {
      els.note.textContent = r.reason === 'dup'
        ? ('「' + v + '」已经在预设里了')
        : r.reason === 'full'
          ? ('预设已满（' + Send.INTENTS_MAX + ' 条），请先到「设置 › 发送」里删几条')
          : '诉求不能为空'
      return
    }
    if (!b || !b.saveIntents) { els.note.textContent = '保存失败：壳未提供 saveIntents'; return }
    els.note.textContent = '正在保存…'
    b.saveIntents(r.list).then(function (res) {
      if (!res || !res.ok) {
        els.note.textContent = '保存失败：' + ((res && res.error) || '未知错误')
        return
      }
      fillIntents()
      els.intent.value = v          // 存完直接选中它，省得用户再点一次下拉
      els.otherRow.hidden = true
      els.note.textContent = '已存为常用：「' + v + '」（下次直接在下拉里选；设置 › 发送 里可改可删）'
      say('已存为常用：' + v)
    }, function (e) {
      els.note.textContent = '保存异常：' + String((e && e.message) || e)
    })
  }

  /** 选区预览：压掉换行/连续空白，最长 60 字（只用于指示与回显） */
  function previewOf(s) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    return t.length > 60 ? t.slice(0, 60) + '…' : t
  }

  /** 按 pending.scope 刷新「范围 / 选区指示 / 预览」（切范围时不重开弹窗，保留已填诉求） */
  function renderScope() {
    var scope = pending.scope
    var body = scope === 'selection' ? pending.selected : (pending.text || '')
    var n = Send.countChars(body)
    els.scope.textContent = scope === 'selection'
      ? ('选中段（' + n + ' 字；内联发送，全文不上传）')
      : ('全文（' + n + ' 字；内联发送）')
    els.preview.hidden = scope !== 'selection'
    els.preview.textContent = scope === 'selection' ? pending.selected : ''
    if (els.selRow) {
      els.selRow.hidden = scope !== 'selection'
      if (els.selInfo) {
        els.selInfo.textContent = scope === 'selection'
          ? ('已捕获选区（失焦 / 点别处都不会丢）：' + previewOf(pending.selected) + '（' + n + ' 字）')
          : ''
      }
    }
  }

  function openSend(scope) {
    var b = bridge()
    if (!b || !b.context) { say('发送模块尚未就绪', true); return }
    var ctx = b.context()
    if (!ctx) { say('请先打开一个文档', true); return }
    var text = b.text() || ''
    var selected = scope === 'selection' ? (b.selection() || '') : ''
    // 🔴 D-4：空白（含只有空格/换行）一律不开弹窗 —— 否则会发出"约 0 字"的空壳消息
    if (scope === 'selection' && Send.countChars(selected) === 0) { say('选中段为空（只有空白），无法发送', true); return }
    if (scope === 'full' && Send.countChars(text) === 0) { say('正文为空，无法发送', true); return }

    pending = { ctx: ctx, text: text, selected: selected, scope: scope }

    els.doc.textContent = ctx.docName + '（' + ctx.relPath + '）'
    // ⑩ C5：每次开窗都**复位通道选择**（"改用内联发送"只对当前这一个窗有效）
    channelChose = null
    if (els.resolveRow) els.resolveRow.hidden = true
    // ⑨ 诉求下拉由设置的 `send.intents` 驱动；fillIntents 里已负责"默认选第一项 + 决定其他行是否露出"
    fillIntents()
    els.other.value = ''
    renderScope()
    els.note.textContent = ''
    els.progress.textContent = ''
    els.go.disabled = false
    els.box.hidden = false
  }

  /** 放弃已捕获的选区，就地切回"全文"（不重开弹窗 ⇒ 已填的诉求不丢） */
  function clearSelection() {
    if (!pending || pending.scope !== 'selection') return
    var b = bridge()
    pending.text = (b && b.text) ? (b.text() || '') : pending.text
    pending.selected = ''
    pending.scope = 'full'
    renderScope()
  }

  /**
   * 取消 / 关闭：不写记录、不发请求。
   * 🔴 D-1b：**忙时也必须能关** —— 那时改为"中止在途投递"，收尾（关窗 + 提示）由 doSend 的 catch 负责；
   *   否则投递卡住时弹窗整体锁死（联调实测 D-1）。
   */
  function closeSend() {
    // ⑩ C5：关窗 ⇒ 那条"等你拍板"的行按**取消**处理（别把 Promise 悬着）。
    // ⚠️ 必须放在 `busy` 判断**之前**：拍板时正在 await `askResolve()`（**没有在途 fetch**），
    //    先走 abort 分支是个空操作 ⇒ 行还留着、点几次都没反应。
    if (resolveRef) resolveRef(null)
    if (busy && inflight) { abortInflight(); return }
    els.box.hidden = true
    pending = null
  }

  /** 中止在途投递（用户点取消/关闭/Esc，或超时定时器触发） */
  function abortInflight() {
    if (!inflight) return
    try { inflight.abort() } catch (e) { /* 已结束则忽略 */ }
  }

  function setBusy(v) {
    busy = !!v
    els.go.disabled = busy
    els.intent.disabled = busy
    els.other.disabled = busy
    // 🔴 D-1b：忙时**不禁用**取消/关闭（否则投递卡住 ⇒ 弹窗关不掉）
    els.cancel.disabled = false
    els.close.disabled = false
  }

  /** 失败收尾：完整消息复制到剪贴板 + 记账 + 用户提示（B-6/B-8 已定的 UX；超时也走这条） */
  async function failToClipboard(when, ctx, intent, scopeLabel, message, msg) {
    var copied = await copyToClipboard(msg)
    appendLog(logLine(when, ctx.docName, intent, scopeLabel,
      '投递失败（' + message + '）· ' + (copied ? '已复制到剪贴板' : '复制失败')))
    els.progress.textContent = ''
    els.note.textContent = message + (copied
      ? '。完整消息已复制到剪贴板，请到 [DSH] 页找到「任务中心」会话手动粘贴。'
      : '。复制失败，请到 [DSH] 页手动粘贴。')
    say('投递失败' + (copied ? '，消息已复制到剪贴板' : '') + '（到 [DSH] 页手动粘贴）', true)
  }

  // ── ⑩ C5（形态 B）：落盘到远端工作区 与 需要用户拍板的一行 ──────────────────

  /**
   * 弹一条**需要用户决策**的行（复用 `#w-send-resolve` 那三个按钮槽位）。
   * @param {string} msg 说明文字
   * @param {Array<{label:string,value:string}>} choices 最多 3 项
   * @returns {Promise<string|null>} 被点按钮的 `value`；**关窗/被顶掉 ⇒ `null`（= 取消）**
   */
  function askResolve(msg, choices) {
    return new Promise(function (resolve) {
      var row = els.resolveRow
      if (!row) return resolve(null)
      // 🔴 复用同一行也服务于「提交给 agent」的 409：那条路径不在发送弹窗里 ⇒ 先把弹窗亮出来，
      //   否则 row 虽置为可见、却因祖先 `#w-send` 带 hidden 而根本不显示（点几次都没反应）。
      //   （发送路径本来就在弹窗里 ⇒ 这句是 no-op。）
      if (els.box) els.box.hidden = false
      if (resolveRef) resolveRef(null)            // 同时只允许一条 ⇒ 旧的判为取消
      els.resolveMsg.textContent = msg
      var slot = [els.resolve1, els.resolve2, els.resolve3]
      var done = false
      function finish(v) {
        if (done) return
        done = true
        if (resolveRef === finish) resolveRef = null
        row.hidden = true
        for (var i = 0; i < slot.length; i++) {
          if (!slot[i]) continue
          slot[i].hidden = true
          slot[i].onclick = null
        }
        resolve(v)
      }
      resolveRef = finish
      for (var i = 0; i < slot.length; i++) {
        var btn = slot[i]
        if (!btn) continue
        var c = choices && choices[i]
        if (!c) { btn.hidden = true; btn.onclick = null; continue }
        btn.hidden = false
        btn.textContent = c.label
        btn.onclick = (function (v) { return function () { finish(v) } })(c.value)
      }
      row.hidden = false
    })
  }

  /**
   * 落盘**一次**。不抛（网络异常由调用方的 AbortError 分支兜）。
   * @returns {Promise<{ok:boolean, conflict?:boolean, version?:string, created?:boolean,
   *                    relPath:string, error?:string}>}
   */
  async function postDraftSave(relPath, text, base, signal) {
    var body
    try {
      body = Send.buildDraftSaveBody({
        relPath: relPath,
        content: text,
        force: !!(base && base.force),
        baseVersion: base && base.baseVersion,
      })
    } catch (e) {
      return { ok: false, relPath: relPath, error: (e && e.message) || String(e) }
    }
    var res = await fetch(DRAFT_SAVE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal,
    })
    var raw = ''
    try { raw = await res.text() } catch (e) { /* 无体 */ }
    var json = null
    try { json = raw ? JSON.parse(raw) : null } catch (e) { json = null }
    var out = Send.readDraftSaveResult(res.status, json)
    out.relPath = relPath
    if (!out.ok && !out.conflict) {
      out.error = 'HTTP ' + res.status + '：' +
        ((json && (json.error || json.code)) || String(raw).slice(0, 200) || '（空响应）')
    }
    return out
  }

  /**
   * 把当前正文落到**客户端区**（拿 `relPath` + `version`）。冲突（409）⇒ **弹三选**。
   * @returns {Promise<{ok:boolean, canceled?:boolean, relPath?:string, version?:string, error?:string}>}
   */
  async function saveDraft(ctx, pending, ctl) {
    var rel = Send.draftRelPath({ work: ctx.workName, docName: ctx.docName })
    var text = pending.text || ''
    var cached = versionCache[rel]
    var r = await postDraftSave(rel, text, cached ? { baseVersion: cached } : null, ctl.signal)
    if (!r.ok && r.conflict) {
      // 409：远端已有同名稿件，而我们手上没有（或不是）它当前的 version
      els.progress.textContent = ''
      var alt = Send.altDraftName(ctx.docName, new Date())
      var dir = rel.slice(0, rel.lastIndexOf('/') + 1)
      var pick = await askResolve(
        Send.displayPath(rel) + ' 已有《' + Send.stripMd(Send.baseSeg(ctx.docName)) +
        '》，且版本与本地记录不一致 —— 怎么处理？',
        [
          { label: '覆盖远端', value: 'overwrite' },
          { label: '另存为 ' + alt, value: 'saveas' },
          { label: '取消', value: 'cancel' },
        ])
      if (pick === 'overwrite') {
        els.progress.textContent = '覆盖中…'
        r = await postDraftSave(rel, text, { force: true }, ctl.signal)
      } else if (pick === 'saveas') {
        els.progress.textContent = '另存中…'
        r = await postDraftSave(dir + alt, text, null, ctl.signal)
      } else {
        return { ok: false, canceled: true, relPath: rel, error: '已取消：远端已有同名稿件且版本不一致' }
      }
    }
    return r
  }

  // ── 「提交给 agent」（C12）：把客户端区的当前稿**复制**进 `写作训练/草稿/…` ────────────
  //
  // 背景（2026-09-29）：客户端读写从 agent 工作区**分离**到平级的 `客户端区/`（agent 不自动看见）。
  // 用户觉得该给 agent 看时，主动点「提交给 agent」⇒ 服务端把 `客户端区/正文/<作品>/<文档>.md`
  // **复制**进 `写作训练/草稿/<作品>/<文档>.md`（`客户端区/` 里的源**保留**）。
  //
  // 🔴 409（落点已有、且版本不一致）复用**既有 C5 三选**（覆盖 / 另存为 / 取消）—— 见 askResolve()。
  //   「另存为」= 先把当前稿在 `客户端区/正文/` 下另存一份新名，再提交它（否则 submit 的源不存在 ⇒ 404）。

  /**
   * 调一次「提交」。**不抛**（网络异常由调用方兜）。
   * @returns {Promise<{ok:boolean, conflict?:boolean, notFound?:boolean, path?:string, error?:string}>}
   */
  async function postSubmit(work, doc, base, signal) {
    var body
    try {
      body = Send.buildSubmitBody({
        work: work,
        doc: doc,
        force: !!(base && base.force),
        baseVersion: base && base.baseVersion,
      })
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
    var res = await fetch(SUBMIT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal,
    })
    var raw = ''
    try { raw = await res.text() } catch (e) { /* 无体 */ }
    var json = null
    try { json = raw ? JSON.parse(raw) : null } catch (e) { json = null }
    var out = Send.readSubmitResult(res.status, json)
    if (!out.ok && !out.conflict && !out.notFound) {
      out.error = 'HTTP ' + res.status + '：' +
        ((json && (json.error || json.code)) || String(raw).slice(0, 200) || '（空响应）')
    }
    return out
  }

  /** 「提交给 agent」入口：对**当前打开的稿**调 `submit({work, doc})`；409 走既有 C5 三选 */
  async function submitCurrent() {
    if (busy) return
    var b = bridge()
    if (!b || !b.context) { say('发送模块尚未就绪', true); return }
    var ctx = b.context()
    if (!ctx) { say('请先打开一个文档', true); return }

    var ctl = new AbortController()
    var wasBoxHidden = els.box ? els.box.hidden : true
    setBusy(true)
    inflight = ctl
    var timedOut = false
    var timer = setTimeout(function () { timedOut = true; abortInflight() }, SEND_TIMEOUT_MS)

    /** 提交成功后的统一收尾：给明确反馈（含落点 `写作训练/草稿/…`） */
    function done(r) {
      var where = r.path || ('写作训练/草稿/' + (ctx.workName ? ctx.workName + '/' : '') +
        Send.stripMd(Send.baseSeg(ctx.docName)) + '.md')
      els.progress.textContent = ''
      els.note.textContent = '已提交给 agent：' + where + (r.created ? '（新建）' : '（已更新）')
      say('已提交给 agent：' + where)
      els.box.hidden = true
    }

    try {
      // 先把本地未保存内容落盘（并触发上行），否则客户端区里的源可能是旧的 / 根本不存在
      if (b.flush) {
        els.progress.textContent = '保存本地…'
        var f = await b.flush()
        if (!f || !f.ok) throw new Error('本地保存失败，已中止提交：' + ((f && f.error) || '未知错误'))
      }
      els.progress.textContent = '提交中…'
      var r = await postSubmit(ctx.workName, ctx.docName, null, ctl.signal)

      if (r.ok) { done(r); return }

      if (r.notFound) {
        els.progress.textContent = ''
        var src = Send.displayPath(Send.draftRelPath({ work: ctx.workName, docName: ctx.docName }))
        els.note.textContent = '提交失败：服务器上还没有这份（' + src +
          '）—— 请先「保存」、等同步完成后再提交'
        say('提交失败：客户端区里还没有《' + Send.stripMd(Send.baseSeg(ctx.docName)) + '》', true)
        return
      }

      if (r.conflict) {
        // 🔴 复用既有 C5 三选（覆盖 / 另存为 / 取消）
        els.progress.textContent = ''
        var alt = Send.altDraftName(ctx.docName, new Date())
        var pick = await askResolve(
          '「写作训练/草稿」里已有《' + Send.stripMd(Send.baseSeg(ctx.docName)) +
          '》，且版本与本地不一致 —— 怎么处理？',
          [
            { label: '覆盖远端', value: 'overwrite' },
            { label: '另存为 ' + alt, value: 'saveas' },
            { label: '取消', value: 'cancel' },
          ])
        if (pick === 'overwrite') {
          els.progress.textContent = '覆盖中…'
          r = await postSubmit(ctx.workName, ctx.docName, { force: true }, ctl.signal)
        } else if (pick === 'saveas') {
          els.progress.textContent = '另存并提交中…'
          // 先在客户端区另存一份新名（否则 submit 的源不存在 ⇒ 404），再提交它
          var altRel = Send.draftRelPath({ work: ctx.workName, docName: alt })
          var text = b.text ? (b.text() || '') : ''
          var saved = await postDraftSave(altRel, text, null, ctl.signal)
          if (!saved || !saved.ok) {
            els.note.textContent = '另存失败：' + ((saved && saved.error) || '未知错误')
            els.progress.textContent = ''
            say('另存失败，未提交', true)
            return
          }
          r = await postSubmit(ctx.workName, alt, null, ctl.signal)
        } else {
          els.note.textContent = '已取消提交'
          els.progress.textContent = ''
          say('已取消提交', true)
          return
        }
        if (r.ok) { done(r); return }
        els.progress.textContent = ''
        els.note.textContent = '提交失败：' + (r.notFound ? '客户端区里没有这份源稿' : (r.error || '未知错误'))
        say('提交失败：' + (r.error || '未知错误'), true)
        return
      }

      els.progress.textContent = ''
      els.note.textContent = '提交失败：' + (r.error || '未知错误')
      say('提交失败：' + (r.error || '未知错误'), true)
    } catch (e) {
      els.progress.textContent = ''
      if (isAbort(e)) {
        els.note.textContent = timedOut ? '提交超时（' + (SEND_TIMEOUT_MS / 1000) + ' 秒）' : '已取消提交'
        say(els.note.textContent, true)
        return
      }
      var m = (e && e.message) || String(e)
      els.note.textContent = m
      say('提交中止：' + m, true)
    } finally {
      clearTimeout(timer)
      if (inflight === ctl) inflight = null
      setBusy(false)
      // 只是因为冲突才被临时亮出来的弹窗 ⇒ 收尾时还原（原本就开着的发送弹窗不动）
      if (wasBoxHidden && els.box && !resolveRef) els.box.hidden = true
    }
  }

  async function doSend() {
    if (busy || !pending) return
    var intent = currentIntent()
    if (!intent) { els.note.textContent = '请填写诉求（选「其他…」时必填）'; return }

    var ctx = pending.ctx
    var scope = pending.scope
    var body = scope === 'selection' ? pending.selected : (pending.text || '')
    var n = Send.countChars(body)
    // 🔴 D-4：空白拒发（渲染层不弹窗 + 这里再兜一道，防"约 0 字"空壳消息）
    if (n === 0) {
      els.note.textContent = scope === 'selection' ? '选中段为空（只有空白），无法发送' : '正文为空，无法发送'
      return
    }
    var scopeLabel = (scope === 'selection' ? '选中段' : '全文') + '（约 ' + n + ' 字）'

    // ⚠️ 消息**不再在这里组装**：⑩ C5 的形态 B 需要"落盘后的 `relPath` + `version`"，那要等 HTTP 回来。
    //   （原来放在 `setBusy` 之前，只是为了让"模板参数非法"不进入忙碌态；那类错误现在由上面两道
    //    前置校验 + `buildMessage` 自身的抛错在 try 里兜住，用户看到的提示一样。）
    var msg = ''   // 形态由 channel 决定、稍后才赋值；先给空串 ⇒ catch 里的剪贴板回退拿到的永远是字符串
    setBusy(true)
    var b = bridge()
    var ctl = new AbortController()
    var timedOut = false
    inflight = ctl
    var timer = setTimeout(function () {
      timedOut = true
      abortInflight()
    }, SEND_TIMEOUT_MS)

    try {
      // ① 先把本地未保存内容落到工作区（失败 ⇒ 中止，fail-closed）
      if (b && b.flush) {
        els.progress.textContent = '保存本地…'
        var f = await b.flush()
        if (!f || !f.ok) throw new Error('本地保存失败，已中止发送：' + ((f && f.error) || '未知错误'))
      }
      // ② ⑩ C5 形态 B：把稿件落到**远端工作区**（拿 `relPath` + `version`）
      //    ⇒ 消息里**只发路径、不发正文**（省 token 的关键）。
      //    落盘失败 ⇒ **中止发送（fail-closed）**，**不自动降级**；出口只有用户显式选「改用内联发送」。
      var save = null
      if (channelChose !== 'inline') {
        els.progress.textContent = '保存到客户端区…'
        save = await saveDraft(ctx, pending, ctl)
        if (save && save.ok) versionCache[save.relPath] = save.version
      }
      if (save && save.canceled) {
        // 冲突三选里点了「取消」⇒ 当作正常中止（不是失败，不弹"改用内联"）
        els.progress.textContent = ''
        var cm = save.error || '已取消'
        els.note.textContent = cm
        say('未发送：' + cm, true)
        appendLog(logLine(stamp(), ctx.docName, intent, scopeLabel, '未发送（' + cm + '）'))
        return
      }
      var channel = Send.resolveChannel({ userChose: channelChose, draftSaveOk: !!(save && save.ok) })
      if (!channel) {
        var de = new Error((save && save.error) || '未知错误')
        de.draftSaveFailed = true
        throw de
      }

      // ③ 组装消息：`path` ⇒ **只有路径 + 版本**；`inline` ⇒ 正文内联（+ 选中段场景照旧内联选中段）
      var msg = Send.buildMessage({
        docName: ctx.docName,
        intent: intent,
        scope: scope,
        text: pending.text,
        selectedText: pending.selected,
        channel: channel,
        // 🔴 形参名必须是 `relPath`（`buildMessage` 的契约）—— C5 联调实测抓到过传 `remotePath` 的写法：
        //   结果是形态 B **每次抛「缺少远端路径」**、消息发不出去，而单测全绿（只测了 buildMessage 本身）。
        //   防回归见 `send-net-wiring.test.js`。
        relPath: channel === 'path' ? save.relPath : undefined,
        version: channel === 'path' ? save.version : undefined,
      })

      // ④ 投递（带超时/可取消信号）
      els.progress.textContent = '投递中…（最长 ' + (SEND_TIMEOUT_MS / 1000) + ' 秒）'
      var d = await deliver(msg, ctl.signal)
      var when = stamp()
      if (d.ok) {
        els.progress.textContent = ''
        say('已发送 ' + when.slice(11))
        appendLog(logLine(when, ctx.docName, intent, scopeLabel, '已送达任务中心'))
        els.box.hidden = true
        pending = null
      } else {
        // 三个配置类错误（MISSING/ARCHIVED/UNREACHABLE）⇒ 只弹提示、记账，**不复制剪贴板**；
        // 其余（含 HTTP_* / 网络失败）⇒ 完整消息复制到剪贴板 + 提示手动粘贴。
        var cfgMsg = relayMessage(d.code)
        if (cfgMsg) {
          els.progress.textContent = ''
          els.note.textContent = cfgMsg
          say(cfgMsg, true)
          appendLog(logLine(when, ctx.docName, intent, scopeLabel, '未发送（' + cfgMsg + '）'))
        } else {
          await failToClipboard(when, ctx, intent, scopeLabel, d.message, msg)
        }
      }
    } catch (e) {
      var when2 = stamp()
      if (isAbort(e)) {
        // D-1a / D-1b：超时 或 用户取消。
        // ⚠️ **本地中止 ≠ 服务器没收到**（请求可能已进网关）⇒ 记账如实写，不谎称"没发出去"。
        if (timedOut) {
          await failToClipboard(when2, ctx, intent, scopeLabel,
            '投递超时（' + (SEND_TIMEOUT_MS / 1000) + ' 秒）', msg)
        } else {
          els.progress.textContent = ''
          els.note.textContent = '已取消投递'
          say('已取消投递', true)
          appendLog(logLine(when2, ctx.docName, intent, scopeLabel,
            '已取消投递（本地中止等待，服务器可能已收到）'))
        }
        // 取消 ⇒ 关窗；超时 ⇒ **保持开窗**（让用户看到"超时 + 已复制到剪贴板"）
        if (!timedOut) { els.box.hidden = true; pending = null }
      } else if (e && e.draftSaveFailed) {
        // ⑩ C5：**落盘失败 ⇒ fail-closed（不自动降级）**，只给用户一个**显式出口**
        // ⚠️ 自己算消息：`var m` 是**下面那个 else 分支**里的，这里拿会得到 undefined
        var dm = (e && e.message) || String(e)
        els.progress.textContent = ''
        els.note.textContent = '未发送：' + dm
        say('未发送：落盘失败', true)
        appendLog(logLine(when2, ctx.docName, intent, scopeLabel, '未发送（落盘失败：' + dm + '）'))
        var pick2 = await askResolve('要改用「内联发送」吗？正文会整篇进消息（这一次不落盘）。', [
          { label: '改用内联发送', value: 'inline' },
          { label: '取消', value: 'cancel' },
        ])
        if (pick2 === 'inline') {
          channelChose = 'inline'
          els.note.textContent = '已切换为「内联发送」—— 请再点一次「发送」'
        }
      } else {
        var m = (e && e.message) || String(e)
        els.note.textContent = m
        els.progress.textContent = ''
        say('发送中止：' + m, true)
        appendLog(logLine(when2, ctx.docName, intent, scopeLabel, '已中止（' + m + '）'))
      }
    } finally {
      clearTimeout(timer)
      if (inflight === ctl) inflight = null
      setBusy(false)
    }
  }

  // ── 事件接线 ────────────────────────────────────────────────────────────

  function refreshSelBtn() {
    if (!els.selBtn) return
    var b = bridge()
    var has = !!(b && b.selection && b.selection())
    els.selBtn.disabled = !has
  }

  function wire() {
    if (els.fullBtn) els.fullBtn.addEventListener('click', function () { openSend('full') })
    if (els.selBtn) els.selBtn.addEventListener('click', function () { openSend('selection') })
    if (els.submitBtn) els.submitBtn.addEventListener('click', submitCurrent)
    if (els.close) els.close.addEventListener('click', closeSend)
    if (els.cancel) els.cancel.addEventListener('click', closeSend)
    if (els.selClear) els.selClear.addEventListener('click', clearSelection)
    if (els.go) els.go.addEventListener('click', doSend)

    if (els.intent) {
      els.intent.addEventListener('change', function () {
        var other = els.intent.value === INTENT_OTHER
        els.otherRow.hidden = !other
        if (other) els.other.focus()
      })
    }
    // ⑨「＋ 存为常用」（用户 2026-09-28：诉求预设可自定义）
    if (els.saveIntent) {
      els.saveIntent.addEventListener('click', saveCurrentIntentAsPreset)
    }
    if (els.box) {
      els.box.addEventListener('click', function (e) { if (e.target === els.box) closeSend() })
    }

    // 选区变化 ⇒ 决定「发送选中段」是否可用（textarea 的选区变化在 Chromium 会触发 selectionchange）
    document.addEventListener('selectionchange', refreshSelBtn)
    document.addEventListener('keyup', refreshSelBtn)
    document.addEventListener('mouseup', refreshSelBtn)
    document.addEventListener('input', refreshSelBtn)
    setInterval(refreshSelBtn, 1000)

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return
      if (els.box && !els.box.hidden) closeSend()
    })
  }

  function init() {
    if (!Send) { console.error('[wc-send] send.js 未加载（window.WCSend 缺失）'); return }
    collectEls()
    if (!els.fullBtn || !els.box) { console.error('[wc-send] 发送 UI 未找到（按钮/弹窗缺失）'); return }
    wire()
    refreshSelBtn()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
