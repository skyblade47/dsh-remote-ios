'use strict'

// ============================================================================
// 写作客户端 · 「AI 校对」纯逻辑（B5 / CR-4①）
//
// 定位：**零依赖、可被 node 直接 require** 的纯函数集合（写法同本仓 `send.js` / `editor-plain.js`）：
//   · buildPrompt      —— 固定提示词（钉在客户端常量里；含 JSON 契约与"不得改写正文"）
//   · extractJson      —— 从模型回复里抽 JSON（认 ```json 围栏，也认裸 JSON）
//   · validateReport   —— 校验/归一化报告（逐条挑出可用项，坏的**丢弃并记原因**，不整包拒）
//   · locateItem       —— 在正文里定位某条建议（**以 original 文本匹配为准**，偏移仅作辅助）
//   · mapRange         —— 字符区间 → "第几个节点 / 节点内偏移"（给 CSS Highlight 建 Range 用，纯索引运算）
//   · applySuggestion  —— 生成"应用这一条之后"的新正文（纯函数，不改入参）
//   · sortItems / summarize —— 侧栏排序与计数
//
// 🔴 三条硬约束（用户 2026-09-27 拍、2026-09-28 再确认）：
//   ① **正文绝不被自动改写**：本模块只产出"新正文字符串"，**是否写回由渲染层在用户点「应用」时决定**；
//   ② **定位以文本为准**：用户一编辑，模型给的 `start/end` 偏移就会漂 ⇒ 偏移只用来在
//      "同一段原文出现多次"时挑最近的那一处（见 locateItem 的 ambiguous 分支）；
//   ③ **不改写作区形态**：高亮走 `::highlight()`（CSS Highlight API），DOM 与 `.md` 一字不动。
//
// ⚠️ 本模块同时要**被壳页当 <script> 加载**（同源 `/__shell__/proofread.js`）⇒ 外面套极薄 UMD：
//    node 下走 `module.exports`，浏览器下挂 `window.WCProofread`。渲染层与单测跑**同一份**逻辑。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCProofread = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  var PROMPT_VERSION = 1
  var SEVERITIES = ['must', 'should', 'nice']
  var KIND = 'proofread' // 首版只做错字/病句（用户 2026-09-28 拍 D-2）

  // ── 小工具 ──────────────────────────────────────────────────────────────

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }

  /** 三引号避让：正文里出现 `"""` 时替换，避免提前闭合包裹块（与 send.js 同口径） */
  function escTriple(s) {
    return String(s == null ? '' : s).split('"""').join('\\"\\"\\"')
  }

  /** 取路径最后一段并去掉 .md（只用于提示词里报文档名） */
  function docLabel(name) {
    var parts = String(name == null ? '' : name).replace(/\\/g, '/').split('/')
    var last = ''
    for (var i = 0; i < parts.length; i++) { if (parts[i]) last = parts[i] }
    return last.replace(/\.md$/i, '')
  }

  /** 整数偏移（不合法 ⇒ null；允许 0） */
  function intOrNull(v) {
    if (v === null || v === undefined || v === '') return null
    var n = Number(v)
    if (!isFinite(n) || Math.floor(n) !== n || n < 0) return null
    return n
  }

  // ── ① 固定提示词 ────────────────────────────────────────────────────────

  /**
   * 组装校对请求（**固定模板**：同样的入参必然得到同样的输出 ⇒ 可被单测钉住）。
   * `requestId` 会被写进提示词，好让回程 JSON 能自证"这条回复属于哪次请求"。
   */
  function buildPrompt(opts) {
    opts = opts || {}
    var doc = docLabel(opts.docName)
    var requestId = String(opts.requestId == null ? '' : opts.requestId)
    var text = opts.text == null ? '' : String(opts.text)
    var L = [
      '【写作客户端 · 校对请求 v' + PROMPT_VERSION + '｜请转派给校对流程】',
      '你是中文校对助手。只检查**错字 / 病句 / 标点**三类问题，**不要改写正文**。',
      '',
      '文档：《' + (doc || '（未命名）') + '》',
      '',
      '要求（逐条遵守）：',
      '1. 只输出**一个** ```json 代码块；块外不要有任何文字、解释、标题或前后缀。',
      '2. 你的输出只是**建议** —— 客户端会由用户逐条点「应用」才改动正文 ⇒ **不得**输出改写后的全文。',
      '3. 每条必须**原样**给出被改的那一小段原文（original），字符与标点都要与正文完全一致；',
      '   original 取**最短的唯一片段**（建议 2–20 字），以确保能在正文里唯一定位。',
      '4. start / end 是相对**整篇正文**的字符偏移（从 0 开始，end 不含），仅作辅助定位用；',
      '   客户端定位以 original 文本为准，两者冲突时以文本为准。',
      '5. severity 只能取：must（必改）· should（建议改）· nice（可选润色）。',
      '6. 没有问题时 items 给空数组（[]），**不要编造**。',
      '',
      '输出格式：',
      '```json',
      '{',
      '  "v": ' + PROMPT_VERSION + ',',
      '  "kind": "' + KIND + '",',
      '  "requestId": "' + requestId + '",',
      '  "items": [',
      '    { "id": "t1", "start": 12, "end": 14, "original": "的地", "suggestion": "地",',
      '      "reason": "「的」「地」误用", "severity": "must" }',
      '  ]',
      '}',
      '```',
      '',
      '正文（三引号之间，逐字为准）：',
      '"""' + escTriple(text) + '"""',
    ]
    return L.join('\n')
  }

  // ── ② 从回复里抽 JSON ──────────────────────────────────────────────────

  /**
   * 抽出报告对象。依次试：① ```json / ``` 围栏配对（报告本就在围栏里）⇒ 优先；
   * ② 平衡花括号扫描（字符串/转义感知，救被错配围栏吞掉的报告）；③ 第一个 `{` 到最后一个 `}`。
   * 都失败 ⇒ {ok:false, error}（**不抛异常**，调用方只判 ok）。
   *
   * 2026-10-09 生产取证（RID e39da824…）：模型在 JSON 围栏**之前**先写了大段解说，解说里
   * 含多组不成对的 ``` 与花括号。旧的非贪婪围栏正则把"正文围栏"和"真正的 ```json 开围栏"
   * 错配成对，整块真 JSON 从未成为候选；整段首末花括号切片又被解说里的花括号毒化 ⇒
   * 明明尾部 ```json 里的报告完好（69 项、RID 正确），客户端却报"没有可解析 JSON"。
   */
  function extractJson(replyText) {
    var s = String(replyText == null ? '' : replyText)
    if (!s.trim()) return { ok: false, error: '回复为空' }

    var lastErr = ''

    // ① 围栏配对优先：契约里报告本就该在 ```json / ``` 围栏里。
    var candidates = []
    var fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g
    var m
    while ((m = fence.exec(s)) !== null) candidates.push(m[1])
    for (var fi = 0; fi < candidates.length; fi++) {
      var fraw = String(candidates[fi]).trim()
      if (!fraw) continue
      try {
        var fv = JSON.parse(fraw)
        if (isObj(fv)) return { ok: true, value: fv }
        lastErr = '解析出的不是对象'
      } catch (e) {
        lastErr = (e && e.message) || 'JSON 解析失败'
      }
    }

    // ② 平衡花括号扫描兜底：围栏被解说里"不成对的 ```"错配时，仍能直接配平出真报告。
    //    扫描会同时切出 items 内的条目对象，故先优先收"带 items 数组的报告对象"，
    //    避免某个条目对象（isObj 为真）被误当成报告提前返回。
    var balanced = scanBalancedObjects(s)
    var balancedFallback = null
    for (var bi = 0; bi < balanced.length; bi++) {
      try {
        var bv = JSON.parse(balanced[bi])
        if (!isObj(bv)) { lastErr = '解析出的不是对象'; continue }
        if (Array.isArray(bv.items)) return { ok: true, value: bv }
        if (!balancedFallback) balancedFallback = bv
      } catch (e) {
        lastErr = (e && e.message) || 'JSON 解析失败'
      }
    }
    if (balancedFallback) return { ok: true, value: balancedFallback }

    // ③ 首末花括号整段切片（最后兜底）。
    var first = s.indexOf('{')
    var last = s.lastIndexOf('}')
    if (first >= 0 && last > first) {
      var raw = s.slice(first, last + 1).trim()
      try {
        var v = JSON.parse(raw)
        if (isObj(v)) return { ok: true, value: v }
        lastErr = '解析出的不是对象'
      } catch (e) {
        lastErr = (e && e.message) || 'JSON 解析失败'
      }
    }
    return { ok: false, error: '回复里没有可解析的 JSON 报告（' + (lastErr || '未找到 JSON') + '）' }
  }

  /**
   * 字符串/转义感知地扫描文本里所有**花括号平衡**的 `{ ... }` 子串，按起点顺序返回。
   * 纯索引运算、零依赖；`{` 一旦进入字符串即不计数，所以解说里"裸"花括号不会再毒化切片。
   */
  function scanBalancedObjects(s) {
    var out = []
    var opens = []
    var inStr = false
    var escaped = false
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i)
      if (inStr) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === '{') {
        opens.push(i)
      } else if (ch === '}' && opens.length) {
        var st = opens.pop()
        out.push(s.slice(st, i + 1))
      }
    }
    return out
  }

  // ── ③ 校验与归一 ────────────────────────────────────────────────────────

  function normSeverity(s) {
    var v = String(s == null ? '' : s).trim().toLowerCase()
    return SEVERITIES.indexOf(v) >= 0 ? v : 'should'
  }

  /**
   * 校验报告。**逐条挑**：坏的条目丢弃并把原因记进 `errors`（不整包拒 —— 模型偶尔写坏一条
   * 不应让全套建议作废）。`v` 不匹配只记一条 note，不拒（上游版本号会走）。
   */
  function validateReport(obj) {
    var errors = []
    if (!isObj(obj)) return { ok: false, errors: ['报告不是对象'], items: [] }

    var rawItems = obj.items
    if (!Array.isArray(rawItems)) return { ok: false, errors: ['报告里没有 items 数组'], items: [] }

    var items = []
    for (var i = 0; i < rawItems.length; i++) {
      var it = rawItems[i]
      var who = 'items[' + i + ']'
      if (!isObj(it)) { errors.push(who + ' 不是对象'); continue }

      var original = typeof it.original === 'string' ? it.original : null
      if (original === null) { errors.push(who + ' 缺 original（字符串）'); continue }
      if (!original) { errors.push(who + ' 的 original 为空'); continue }

      var suggestion = typeof it.suggestion === 'string' ? it.suggestion
        : (it.suggestion === null || it.suggestion === undefined ? null : null)
      if (suggestion === null) { errors.push(who + ' 缺 suggestion（字符串；删除请给空串）'); continue }

      var start = intOrNull(it.start)
      var end = intOrNull(it.end)
      if (start !== null && end !== null && end < start) { start = null; end = null } // 偏移废掉，不影响文本定位
      if (start === null || end === null) { start = null; end = null }

      var id = (typeof it.id === 'string' && it.id) ? it.id : ('t' + (items.length + 1))
      items.push({
        id: id,
        original: original,
        suggestion: suggestion,
        reason: typeof it.reason === 'string' ? it.reason : '',
        severity: normSeverity(it.severity),
        start: start,
        end: end,
      })
    }

    if (obj.v !== undefined && Number(obj.v) !== PROMPT_VERSION) {
      errors.push('报告的 v=' + obj.v + '（本客户端是 v' + PROMPT_VERSION + '，按同版解析）')
    }
    return { ok: true, items: items, errors: errors, kind: typeof obj.kind === 'string' ? obj.kind : '', requestId: typeof obj.requestId === 'string' ? obj.requestId : '' }
  }

  // ── ④ 文本定位（**以文本为准**）─────────────────────────────────────────

  /** `needle` 在 `text` 里出现的所有起点 */
  function allIndexes(text, needle) {
    var out = []
    if (!needle) return out
    var from = 0
    for (;;) {
      var i = text.indexOf(needle, from)
      if (i < 0) break
      out.push(i)
      from = i + 1 // 允许重叠，宁可多找也不错找
    }
    return out
  }

  /**
   * 在 `doc` 里定位这条建议要改的片段。
   * · 找不到 ⇒ {ok:false, error}（**判据：用户可能已经手工改过这句 ⇒ 渲染层要拒绝并提示**）
   * · 只有一处 ⇒ 直接命中
   * · 多处 ⇒ 用 `item.start` 挑**最近**的那处（偏移在这里才用得上）；`start` 缺失 ⇒ 取第一处并标 `ambiguous`
   */
  function locateItem(doc, item) {
    var text = String(doc == null ? '' : doc)
    var original = item && typeof item.original === 'string' ? item.original : ''
    if (!original) return { ok: false, error: '这条建议没有原文，无法定位' }

    var hits = allIndexes(text, original)
    if (!hits.length) return { ok: false, error: '正文里找不到「' + original + '」（可能已被改动）' }

    var start = hits[0]
    if (hits.length > 1 && typeof item.start === 'number' && isFinite(item.start)) {
      var best = hits[0]
      var bestD = Math.abs(hits[0] - item.start)
      for (var i = 1; i < hits.length; i++) {
        var d = Math.abs(hits[i] - item.start)
        if (d < bestD) { best = hits[i]; bestD = d }
      }
      start = best
    }
    return { ok: true, start: start, end: start + original.length, occurrences: hits.length, ambiguous: hits.length > 1 }
  }

  /**
   * **宽松定位**（忽略空白差异）—— 🔴 **只给"跳转/看到哪儿"用，绝不用它改正文**。
   *
   * 为什么需要（2026-09-28 真机实测）：模型给的 `original` 可能与正文**只差空白**
   * （例：模型写「卡恩 124 号的手指」，正文是「卡恩124号的手指」）⇒ 逐字比对找不到，
   * 表现成"点条目没反应"（而那次失败还是静默的，用户不知道为什么）。
   *
   * 做法：把 `original` 压掉空白得到"针"，再在正文上滑窗比对（比之前跳过空白），
   * 命中后返回**原文里的真实区间** `[start, end)`（含其中的空白）。
   * 应用（改字）仍然只认 `locateItem` 的逐字匹配 —— 动正文的事情不猜。
   */
  function locateFuzzy(doc, original) {
    var text = String(doc == null ? '' : doc)
    var needle = String(original == null ? '' : original)
    var squeezed = needle.replace(/\s+/g, '')
    if (!squeezed) return { ok: false, error: '这条建议没有可用的原文' }
    var n = text.length
    var isSpace = function (c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u3000' }
    for (var s = 0; s < n; s++) {
      if (isSpace(text.charAt(s))) continue // 命中区间不从空白开头（否则会多带一个空格）
      var j = 0
      var k = s
      while (j < squeezed.length) {
        while (k < n && isSpace(text.charAt(k))) k++
        if (k >= n || text.charAt(k) !== squeezed.charAt(j)) { j = -1; break }
        k++
        j++
      }
      if (j >= 0) return { ok: true, start: s, end: k, fuzzy: true }
    }
    return { ok: false, error: '正文里找不到「' + original + '」（忽略空白后也找不到）' }
  }

  /**
   * 生成"应用这一条之后"的新正文。**纯函数**：不改入参，是否写回由渲染层决定（🔴 绝不自动改）。
   * `original === suggestion` ⇒ 视为空操作（changed:false），不产生无意义改动。
   */
  function applySuggestion(doc, item) {
    var text = String(doc == null ? '' : doc)
    var loc = locateItem(text, item)
    if (!loc.ok) return { ok: false, error: loc.error }
    var suggestion = item && typeof item.suggestion === 'string' ? item.suggestion : null
    if (suggestion === null) return { ok: false, error: '这条建议没有 suggestion' }
    if (suggestion === item.original) return { ok: true, text: text, changed: false, start: loc.start, end: loc.end }
    return {
      ok: true,
      text: text.slice(0, loc.start) + suggestion + text.slice(loc.end),
      changed: true,
      start: loc.start,
      end: loc.end,
    }
  }

  // ── ⑤ 字符区间 → 节点位置（高亮用；纯索引，不碰 DOM）────────────────────

  /**
   * 每个"段"占的字符数。`null` = **占 1 个字符但没有文本节点**的东西（`<br>`，`domToText` 里算一个 `\n`）。
   * 之所以要区分：文本节点能拿来做 Range 的容器，`<br>` 不能。
   */
  function segLen(v) {
    if (v === null || v === undefined) return 1
    var n = Number(v)
    return isFinite(n) && n > 0 ? n : 0 // 0/坏值 ⇒ 空段（不占字符，映射时自然跳过）
  }

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v }

  function findPos(lens, p) {
    var cum = 0
    for (var i = 0; i < lens.length; i++) {
      var L = segLen(lens[i])
      if (p < cum + L) {
        var isTxt = lens[i] !== null && lens[i] !== undefined && segLen(lens[i]) > 0
        return { i: i, off: isTxt ? (p - cum) : 0, br: !isTxt }
      }
      cum += L
    }
    // p === 总长（正落在正文末尾之后）
    if (!lens.length) return { i: -1, off: 0, br: true }
    var last = lens.length - 1
    var lastTxt = lens[last] !== null && lens[last] !== undefined && segLen(lens[last]) > 0
    return { i: last, off: lastTxt ? segLen(lens[last]) : 0, br: !lastTxt, atEnd: true }
  }

  function nextText(lens, from) {
    for (var i = Math.max(0, from); i < lens.length; i++) {
      if (lens[i] !== null && lens[i] !== undefined && segLen(lens[i]) > 0) return { i: i, off: 0, br: false }
    }
    return null
  }

  function prevText(lens, from) {
    for (var i = Math.min(from, lens.length - 1); i >= 0; i--) {
      if (lens[i] !== null && lens[i] !== undefined && segLen(lens[i]) > 0) return { i: i, off: segLen(lens[i]), br: false }
    }
    return null
  }

  /**
   * 把正文的字符区间 `[start, end)` 映射成 `{si, so, ei, eo}`（第 si 个节点的 so 偏移 → 第 ei 个节点的 eo 偏移）。
   * `lens` = 各节点文本长度（`null` = `<br>` 这类占位节点），顺序同 `Plain.domToText` 的遍历顺序。
   *
   * 为什么要它：`::highlight()` 只能吃 `Range`，而 `Range` 要 (节点, 偏移)。这段索引运算有真边界
   * （跨节点 / 正落在节点末尾 / 落在 `<br>` 上 / 零长节点 / 空区间），所以**抽成纯函数单测**，
   * DOM 那侧只负责"把节点列出来 + 建 Range"。
   *
   * 落在 `<br>` 上时：起点**向后**挪到下一个文本节点开头，终点**向前**挪到上一个文本节点末尾；
   * 挪不动（该侧没有文本节点）或挪完为空 ⇒ `ok:false`（调用方跳过这条高亮，只在列表里显示）。
   *
   * ⚠️ **边界约定**：位置 p 落在两个节点之间时，统一取**后一个节点的 0 偏移** ——
   *    与"前一个节点的末尾偏移"是**等价**的 Range 起点/终点（`(nodeA, len)` ≡ `(nodeB, 0)`），
   *    取后者只是实现上的选择（单测按这个约定钉住，免得来回改）。
   *    而 p **正好等于 `<br>` 的下标**（落在 br 内部）才会触发上面那条"前后挪"。
   */
  function mapRange(lens, start, end) {
    var arr = Array.isArray(lens) ? lens : []
    var total = 0
    for (var k = 0; k < arr.length; k++) total += segLen(arr[k])
    if (!isInt(start) || !isInt(end)) return { ok: false, error: '偏移不是整数' }
    if (start < 0 || end < start) return { ok: false, error: '偏移区间非法' }
    if (end > total) return { ok: false, error: '偏移超出正文长度（' + end + ' > ' + total + '）' }

    var a = findPos(arr, start)
    var b = findPos(arr, end)
    if (a.br) a = nextText(arr, a.i + 1)
    if (b.br) b = prevText(arr, b.i)
    if (!a || !b) return { ok: false, error: '区间落在非文本节点上，无法高亮' }
    if (a.i === b.i && a.off >= b.off) return { ok: false, error: '区间为空，无需高亮', empty: true }
    return { ok: true, si: a.i, so: a.off, ei: b.i, eo: b.off }
  }

  // ── ⑤ 回程：从会话记录里认领本次回复（纯函数，网络层不用猜）────────────

  /**
   * 取一条会话事件里的**助手正文**。
   * 依据（已核）：`plugins/email-bridge/lib/index.js` 的 `extractSurfaceEventsText` ——
   *   事件形状 `{type, data:{content:[{type:'text',text}]}}`（与 taskkit receiptScanner 同款解析）。
   * 兜底再认一层 `data.message.content[]`（会话历史里带引用的形态）与 `data.text`；
   * 多段 text 直接拼接（**不加分隔符**，避免把 JSON 拆坏）。
   */
  function textOfEvent(ev) {
    if (!isObj(ev)) return ''
    var d = ev.data
    if (!isObj(d)) return ''
    var parts = null
    if (Array.isArray(d.content)) parts = d.content
    else if (isObj(d.message) && Array.isArray(d.message.content)) parts = d.message.content
    if (Array.isArray(parts)) {
      var out = ''
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i]
        if (isObj(p) && typeof p.text === 'string') out += p.text
      }
      if (out) return out
    }
    return typeof d.text === 'string' ? d.text : ''
  }

  /** 记录既可能是 `{event:{...}}`（`session/page` 的 records）也可能是裸事件 ⇒ 取出来 */
  function eventOf(rec) {
    if (!isObj(rec)) return null
    if (isObj(rec.event)) return rec.event
    if (typeof rec.type === 'string') return rec
    return null
  }

  /** 元素"像一条事件"吗（`{type}` 或 `{event:{type}}`） */
  function isEventish(x) {
    var ev = isObj(x) && isObj(x.event) ? x.event : x
    return isObj(ev) && typeof ev.type === 'string'
  }

  /**
   * 🔴 从 `session/page` 的 `result.value` 里取**事件数组** —— **不写死字段名**。
   *
   * 为什么必须泛取（2026-09-28 真机第四跑踩到）：会话里**明明有 JSON**（用户肉眼可见），
   * 客户端却判定"180 秒没动静" ⇒ 那一次读到的 `records` 是**空**（既认领不到结果，也检测不到进展）。
   * `records` 这个键名只在**夹具内核**上核过（`tools/rob-probe.mjs`），真机经网关后不保证同名。
   * ⇒ 先认 `records`；否则在 value 及其常见嵌套层里找**第一个元素像事件**的数组。
   * 都找不到 ⇒ `null`（调用方据此**立刻**报"形状不符"并附上实际字段名，而不是干等）。
   */
  function pickRecords(value) {
    if (!isObj(value)) return null
    var layers = [value, value.page, value.data, value.result, value.body, value.value]
    for (var i = 0; i < layers.length; i++) {
      var o = layers[i]
      if (!isObj(o)) continue
      if (Array.isArray(o.records)) return o.records
      for (var k in o) {
        var v = o[k]
        if (Array.isArray(v) && v.length && isEventish(v[0])) return v
      }
    }
    return null
  }

  /** value 的字段名（诊断：形状不符时写进错误里，一眼看出实际长什么样） */
  function valueKeys(v) {
    if (!isObj(v)) return String(v)
    return Object.keys(v).join(',') || '（无字段）'
  }

  /**
   * 从 `session/page` 的记录里认领**本次**校对的回复。
   *
   * 扫描口径（**从尾部往前**，因为刚投的那条一定在最近几条里）：
   *   ① 只认 `assistant/message`；
   *   ② 能抽出 JSON 且能过 `validateReport` 的才算候选；
   *   ③ `requestId` **一致** ⇒ 立刻认领（`matched:true`）；
   *   ④ 报告的 `requestId` **不一致** ⇒ 这不是我们的（上一轮/别人的）⇒ 继续往前扫，**且绝不兜底**
   *      （🔴 否则轮询会在"新回复还没到"时把**上一轮的旧建议**当成结果收工）；
   *   ⑤ 报告**没带** `requestId` ⇒ 当作候选兜住，但先继续往前找有没有带对的 id；
   *   ⑥ 全都没匹配上 ⇒ 回退到那条"没带 id 的候选"（`matched:false`）—— 宁可给用户看建议，
   *      也不要因为模型忘了回显 requestId 就整轮作废。
   */
  function pickReport(records, requestId) {
    var list = Array.isArray(records) ? records : []
    if (!list.length) return { ok: false, error: '会话里没有记录' }
    var rid = String(requestId == null ? '' : requestId)
    var fallback = null

    for (var i = list.length - 1; i >= 0; i--) {
      var ev = eventOf(list[i])
      if (!ev || ev.type !== 'assistant/message') continue
      var text = textOfEvent(ev)
      if (!text || text.indexOf('{') < 0) continue
      var j = extractJson(text)
      if (!j.ok) continue
      var rep = validateReport(j.value)
      if (!rep.ok || !rep.items) continue

      // ① 带 id：只认自己的，别人的一律跳过（不兜底）
      if (rep.requestId && rid) {
        if (rep.requestId === rid) {
          return { ok: true, matched: true, items: rep.items, errors: rep.errors, rawText: text, requestId: rep.requestId }
        }
        continue
      }
      // ② 没带 id（或我们没 id 可对）：兜底用，但先往前找"带对的 id 的"
      if (!fallback) fallback = { ok: true, matched: false, items: rep.items, errors: rep.errors, rawText: text, requestId: rep.requestId }
      var deeper = pickReport(list.slice(0, i), rid)
      if (deeper.ok && deeper.matched) return deeper
      return fallback
    }
    if (fallback) return fallback
    return { ok: false, error: '这个会话里没有找到可解析的校对 JSON 回复' }
  }

  /**
   * 会话**进展判据**（给轮询用：**不能只靠时钟**决定要不要继续等）。
   *
   * 返回 `{ sawPrompt, done, lastType, lastSeq }`：
   *   · `sawPrompt` —— 尾部窗口里已经能看到**我们那条 prompt**（按 `requestId` 认；说明投递确实进了会话）；
   *   · `done`      —— 我们那条 prompt **之后**已经出现过 `turn/end` ⇒ **这一轮答完了**。
   *     ⇒ 此时若还没认领到可解析的 JSON，就该立刻给"它答完了但没有 JSON"的准确结论，而不是继续干等。
   *   · `lastType` / `lastSeq` —— 尾部最后一条事件的类型与序号（"还有没有新动静"的判据）。
   *
   * ⚠️ prompt 若已被挤出尾部窗口（会话很长），`sawPrompt` 会是 false ⇒ 调用方**不能**据此判死，
   *    只当作"还没看见"（真正兜底的是"无进展"那条规则）。
   */
  function turnState(records, requestId) {
    var list = Array.isArray(records) ? records : []
    var rid = String(requestId == null ? '' : requestId)
    var at = -1
    for (var i = list.length - 1; i >= 0; i--) {
      var ev = eventOf(list[i])
      if (!ev || ev.type !== 'user/message') continue
      var t = textOfEvent(ev)
      if (!rid || t.indexOf(rid) >= 0) { at = i; break }
    }
    var done = false
    for (var k = at + 1; k < list.length; k++) {
      var e2 = eventOf(list[k])
      if (e2 && e2.type === 'turn/end') done = true
    }
    var lastEv = list.length ? eventOf(list[list.length - 1]) : null
    return {
      sawPrompt: at >= 0,
      done: done,
      lastType: (lastEv && lastEv.type) || '',
      lastSeq: lastEv && lastEv.seq != null ? lastEv.seq : null,
    }
  }

  // ── ⑥ 侧栏排序与计数 ────────────────────────────────────────────────────

  function severityRank(sev) {
    var i = SEVERITIES.indexOf(normSeverity(sev))
    return i < 0 ? 1 : i
  }

  /** 排序：先按严重度（must → nice），同级按正文位置（无偏移的排后面） */
  function sortItems(items) {
    var arr = (Array.isArray(items) ? items.slice() : [])
    arr.sort(function (a, b) {
      var d = severityRank(a && a.severity) - severityRank(b && b.severity)
      if (d) return d
      var sa = a && typeof a.start === 'number' ? a.start : Number.MAX_SAFE_INTEGER
      var sb = b && typeof b.start === 'number' ? b.start : Number.MAX_SAFE_INTEGER
      if (sa !== sb) return sa - sb
      return String((a && a.id) || '').localeCompare(String((b && b.id) || ''))
    })
    return arr
  }

  function summarize(items) {
    var arr = Array.isArray(items) ? items : []
    var out = { total: arr.length, must: 0, should: 0, nice: 0 }
    for (var i = 0; i < arr.length; i++) out[normSeverity(arr[i] && arr[i].severity)]++
    return out
  }

  // ── ⑦ 内核 RPC 信封（**method 必须与路径同为斜杠形式**）──────────────────

  /**
   * 组装 typert RPC 信封。**唯一的坑（2026-09-28 真机第五跑踩到，代价三轮）**：
   * 内核要求 **URL 路径与信封里的 `method` 同为斜杠形式** —— 两者不一致时内核直接拒绝：
   *   `method "session.page" does not match endpoint "session/page"`
   * ⇒ 调用方（原来）按 `'session.page'` 建信封 + 按 `/api/session/page` 发请求，于是**每一次轮询都失败**，
   *    而且当时那个失败被静默吞掉，表现成"会话没动静"。
   * ⇒ 这里统一：`method` 永远按斜杠形式写；`.` 形式（怎么传都行）先归一化。
   *
   * `param` = 该 RPC 的**形参名**（内核按方法不同：`session/page` 要 `request`），
   *   实际调用的形参名由调用方从 `missing "xxx"` 报错里自学后回填。
   */
  function buildEnvelope(method, param, request, rpcId) {
    var slash = String(method == null ? '' : method).replace(/\./g, '/')
    var args = {}
    args[param] = request
    return {
      type: 'client-request',
      rpcId: rpcId,
      method: slash,
      payload: { args: args },
    }
  }

  // ── ⑧ 结果缓存：指纹 + 复活（持久化那层在 main.js / proofread-net.js）────────
  //
  // 为什么要有（用户 2026-09-28 实测反馈）：「校对结果没有持久化，切出再切回原文档，剩余校对内容
  //   全部丢失。再次按校对按钮被更新可以理解，但全部丢失会导致**关闭程序再开启后重复校对同一文本**」
  //   —— 一次校对要等 1~2 分钟模型 ⇒ 缓存下来很值。
  // 口径：按 `<工作区>+<相对路径>` 存一份（main.js 落 userData/proofread/），**带正文指纹**；
  //   复活时**逐条按当前正文重新定位**，定位不到的保留但标出来（不静默丢、也不假装有效）。

  /**
   * 文本指纹：判断"这份建议是不是针对**当前这段正文**"。
   * djb2 变体 + 长度后缀（长度也进结果 ⇒ 短文改动不易撞）；**不进任何加密用途**。
   */
  function hashText(s) {
    var str = String(s == null ? '' : s)
    var h = 5381
    for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0
    return h.toString(16) + '-' + str.length
  }

  /**
   * 复活一份**缓存下来的**校对结果（切文档回来 / 重启客户端之后用）。
   * 返回 `{ items, missing, docChanged }`（`docChanged` = 传入的两个指纹不一致）。
   */
  function reviveReport(items, docText, savedHash, nowHash) {
    var list = Array.isArray(items) ? items.slice() : []
    var missing = 0
    for (var i = 0; i < list.length; i++) {
      if (!isObj(list[i])) continue
      list[i] = Object.assign({}, list[i]) // 🔴 逐条复制后再写 `failed`：本模块的函数都**不改入参**
      var loc = locateItem(docText, list[i])
      if (loc.ok) list[i].failed = ''
      else { list[i].failed = '正文已改动 ⇒ 这条定位不到：' + loc.error; missing++ }
    }
    return { items: list, missing: missing, docChanged: String(savedHash || '') !== String(nowHash || '') }
  }

  return {
    PROMPT_VERSION: PROMPT_VERSION,
    SEVERITIES: SEVERITIES,
    KIND: KIND,
    buildPrompt: buildPrompt,
    buildEnvelope: buildEnvelope,
    extractJson: extractJson,
    scanBalancedObjects: scanBalancedObjects,
    validateReport: validateReport,
    normSeverity: normSeverity,
    locateItem: locateItem,
    locateFuzzy: locateFuzzy,
    mapRange: mapRange,
    textOfEvent: textOfEvent,
    pickReport: pickReport,
    pickRecords: pickRecords,
    valueKeys: valueKeys,
    turnState: turnState,
    applySuggestion: applySuggestion,
    severityRank: severityRank,
    sortItems: sortItems,
    summarize: summarize,
    hashText: hashText,
    reviveReport: reviveReport,
  }
})
