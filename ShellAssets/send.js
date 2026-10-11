'use strict'

// ============================================================================
// 写作客户端 · 「发送给任务中心」纯逻辑（阶段⑤ → C5 两形态）
//
// 定位：**零依赖、可被 node 直接 require** 的纯函数集合（写法参考本仓 guard.js）：
//   · buildMessage        —— 消息模板，**两形态**：A 正文内联 / B 提示词 + 服务器相对路径
//   · draftRelPath        —— 形态 B 的远端相对路径（相对 `客户端区/`：`正文/<作品>/<文档名>.md`）
//   · buildDraftSaveBody  —— 形态 B 的落盘请求体（POST /writing-studio/api/clientZoneSave）
//   · readDraftSaveResult —— 解析落盘响应（ok+version / 409 冲突 / 其它错误）
//   · buildSubmitBody / readSubmitResult —— 「提交给 agent」（POST /writing-studio/api/submit，
//     把 `客户端区/正文/<作品>/<文档名>.md` 复制进 `写作训练/草稿/…`）的请求体与响应解析
//   · displayPath         —— 端点参数（相对 `客户端区/`）→ **给人看**的路径（`客户端区/…`）
//   · altDraftName        —— 409 里「另存为」的备用文件名（`<doc>-YYYYMMDD-HHmm.md`）
//   · resolveChannel      —— 一处开关：落盘可用 ⇒ path；否则 **fail-closed**（不自动降级）
//   · countChars / buildEnvelope / parseMissingParam —— 与阶段⑤ 同
//
// ⚠️ 本模块同时要**被壳页当 <script> 加载**（同源 `/__shell__/send.js`）⇒ 外面套一层
//   极薄 UMD：node 下走 `module.exports`，浏览器下挂 `window.WCSend`。这样渲染层与
//   单元测试跑的是**同一份**逻辑，不做任何复制。
//
// 🔴 硬约束：
//   ① **形态 A（inline，历史行为，保留为手选备选）**：正文内联，模板里**不得出现「远端文件」字样**
//      —— 首版时内核工作区文件服务只读、没有可写的远端落点（设计 §5.2 ④ 的当时口径）；
//   ② **形态 B（path，C5 起为默认）**：前提是 `POST /writing-studio/api/clientZoneSave`
//      已把稿件落到 `客户端区/` 并拿到 `version`。模板给**相对路径 + 版本、不带正文**（省 token 的关键）；
//      **选中段场景仍必须内联选中段**（路径给的是整篇，不内联 agent 就不知道"针对哪一段"）；
//   ③ 模板**固定部分**不得出现反斜杠 `\`（文档名/作品名经 baseSeg 清洗，顺带挡掉 `a/b`、`../x`）；
//   ④ 正文/选中段用三引号包裹；内含 `"""` 做简单避让（见 escapeTripleQuotes）。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCSend = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  // ── 小工具 ──────────────────────────────────────────────────────────────

  /** 反斜杠一律视作分隔符，并去掉首尾空白 */
  function cleanSeg(s) {
    return String(s == null ? '' : s).replace(/\\/g, '/').trim()
  }

  /** 取路径的**最后一段**非空片段（顺带挡掉 `a/b`、`../x` 这类注入） */
  function baseSeg(s) {
    var parts = cleanSeg(s).split('/')
    var last = ''
    for (var i = 0; i < parts.length; i++) { if (parts[i]) last = parts[i] }
    return last
  }

  /** 去掉结尾的 .md（大小写不敏感） */
  function stripMd(name) {
    return String(name).replace(/\.md$/i, '')
  }

  /** 去掉所有空白后的字符数（消息、预览、记账共用同一算法） */
  function countChars(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').length
  }

  /**
   * 三引号避让：正文里若出现 `"""`，替换为 `\"\"\"`，避免提前闭合包裹块。
   * ⚠️ 只有正文含三引号时输出才可能出现反斜杠；模板固定部分恒无反斜杠。
   */
  function escapeTripleQuotes(s) {
    return String(s).split('"""').join('\\"\\"\\"')
  }

  // ── 形态 B（C5）：远端路径 / 落盘 / 冲突 ──────────────────────────────────

  // ════════════════════════════════════════════════════════════════════════
  // 🔴 2026-09-29 起：客户端读写的是与 `写作训练/` **平级**的 `客户端区/`（agent 不自动看见）。
  //   端点参数里的 relPath **相对 `客户端区/`**（第一段是 `正文`/`进度`/`回收`），
  //   **绝不能**带 `客户端区/` 前缀（带了服务端判 400 BAD_SUBDIR）。
  //   要给人看/写日志/冲突提示时，用 `displayPath()` 补上 `客户端区/` 前缀。
  // ════════════════════════════════════════════════════════════════════════

  /**
   * **端点参数**用的相对根（相对 `客户端区/`）—— 正文放 `正文/` 子目录。
   * ⚠️ 与 `sync-core.js` 的 `DRAFT_ROOT` 必须一致。
   */
  var DRAFT_ROOT = '正文/'

  /**
   * **只用于显示**的前缀（`客户端区/`）。🔴 别把它塞进任何端点参数里 ——
   * 服务端的 relPath 是相对 `客户端区/` 的，带前缀会被判 400。
   */
  var CLIENT_ZONE_ROOT = '客户端区/'

  /**
   * 端点用 relPath → 给人看的路径（`正文/x.md` ⇒ `客户端区/正文/x.md`）。
   * 已带 `客户端区/` 前缀的**原样返回**（幂等）；空 ⇒ 只回前缀。
   */
  function displayPath(relPath) {
    var rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '')
    if (!rel) return CLIENT_ZONE_ROOT
    if (rel === '客户端区' || rel.indexOf(CLIENT_ZONE_ROOT) === 0) return rel
    return CLIENT_ZONE_ROOT + rel
  }

  /**
   * 形态 B 的远端相对路径：`正文/<作品>/<文档名>.md`（相对**`客户端区/`**，一律 `/`）。
   * 作品名可省（省则直接落在 `正文/` 下）；两段都过 baseSeg 清洗 ⇒ 挡掉 `a/b`、`../x`、反斜杠。
   */
  function draftRelPath(opts) {
    opts = opts || {}
    var work = baseSeg(opts.work)
    var doc = stripMd(baseSeg(opts.docName))
    if (!doc) throw new Error('文档名为空，无法组装远端路径')
    return DRAFT_ROOT + (work ? work + '/' : '') + doc + '.md'
  }

  /**
   * 形态 B 的落盘请求体（契约 = `/writing-studio/api/clientZoneSave`）：
   * `{ relPath, content, baseVersion? , force? }` —— 二选一：`force:true` 强制覆盖，
   * 否则带 `baseVersion` 做乐观锁（对不上 ⇒ 409）。**两者都不带 ⇒ 仅当远端不存在才写**。
   * 🔴 `relPath` 相对 `客户端区/`（如 `正文/长夜/第三章.md`），**不带** `客户端区/` 前缀。
   */
  function buildDraftSaveBody(opts) {
    opts = opts || {}
    var rel = String(opts.relPath == null ? '' : opts.relPath).replace(/\\/g, '/')
    if (!rel) throw new Error('缺少 relPath')
    var body = { relPath: rel, content: opts.content == null ? '' : String(opts.content) }
    if (opts.force === true) body.force = true
    else if (opts.baseVersion) body.baseVersion = String(opts.baseVersion)
    return body
  }

  /**
   * 解析落盘响应。
   * · 200 + `ok:true` ⇒ `{ ok:true, version, path, created }`
   * · 409（或 `code==='VERSION_CONFLICT'`）⇒ `{ ok:false, conflict:true, error }` ← 调用方弹「三选」
   * · 其它 ⇒ `{ ok:false, conflict:false, error }`
   */
  function readDraftSaveResult(status, json) {
    var j = json && typeof json === 'object' ? json : {}
    var conflict = Number(status) === 409 || j.code === 'VERSION_CONFLICT'
    if (conflict) return { ok: false, conflict: true, error: j.error || 'VERSION_CONFLICT' }
    if (Number(status) === 200 && j.ok === true) {
      return {
        ok: true,
        conflict: false,
        version: j.version == null ? '' : String(j.version),
        path: j.path == null ? '' : String(j.path),
        created: j.created === true,
      }
    }
    return { ok: false, conflict: false, error: j.error || ('HTTP ' + status) }
  }

  // ── 「提交给 agent」（C12）：把 `客户端区/正文/<作品>/<文档名>.md` 复制进 `写作训练/草稿/…` ──

  /**
   * 「提交」请求体（契约 = `/writing-studio/api/submit`）：
   * `{ work, doc, deviceId?, baseVersion?, force? }`。
   * 🔴 源固定是 `客户端区/正文/<work>/<doc>.md` ⇒ `work`/`doc` 决定**源与落点**（服务端补 `.md`）。
   * 同样二选一：`force:true` 强制覆盖落点；否则带 `baseVersion` 乐观锁（对不上 ⇒ 409）。
   */
  function buildSubmitBody(opts) {
    opts = opts || {}
    var work = baseSeg(opts.work)
    var doc = stripMd(baseSeg(opts.doc))
    if (!doc) throw new Error('文档名为空，无法提交')
    var body = { work: work, doc: doc }
    if (opts.deviceId) body.deviceId = String(opts.deviceId)
    if (opts.force === true) body.force = true
    else if (opts.baseVersion) body.baseVersion = String(opts.baseVersion)
    return body
  }

  /**
   * 解析「提交」响应。
   * · 200 + `ok:true` ⇒ `{ ok:true, path, indexPath, version, bytes, created, action, supersedes, linksAdded, summary }`
   * · 409（或 `code==='VERSION_CONFLICT'`）⇒ `{ ok:false, conflict:true, path, currentVersion, version, error }` ← 弹「三选」
   * · 404（或 `code==='SOURCE_MISSING'`）⇒ `{ ok:false, notFound:true, error }`（源不在 `客户端区/正文/…`）
   * · 其它 ⇒ `{ ok:false, conflict:false, notFound:false, error }`
   */
  function readSubmitResult(status, json) {
    var j = json && typeof json === 'object' ? json : {}
    var s = Number(status)
    if (s === 409 || j.code === 'VERSION_CONFLICT') {
      return {
        ok: false,
        conflict: true,
        notFound: false,
        error: j.error || 'VERSION_CONFLICT',
        path: j.path == null ? '' : String(j.path),
        currentVersion: j.currentVersion == null ? '' : String(j.currentVersion),
        version: j.version == null ? '' : String(j.version),
      }
    }
    if (s === 404 || j.code === 'SOURCE_MISSING') {
      return { ok: false, conflict: false, notFound: true, error: j.error || 'SOURCE_MISSING' }
    }
    if (s === 200 && j.ok === true) {
      return {
        ok: true,
        conflict: false,
        notFound: false,
        path: j.path == null ? '' : String(j.path),
        indexPath: j.indexPath == null ? '' : String(j.indexPath),
        version: j.version == null ? '' : String(j.version),
        bytes: Number(j.bytes) || 0,
        created: j.created === true,
        action: j.action == null ? '' : String(j.action),
        supersedes: Array.isArray(j.supersedes) ? j.supersedes : [],
        linksAdded: Number(j.linksAdded) || 0,
        summary: j.summary == null ? '' : String(j.summary),
      }
    }
    return { ok: false, conflict: false, notFound: false, error: j.error || ('HTTP ' + status) }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n }

  /** 本地时间戳 `YYYYMMDD-HHmm`（`altDraftName` 用；不引任何日期库） */
  function stampOf(d) {
    var x = Object.prototype.toString.call(d) === '[object Date]' ? d : new Date()
    return String(x.getFullYear()) + pad2(x.getMonth() + 1) + pad2(x.getDate()) +
      '-' + pad2(x.getHours()) + pad2(x.getMinutes())
  }

  /** 409 里「另存为」的备用文件名：`<doc>-YYYYMMDD-HHmm.md`（**不自动去重**，同分钟再撞由用户再选） */
  function altDraftName(docName, d) {
    var doc = stripMd(baseSeg(docName))
    if (!doc) throw new Error('文档名为空，无法生成备用文件名')
    return doc + '-' + stampOf(d) + '.md'
  }

  /**
   * CHANNEL 裁决（计划 §3.2 的「一处开关，别做两套代码」）。
   * @returns `'path'` | `'inline'` | `null`
   *   · 用户显式选「内联发送」⇒ `'inline'`（显式备选，允许）；
   *   · 落盘成功 ⇒ `'path'`（C5 起的默认）；
   *   · 落盘失败且用户没手选 ⇒ **`null` = 中止发送**（fail-closed：同步失败一律中止，不做静默降级）。
   */
  function resolveChannel(opts) {
    opts = opts || {}
    if (opts.userChose === 'inline') return 'inline'
    if (opts.userChose === 'path') return opts.draftSaveOk === true ? 'path' : null
    return opts.draftSaveOk === true ? 'path' : null
  }

  // ── 诉求（意图）预设：可自定义（用户 2026-09-28 要求）────────────────────
  //
  // 起因：用户「一直在手填一种叫做**成果**的模式」⇒ 内置三项不够用。
  // 做法：预设列表变成**可配置**（落 `userData/config.json` 的 `send.intents`），
  //      发送弹窗的下拉由它驱动，另给「＋ 存为常用」一键把当前手填的存进去。
  // 边界：单项 ≤ {@link INTENT_MAX} 字；总量 ≤ {@link INTENTS_MAX} 条；
  //      **允许清空**（清空后下拉只剩「其他…」，由设置页文案说明）。

  /** 内置三项 = 加"可自定义"之前的行为（默认值与原行为逐项一致） */
  var DEFAULT_INTENTS = ['错字/病句检查', '结构诊断', '续写']
  var INTENT_MAX = 40
  var INTENTS_MAX = 20
  var INTENTS_TEXT_MAX = 2000

  /** 单条归一：压掉换行、去首尾空白、截断到上限 */
  function normalizeIntent(v) {
    return String(v == null ? '' : v)
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, INTENT_MAX)
  }

  /** 文本 → 列表（每行一个；去空、去重、保序、限条数/限长）—— 设置页那个多行框用它 */
  function parseIntents(text) {
    var s = String(text == null ? '' : text).slice(0, INTENTS_TEXT_MAX)
    var lines = s.split('\n')
    var out = []
    for (var i = 0; i < lines.length; i++) {
      var v = normalizeIntent(lines[i])
      if (!v) continue
      if (out.indexOf(v) >= 0) continue
      out.push(v)
      if (out.length >= INTENTS_MAX) break
    }
    return out
  }

  /** 列表 → 文本（每行一个）；存配置与填设置页共用 */
  function serializeIntents(list) {
    if (!Array.isArray(list)) return ''
    var out = []
    for (var i = 0; i < list.length; i++) {
      var v = normalizeIntent(list[i])
      if (!v || out.indexOf(v) >= 0) continue
      out.push(v)
      if (out.length >= INTENTS_MAX) break
    }
    return out.join('\n')
  }

  /** 配置读回归一：**数组或文本都收**（配置文件被手改过也不怕）；其它一律 ⇒ `[]` */
  function normalizeIntentList(v) {
    if (Array.isArray(v)) return parseIntents(v.map(normalizeIntent).join('\n'))
    if (typeof v === 'string') return parseIntents(v)
    return []   // ⚠️ 不能直接 `parseIntents(v)`：对象会被 `String()` 成 "[object Object]" 变成一条诉求
  }

  /**
   * 往列表里加一条（「＋ 存为常用」用）。
   * @returns `{ list, added, reason }` —— `reason`：`'dup'`（已在列表）/ `'full'`（到上限）/
   *          `''`。**不静默失败**：调用方据此给提示（本仓纪律：失败搬到 UI 上）。
   */
  function addIntent(list, v) {
    var cur = normalizeIntentList(list)
    var x = normalizeIntent(v)
    if (!x) return { list: cur, added: false, reason: 'empty' }
    if (cur.indexOf(x) >= 0) return { list: cur, added: false, reason: 'dup' }
    if (cur.length >= INTENTS_MAX) return { list: cur, added: false, reason: 'full' }
    return { list: cur.concat([x]), added: true, reason: '' }
  }

  // ── 消息模板（形态 A 设计 §5.3 / 形态 B 计划 §3.1）──────────────────────

  /**
   * 组装发给任务中心的消息文本。两种形态**共用**同一个函数，只切"范围/正文"两行。
   * 首行**固定点名**「请转派「创作教练」执行」（不能只靠任务中心自行派发）。
   *
   * @param {object} opts
   * @param {'inline'|'path'} [opts.channel='inline'] 形态；`path` 需带 `relPath`
   * @param {string} opts.docName   文档名（清洗后取最后一段、去 `.md`）
   * @param {string} opts.intent    诉求（发送弹窗里选的意图）
   * @param {'full'|'selection'} [opts.scope='full']
   * @param {string} [opts.text]    形态 A 全文
   * @param {string} [opts.relPath] 形态 B 远端相对路径（**相对 `客户端区/`**，如 `正文/长夜/第三章.md`）
   * @param {string} [opts.version] 形态 B 版本（落盘响应里的 `version`；可省 ⇒ 不写"（版本 …）"）
   * @param {string} [opts.selectedText] 选中段（两形态都需要）
   */
  function buildMessage(opts) {
    opts = opts || {}
    var doc = stripMd(baseSeg(opts.docName))
    if (!doc) throw new Error('文档名为空，无法组装消息')
    var intent = String(opts.intent == null ? '' : opts.intent).trim() || '（未填写）'
    var isSel = opts.scope === 'selection'
    var channel = opts.channel === 'path' ? 'path' : 'inline'
    var body = isSel
      ? (opts.selectedText == null ? '' : String(opts.selectedText))
      : (opts.text == null ? '' : String(opts.text))
    if (isSel && !body) throw new Error('选中段为空，无法组装消息')

    var head = '【发送给任务中心｜请转派「创作教练」执行】'
    var src = '来源：写作客户端 · 文档《' + doc + '》'

    // ── 形态 B：只发路径 + 版本（**不带正文**）；选中段仍内联 ──
    if (channel === 'path') {
      var rel = String(opts.relPath == null ? '' : opts.relPath).replace(/\\/g, '/').trim()
      if (!rel) throw new Error('形态 B 缺少远端路径（relPath）')
      var ver = String(opts.version == null ? '' : opts.version).trim()
      // 🔴 显示用全路径（`客户端区/…`）；端点参数才用裸 relPath —— 别把前缀带回请求里
      var out = [
        head,
        src,
        '远端文件：' + displayPath(rel) + (ver ? '（版本 ' + ver + '）' : ''),
        '诉求：' + intent,
        '范围：全文',
      ]
      if (isSel) {
        out.push('选中段：')
        out.push('"""' + escapeTripleQuotes(body) + '"""')
      }
      return out.join('\n')
    }

    // ── 形态 A：正文内联（历史行为，保留）──
    var n = countChars(body)
    var lines = [
      head,
      src,
      '诉求：' + intent,
      '范围：' + (isSel
        ? '选中段（约 ' + n + ' 字；全文仅存在于客户端本地，未上传）'
        : '全文（约 ' + n + ' 字）'),
      isSel ? '选中段：' : '正文：',
      '"""' + escapeTripleQuotes(body) + '"""',
    ]
    return lines.join('\n')
  }

  // ── typert 信封（POST /api/session/prompt）──────────────────────────────

  /**
   * 内核 RPC 信封。形参名 = `request`（F-1，从内核 RPC 声明读出）；
   * 若上游改名，调用方可用 parseMissingParam 学出新名字后**只重试一次**。
   * mode：'queue' = 排在当前轮之后（不打断）；'steer' = 打断当前轮（首版不用）。
   */
  function buildEnvelope(opts) {
    opts = opts || {}
    var sessionId = opts.sessionId
    if (!sessionId) throw new Error('缺少 sessionId')
    var requestId = opts.requestId == null ? '' : String(opts.requestId)
    var mode = opts.mode === 'steer' ? 'steer' : 'queue'
    var timeZone = opts.timeZone || 'UTC'
    return {
      type: 'client-request',
      rpcId: requestId,
      method: 'session/prompt',
      payload: {
        args: {
          request: {
            requestId: requestId,
            sessionId: sessionId,
            mode: mode,
            content: [{ type: 'text', text: opts.text == null ? '' : String(opts.text) }],
            clientTimeZone: timeZone,
          },
        },
      },
    }
  }

  // ── 形参名兜底自学 ──────────────────────────────────────────────────────

  /**
   * 从报错文本里学 RPC 形参名（先例：`missing "request"; unexpected "_request"`）。
   * 命中返回名字，不命中返回 null。
   */
  function parseMissingParam(errorText) {
    if (!errorText) return null
    var s = String(errorText)
    var NAME = '([A-Za-z_][A-Za-z0-9_]*)'
    var patterns = [
      // missing "request" / missing 'request' / missing `request`
      new RegExp('missing\\s+["\'`]' + NAME + '["\'`]', 'i'),
      // missing required parameter/param/argument/property/field/key: xxx
      new RegExp('missing\\s+(?:required\\s+)?(?:parameter|param|argument|property|field|key)\\s*[:=]?\\s*["\'`]?' + NAME, 'i'),
      // parameter/field "xxx" is missing|required
      new RegExp('(?:parameter|param|argument|property|field|key)\\s+["\'`]' + NAME + '["\'`]\\s+(?:is\\s+)?(?:missing|required)', 'i'),
      // xxx is a required parameter/field
      new RegExp(NAME + '["\'`]?\\s+(?:is\\s+)?(?:a\\s+)?required\\s+(?:parameter|param|argument|property|field|key)', 'i'),
    ]
    for (var i = 0; i < patterns.length; i++) {
      var m = patterns[i].exec(s)
      if (m && m[1]) return m[1]
    }
    return null
  }

  return {
    cleanSeg: cleanSeg,
    baseSeg: baseSeg,
    stripMd: stripMd,
    countChars: countChars,
    buildMessage: buildMessage,
    buildEnvelope: buildEnvelope,
    parseMissingParam: parseMissingParam,
    // C5 · 形态 B
    DRAFT_ROOT: DRAFT_ROOT,
    CLIENT_ZONE_ROOT: CLIENT_ZONE_ROOT,
    displayPath: displayPath,
    draftRelPath: draftRelPath,
    buildDraftSaveBody: buildDraftSaveBody,
    readDraftSaveResult: readDraftSaveResult,
    // 「提交给 agent」
    buildSubmitBody: buildSubmitBody,
    readSubmitResult: readSubmitResult,
    altDraftName: altDraftName,
    resolveChannel: resolveChannel,
    // 诉求预设（可自定义）
    DEFAULT_INTENTS: DEFAULT_INTENTS,
    INTENT_MAX: INTENT_MAX,
    INTENTS_MAX: INTENTS_MAX,
    normalizeIntent: normalizeIntent,
    parseIntents: parseIntents,
    serializeIntents: serializeIntents,
    normalizeIntentList: normalizeIntentList,
    addIntent: addIntent,
  }
})
