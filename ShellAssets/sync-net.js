'use strict'

// ============================================================================
// ⑪ C11 · 多端文档同步的**渲染层链路**（同源 fetch → 回环反代 → 网关 → 内核插件）
//
// 设计：docs/superpowers/plans/2026-09-29-multidevice-doc-sync-design.md §4
// 纯逻辑在 `sync-core.js`（三态判定/版本/基线）；本文件**只负责发请求与解析**，不抛异常到调用方。
//
// 🔴 三条口径：
//   1. **同源相对路径**：壳页与反代同源（`http://127.0.0.1:<port>`）⇒ 相对 URL 自动带 Cookie
//      （与 `send-net.js` 的 `DRAFT_SAVE_PATH` 同一套做法，不自己拼网关地址）。
//   2. **失败一律回 `{ok:false, error}`**，绝不抛 ⇒ 调用方按"远端未知"处理（**不是**"远端没有"）。
//   3. **非阻塞**：这些调用都在"文档已经打开之后"后台跑（Funnel 单次请求实测 1.6–2.9 s，
//      拿它挡住"打开文档"不可接受）⇒ 超时给得比探测宽松。
//
// ⚠️ 四个 `clientZone*` 端点若未上线，这里会拿到 404 / 非 JSON ⇒ 稳定的 `{ok:false}` ⇒
//    前端如实显示"远端未知"，**不会**误导成"远端没有这份"。
// ============================================================================

// UMD 壳（写法同 sync-core.js）：浏览器挂 window.WCSyncNet；Node（node --test）只导出
// 纯函数 toBoardRemoteRel 供单测 —— 网络层函数依赖浏览器环境，不进 Node 导出。
;(function (root, factory) {
  var mod = factory(root)
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { toBoardRemoteRel: mod.toBoardRemoteRel }
  } else {
    root.WCSyncNet = mod
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict'

  // root 在浏览器即 window；Node 下这三项为 undefined（纯函数不依赖它们，单测安全）
  var Sync = root.WCSync
  var api = root.wcStorage
  var Send = root.WCSend // 复用「发送给任务中心」那份落盘信封（`clientZoneSave`；不另造一套方言）

  // ── 端点（一处可改）────────────────────────────────────────────────────
  // 🔴 2026-09-29 起客户端读写的是与 `写作训练/` **平级**的 `客户端区/`（agent 不自动看见）：
  //   四个端点都换成 clientZone*；请求里的 `relPath` **相对 `客户端区/`**，不带前缀。
  var LIST_PATH = '/writing-studio/api/clientZoneList'
  var READ_PATH = '/writing-studio/api/clientZoneRead'
  var DELETE_PATH = '/writing-studio/api/clientZoneDelete'
  var SAVE_PATH = '/writing-studio/api/clientZoneSave'

  var LIST_TIMEOUT_MS = 8000
  var READ_TIMEOUT_MS = 20000
  var SAVE_TIMEOUT_MS = 20000

  function bridge() { return root.__wcSyncBridge || null }

  /** 统一提示出口（有桥走桥，没有就 console —— 与 send-net 同口径） */
  function say(text, isError) {
    var b = bridge()
    if (b && b.notice) b.notice(text, isError)
    else console.error('[wc-sync] ' + text)
  }

  /**
   * 带超时的 GET，**返回 `{status, json, raw}`；网络/超时 ⇒ 抛**（由调用方 catch 成 `{ok:false}`）。
   * @param {string} url 同源相对路径
   * @param {number} timeoutMs
   * @param {AbortSignal} [outer] 外部取消信号
   */
  async function getJson(url, timeoutMs, outer) {
    var ctl = new AbortController()
    var timer = setTimeout(function () { ctl.abort() }, timeoutMs)
    var onOuter = function () { ctl.abort() }
    if (outer) {
      if (outer.aborted) ctl.abort()
      else outer.addEventListener('abort', onOuter)
    }
    try {
      var res = await fetch(url, { method: 'GET', signal: ctl.signal, credentials: 'same-origin' })
      var raw = ''
      try { raw = await res.text() } catch (e) { /* 无体 */ }
      var json = null
      try { json = raw ? JSON.parse(raw) : null } catch (e) { json = null }
      return { status: res.status, json: json, raw: raw }
    } finally {
      clearTimeout(timer)
      if (outer) outer.removeEventListener('abort', onOuter)
    }
  }

  /** 把一次 HTTP 往返整理成稳定的 `{ok, ...}`；**永不抛** */
  function shape(status, json, raw, timeoutMs) {
    if (json && typeof json === 'object') {
      var ok = json.ok === true
      return { ok: ok, status: status, data: json, error: ok ? '' : (json.error || json.code || ('HTTP ' + status)) }
    }
    return {
      ok: false,
      status: status,
      data: null,
      error: 'HTTP ' + status + '：' + String(raw || '').slice(0, 200) + (status === 0 ? '' : ''),
    }
  }

  /**
   * 拉远端草稿清单（元数据，无正文）。
   * @returns {Promise<{ok:boolean, status?:number, data?:object, error?:string}>}
   *   🔴 `ok:false` ⇒ 调用方必须当成 **远端未知**（`WCSync.indexList` 会给 `known:false`）
   */
  async function listDrafts(opts) {
    var o = opts || {}
    var t = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : LIST_TIMEOUT_MS
    try {
      var r = await getJson(LIST_PATH, t, o.signal)
      return shape(r.status, r.json, r.raw, t)
    } catch (e) {
      return { ok: false, status: 0, data: null, error: (e && e.message) || String(e) }
    }
  }

  /**
   * 按**本地 relPath** 读回远端正文。
   * @param {string} localRel 形如 `作品甲/第一章.md`（函数内部换算成远端全路径）
   * @returns {Promise<{ok:boolean, content?:string, version?:string, bytes?:number, mtime?:string,
   *                    status?:number, notFound?:boolean, error?:string}>}
   */
  async function readDraft(localRel, opts) {
    var o = opts || {}
    var remoteRel = Sync.toRemoteRel(localRel)
    if (!remoteRel) return { ok: false, error: 'BadRequest: 非法 relPath ' + String(localRel) }
    var t = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : READ_TIMEOUT_MS
    var url = READ_PATH + '?relPath=' + encodeURIComponent(remoteRel)
    try {
      var r = await getJson(url, t, o.signal)
      if (r.status === 404) return { ok: false, notFound: true, status: 404, error: '远端不存在该文档' }
      var s = shape(r.status, r.json, r.raw, t)
      if (!s.ok) return s
      var d = s.data || {}
      if (typeof d.content !== 'string') {
        return { ok: false, status: r.status, error: '响应缺少 content 字段（契约不符）' }
      }
      return {
        ok: true,
        content: d.content,
        version: typeof d.version === 'string' ? d.version : '',
        bytes: Number(d.bytes) || 0,
        mtime: d.mtime || null,
      }
    } catch (e) {
      return { ok: false, status: 0, error: (e && e.message) || String(e) }
    }
  }

  /**
   * 请求**软删**远端某篇（`clientZoneDelete`）。
   * 🔴 语义：**服务端软删** —— 把件搬到 `客户端区/回收/<原路径>`，**永不真删**。
   *    客户端**不再写墓碑**（服务端已软删）；`sync-core.indexList` 仅保留**读墓碑**的兼容路径，
   *    不破坏既有数据（详见 sync-core.js 顶部注释）。
   * @param {string} localRel
   * @param {{signal?:AbortSignal}} [opts] （`baseVersion`/`device` 已不被新端点使用，保留形参不破坏调用方）
   */
  async function deleteDraft(localRel, opts) {
    var o = opts || {}
    var remoteRel = Sync.toRemoteRel(localRel)
    if (!remoteRel) return { ok: false, error: 'BadRequest: 非法 relPath' }
    var body = { relPath: remoteRel }
    var ctl = new AbortController()
    var timer = setTimeout(function () { ctl.abort() }, LIST_TIMEOUT_MS)
    try {
      var res = await fetch(DELETE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: o.signal || ctl.signal,
        credentials: 'same-origin',
      })
      var raw = ''
      try { raw = await res.text() } catch (e) { /* 无体 */ }
      var json = null
      try { json = raw ? JSON.parse(raw) : null } catch (e) { json = null }
      return shape(res.status, json, raw, LIST_TIMEOUT_MS)
    } catch (e) {
      return { ok: false, status: 0, error: (e && e.message) || String(e) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * **保存即推**（上行）：把本地正文推到服务器 `客户端区/正文/…`。与「发送给任务中心」**同一端点、同一信封**
   * （`Send.buildDraftSaveBody` / `Send.readDraftSaveResult`）⇒ 不另造一套方言、服务端也只有一条写路径。
   *
   * 🔴 调用方（`writing.js` 的 `syncPushNow`）负责"该不该推"的判据（在 `sync-core.js::decidePush`）；
   *    这里只负责发请求 + 解析，**永不抛**。
   *
   * @param {string} localRel 本地相对路径（`作品/文档.md`）
   * @param {string} content
   * @param {{baseVersion?:string, force?:boolean, signal?:AbortSignal}} [opts]
   * @returns {Promise<{ok:boolean, conflict?:boolean, version?:string, created?:boolean, status?:number, error?:string}>}
   *   `conflict:true` ⇒ 409（远端版本与我们给的不符）⇒ 调用方**绝不能**自动 force 覆盖，必须交用户决策
   */
  async function saveDraft(localRel, content, opts) {
    var o = opts || {}
    var remoteRel = Sync.toRemoteRel(localRel)
    if (!remoteRel) return { ok: false, error: 'BadRequest: 非法 relPath ' + String(localRel) }
    var text = String(content === undefined || content === null ? '' : content)
    var body
    try {
      if (Send && typeof Send.buildDraftSaveBody === 'function') {
        body = Send.buildDraftSaveBody({ relPath: remoteRel, content: text, baseVersion: o.baseVersion, force: o.force === true })
      } else {
        // 兜底：与 Send.buildDraftSaveBody 同口径（send.js 未加载时的最后手段）
        body = { relPath: remoteRel, content: text }
        if (o.force === true) body.force = true
        else if (o.baseVersion) body.baseVersion = String(o.baseVersion)
      }
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
    var ctl = new AbortController()
    var timer = setTimeout(function () { ctl.abort() }, SAVE_TIMEOUT_MS)
    try {
      var res = await fetch(SAVE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: o.signal || ctl.signal,
        credentials: 'same-origin',
      })
      var raw = ''
      try { raw = await res.text() } catch (e) { /* 无体 */ }
      var json = null
      try { json = raw ? JSON.parse(raw) : null } catch (e) { json = null }
      if (Send && typeof Send.readDraftSaveResult === 'function') {
        return Object.assign(Send.readDraftSaveResult(res.status, json), { status: res.status })
      }
      if (res.status === 200 && json && json.ok === true) {
        return { ok: true, version: json.version || '', created: json.created === true, status: 200 }
      }
      if (res.status === 409 || (json && json.code === 'VERSION_CONFLICT')) {
        return { ok: false, conflict: true, status: 409, error: (json && json.error) || 'VERSION_CONFLICT' }
      }
      return { ok: false, status: res.status, error: (json && (json.error || json.code)) || ('HTTP ' + res.status) }
    } catch (e) {
      return { ok: false, status: 0, error: (e && e.message) || String(e) }
    } finally {
      clearTimeout(timer)
    }
  }

  // ==========================================================================
  // 记录板（设计 docs/board-and-noveldb-design.md §1.3/§1.4）
  // 远端落点：客户端区/进度/board/<作品>/<文档>.json（进度子域只收 .json）
  // ==========================================================================

  var BOARD_ROOT = '进度/board/'

  /**
   * 本地正文 relPath → 记录板远端 relPath：`作品甲/第一章.md` → `进度/board/作品甲/第一章.json`
   * 非法（空/绝对路径/含 .. 路径段/非 .md）一律返回 null。纯函数，Node 下可单测。
   */
  function toBoardRemoteRel(localRel) {
    if (typeof localRel !== 'string') return null
    var s = localRel
    if (!s) return null
    if (s.charAt(0) === '/' || s.charAt(0) === '\\') return null // 绝对路径拒绝
    // 拆路径段：任一段为 .. / . 或为空（双斜杠）都拒绝，防越出 进度/board/
    var parts = s.split(/[\\/]/)
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..' || parts[i] === '.' || parts[i] === '') return null
    }
    if (!/\.md$/i.test(s)) return null // 记录板只绑定正文 .md
    return BOARD_ROOT + s.slice(0, -3) + '.json'
  }

  /**
   * 保存某篇文档的记录板数据（笔记/待办）到远端。走裸信封 `{relPath, content}`
   * （进度 json 不走 Send 的正文信封）。永不抛。
   * @returns {Promise<{ok:boolean, conflict?:boolean, version?:string, status?:number, error?:string}>}
   */
  async function saveBoard(localRel, json) {
    var remoteRel = toBoardRemoteRel(localRel)
    if (!remoteRel) return { ok: false, error: 'BadRequest: 非法 relPath ' + String(localRel) }
    var content
    try { content = JSON.stringify(json) } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
    var body = { relPath: remoteRel, content: content }
    var ctl = new AbortController()
    var timer = setTimeout(function () { ctl.abort() }, SAVE_TIMEOUT_MS)
    try {
      var res = await fetch(SAVE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
        credentials: 'same-origin',
      })
      var raw = ''
      try { raw = await res.text() } catch (e) { /* 无体 */ }
      var data = null
      try { data = raw ? JSON.parse(raw) : null } catch (e) { data = null }
      if (res.status === 200 && data && data.ok === true) {
        return { ok: true, conflict: false, version: typeof data.version === 'string' ? data.version : '', status: 200 }
      }
      if (res.status === 409 || (data && data.code === 'VERSION_CONFLICT')) {
        return { ok: false, conflict: true, version: typeof (data && data.version) === 'string' ? data.version : '', status: 409, error: (data && data.error) || 'VERSION_CONFLICT' }
      }
      return { ok: false, conflict: false, status: res.status, error: (data && (data.error || data.code)) || ('HTTP ' + res.status) }
    } catch (e) {
      return { ok: false, conflict: false, status: 0, error: (e && e.message) || String(e) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 读回某篇文档的记录板数据。永不抛。
   * 404 视为「远端还没记过」⇒ `{ok:true, json:null, notFound:true}`；
   * 内容 JSON.parse 失败 ⇒ `{ok:false, error}`（不静默吞坏数据）。
   * @returns {Promise<{ok:boolean, json?:object|null, notFound?:boolean, version?:string, error?:string}>}
   */
  async function readBoard(localRel) {
    var remoteRel = toBoardRemoteRel(localRel)
    if (!remoteRel) return { ok: false, error: 'BadRequest: 非法 relPath ' + String(localRel) }
    var url = READ_PATH + '?relPath=' + encodeURIComponent(remoteRel)
    try {
      var r = await getJson(url, READ_TIMEOUT_MS)
      if (r.status === 404) return { ok: true, json: null, notFound: true }
      var s = shape(r.status, r.json, r.raw, READ_TIMEOUT_MS)
      if (!s.ok) return { ok: false, status: r.status, error: s.error }
      var d = s.data || {}
      if (typeof d.content !== 'string') {
        return { ok: false, status: r.status, error: '响应缺少 content 字段（契约不符）' }
      }
      var parsed
      try { parsed = JSON.parse(d.content) } catch (e) {
        return { ok: false, status: r.status, error: '记录板 JSON 解析失败：' + ((e && e.message) || String(e)) }
      }
      return { ok: true, json: parsed, version: typeof d.version === 'string' ? d.version : '' }
    } catch (e) {
      return { ok: false, status: 0, error: (e && e.message) || String(e) }
    }
  }

  return {
    LIST_PATH: LIST_PATH,
    READ_PATH: READ_PATH,
    DELETE_PATH: DELETE_PATH,
    SAVE_PATH: SAVE_PATH,
    listDrafts: listDrafts,
    readDraft: readDraft,
    saveDraft: saveDraft,
    deleteDraft: deleteDraft,
    toBoardRemoteRel: toBoardRemoteRel,
    saveBoard: saveBoard,
    readBoard: readBoard,
    say: say,
  }
})
