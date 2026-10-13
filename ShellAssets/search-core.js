'use strict'

// ============================================================================
// 写作客户端 · 全站内容搜索纯逻辑（设计 docs/board-and-noveldb-design.md §4）
//
// 定位：**零依赖、纯本地、可被 node 直接 require**（与 sensitive.js / proofread.js 同构）。
//   · foldQuery    —— 英文小写 + 全角英数/空格 → 半角（与 WCSensitive.foldCase 同口径）
//   · buildRegex   —— 字面量转义 / wholeWord 包 \b / 非法正则返回 {error} 不抛 UI
//   · matchDoc     —— 在一篇正文里匹配查询 → 命中区间、行号、片段（≤30 字上下文）
//   · mergeResults —— 本机/云端结果归并（同 relPath 本地优先）、去重、按命中数排序
//
// 匹配规则（§4.3 / §8.2）：
//   · 默认大小写不敏感，在折叠串上匹配；折叠只做 1→1 替换 ⇒ 下标与原串 1:1
//   · caseSensitive:true 时不折叠、直接在原串匹配
//   · regex/wholeWord 一期 UI 不暴露但签名预留（默认 false），二期免改接口
//   · 单文档片段上限 3 条；全局硬上限 500 处命中（GLOBAL_HIT_CAP）
//
// UMD：node 下 module.exports，浏览器下挂 window.WCSearch。单测与渲染层跑同一份逻辑。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCSearch = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  var GLOBAL_HIT_CAP = 500          // §4.3 全局硬上限
  var DEFAULT_MAX_HITS_PER_DOC = 3 // 单文档片段上限
  var FRAG_CTX = 30                // before/after 各 ≤30 字（§8.1 search-types.ts）

  // ── 折叠（与 sensitive.foldCase 同口径）────────────────────────────────────

  function foldChar(c) {
    var code = c.charCodeAt(0)
    var out = c
    if (code >= 0xFF01 && code <= 0xFF5E) out = String.fromCharCode(code - 0xFEE0)
    else if (code === 0x3000) out = ' '
    var c2 = out.charCodeAt(0)
    if (c2 >= 65 && c2 <= 90) out = String.fromCharCode(c2 + 32)
    return out
  }

  function foldQuery(s) {
    var str = String(s == null ? '' : s)
    var out = ''
    for (var i = 0; i < str.length; i++) out += foldChar(str.charAt(i))
    return out
  }

  // ── 正则构造（§8.2 范式：字面量转义 + wholeWord + 非法正则兜底）──────────────

  function escapeLiteral(q) {
    return String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * @returns {{re:RegExp}} | {{error:string}}
   * 非法正则（regex 模式用户输入非法 / 抛 SyntaxError）不抛，返回 {error}。
   */
  function buildRegex(query, opts) {
    var o = opts || {}
    var caseSensitive = o.caseSensitive === true
    var regex = o.regex === true
    var wholeWord = o.wholeWord === true
    var q = query == null ? '' : String(query)
    if (q === '') return { error: '查询为空' }

    var pattern
    if (regex) {
      // 用户显式正则：不转义其主体；wholeWord 时在外层包 \b
      pattern = wholeWord ? '\\b(?:' + q + ')\\b' : q
    } else {
      // 字面量在折叠口径下匹配：非大小写敏感时把查询也折叠（与折叠后的正文对齐）
      var lit = escapeLiteral(caseSensitive ? q : foldQuery(q))
      pattern = wholeWord ? '\\b' + lit + '\\b' : lit
    }

    try {
      return { re: new RegExp(pattern, caseSensitive ? 'g' : 'gi') }
    } catch (e) {
      return { error: '无效的正则表达式' }
    }
  }

  function clampMaxFrag(n) {
    if (n == null) return DEFAULT_MAX_HITS_PER_DOC
    var v = Math.floor(n)
    return v > 0 ? v : DEFAULT_MAX_HITS_PER_DOC
  }

  // ── 单文档匹配 ────────────────────────────────────────────────────────────

  /** 计算 [0, idx) 内的换行数 ⇒ 行号（1 起） */
  function lineAt(content, idx) {
    var line = 1
    for (var i = 0; i < idx; i++) if (content.charCodeAt(i) === 10) line++
    return line
  }

  function sliceContext(content, start, end) {
    var b0 = Math.max(0, start - FRAG_CTX)
    var a1 = Math.min(content.length, end + FRAG_CTX)
    return {
      before: content.slice(b0, start),
      hit: content.slice(start, end),
      after: content.slice(end, a1),
    }
  }

  /**
   * 在一篇正文里匹配查询。
   * @returns {{relPath, hits:[{start,end,line}], count, fragments:[{before,hit,after}], truncated}} | null
   *   无命中返回 null；非法查询返回 {error}。
   *   opts.budget 剩余全局名额（默认满额 GLOBAL_HIT_CAP），触顶 truncated:true。
   */
  function matchDoc(relPath, content, query, opts) {
    var o = opts || {}
    var maxFrag = clampMaxFrag(o.maxHitsPerDoc)
    var text = String(content == null ? '' : content)

    var built = buildRegex(query, o)
    if (built.error) return { error: built.error }

    // 匹配串：区分大小写用原串，否则折叠（折叠长度恒等，下标即原串下标）
    var hay = o.caseSensitive === true ? text : foldQuery(text)
    var re = built.re
    re.lastIndex = 0

    var hits = []
    var budget = typeof o.budget === 'number' && o.budget >= 0
      ? Math.min(o.budget, GLOBAL_HIT_CAP)
      : GLOBAL_HIT_CAP

    var m
    while ((m = re.exec(hay)) !== null) {
      var s = m.index
      var e = s + m[0].length
      if (e <= s) { re.lastIndex++; continue } // 零宽匹配保护，防死循环
      hits.push({ start: s, end: e, line: lineAt(text, s) })
      if (hits.length >= budget) break
    }

    if (hits.length === 0) return null

    var fragments = []
    for (var i = 0; i < hits.length && i < maxFrag; i++) {
      fragments.push(sliceContext(text, hits[i].start, hits[i].end))
    }

    return {
      relPath: relPath,
      hits: hits,
      count: hits.length,
      fragments: fragments,
      truncated: hits.length >= budget,
    }
  }

  // ── 归并（同 relPath 本地优先，§4.3）──────────────────────────────────────

  function shallow(r, source) {
    return {
      relPath: r.relPath,
      hits: r.hits,
      count: r.count,
      fragments: r.fragments,
      source: source,
      truncated: !!r.truncated,
    }
  }

  function trimDoc(r, room) {
    var hits = r.hits.slice(0, room)
    var fragments = r.fragments.slice(0, Math.min(room, r.fragments.length))
    return {
      relPath: r.relPath,
      hits: hits,
      count: hits.length,
      fragments: fragments,
      source: r.source,
      truncated: true,
    }
  }

  /**
   * @param localHits  matchDoc 结果数组（本机）
   * @param remoteHits matchDoc 结果数组（云端）
   * @returns {{items, droppedRemote, totalHits, capped}}
   *   items 按 count 降序、再 relPath 升序；每项 source:'local'|'remote'。
   *   全局 500 命中截断在排序后逐篇累计。
   */
  function mergeResults(localHits, remoteHits) {
    var loc = Array.isArray(localHits) ? localHits.filter(Boolean) : []
    var rem = Array.isArray(remoteHits) ? remoteHits.filter(Boolean) : []

    var byPath = Object.create(null)
    var items = []
    var droppedRemote = 0

    loc.forEach(function (r) {
      if (byPath[r.relPath]) return
      var copy = shallow(r, 'local')
      byPath[r.relPath] = copy
      items.push(copy)
    })
    rem.forEach(function (r) {
      if (byPath[r.relPath]) { droppedRemote++; return }
      var copy = shallow(r, 'remote')
      byPath[r.relPath] = copy
      items.push(copy)
    })

    items.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count
      return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
    })

    var total = 0
    var capped = false
    var kept = []
    for (var i = 0; i < items.length; i++) {
      var it = items[i]
      if (total >= GLOBAL_HIT_CAP) { capped = true; continue }
      var room = GLOBAL_HIT_CAP - total
      if (it.count > room) {
        it = trimDoc(it, room)
        capped = true
      }
      total += it.count
      kept.push(it)
    }

    return { items: kept, droppedRemote: droppedRemote, totalHits: total, capped: capped }
  }

  return {
    GLOBAL_HIT_CAP: GLOBAL_HIT_CAP,
    FRAG_CTX: FRAG_CTX,
    foldQuery: foldQuery,
    escapeLiteral: escapeLiteral,
    buildRegex: buildRegex,
    matchDoc: matchDoc,
    mergeResults: mergeResults,
  }
})
