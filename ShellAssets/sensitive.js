'use strict'

// ============================================================================
// 写作客户端 · 敏感词扫描纯逻辑（设计 docs/board-and-noveldb-design.md §3）
//
// 定位：**零依赖、纯本地、可被 node 直接 require**（与 proofread.js / editor-plain.js 同构）。
//   · foldCase      —— 英文小写 + 全角英数/空格 → 半角（匹配在折叠串上做，下标与原串 1:1）
//   · buildMatcher  —— AC 自动机构建（含失败指针与 goto 补全），一次构建 O(正文长度) 扫描
//   · scanText      —— 扫描一篇正文 → [{word, category, severity, start, end}]
//                      长词优先去重 / 分类开关 / 自定义词(should,custom) / ignoreWords 最高优先
//   · snippetAround —— 命中处所在句片段（截到标点/换行），供右栏列表展示
//
// 匹配规则（§3.3）：
//   · 大小写不敏感；全角英数折叠为半角；**不做繁简转换**（一期，词库双形收录）
//   · 折叠只做**单码位→单码位**替换 ⇒ 折叠串与原串长度恒等，命中下标无需映射直接就是原串下标
//   · 命中区间重叠时取长词优先（AC 输出按 start 排序后去重）
//
// UMD：node 下 module.exports，浏览器下挂 window.WCSensitive。单测与渲染层跑同一份逻辑。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCSensitive = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  // ── 折叠 ────────────────────────────────────────────────────────────────

  /** 全角英数/空格 → 半角，英文字母转小写。🔴 只做 1→1 替换，保持长度恒等 ⇒ 下标可直接映射回原串 */
  function foldChar(c) {
    var code = c.charCodeAt(0)
    var out = c
    if (code >= 0xFF01 && code <= 0xFF5E) out = String.fromCharCode(code - 0xFEE0) // 全角 → 半角（大写英文字母也在此步）
    else if (code === 0x3000) out = ' ' // 全角空格
    var c2 = out.charCodeAt(0)
    if (c2 >= 65 && c2 <= 90) out = String.fromCharCode(c2 + 32) // A-Z → a-z（含上一步折出的半角大写）
    return out
  }

  function foldCase(s) {
    var str = String(s == null ? '' : s)
    var out = ''
    for (var i = 0; i < str.length; i++) out += foldChar(str.charAt(i))
    return out
  }

  /** 解析用户一行一个的词表：拆行 + 去空白 + 折叠 + 去重，保序；空/非字符串 → [] */
  function parseWordList(v) {
    if (!Array.isArray(v) && typeof v !== 'string') return []
    var raw = Array.isArray(v) ? v.join('\n') : v
    var seen = Object.create(null)
    var out = []
    var lines = raw.split(/[\r\n]+/)
    for (var i = 0; i < lines.length; i++) {
      var w = lines[i].trim()
      if (!w) continue
      var f = foldCase(w)
      if (!f || seen[f]) continue
      seen[f] = 1
      out.push(f)
    }
    return out
  }

  // ── AC 自动机 ────────────────────────────────────────────────────────────

  /**
   * buildMatcher(entries)：entries = [{word, category, severity}]（word 可以未折叠，内部折叠）。
   * 返回 matcher.scan(foldedText) → 命中数组（未去重，按位置自然顺序，含各词元数据）。
   * goto 表在构建时补全（标准 AC），扫描时无回溯、无 while-fail 链。
   */
  function buildMatcher(entries) {
    var gotoTable = [Object.create(null)] // 节点 0 = root
    var fail = [0]
    var depth = [0]
    var outputs = [[]] // 每个节点的输出：在该节点结束的词（含 category/severity/折叠后 word）

    function addWord(folded, meta) {
      if (!folded) return
      var node = 0
      for (var i = 0; i < folded.length; i++) {
        var ch = folded.charAt(i)
        var next = gotoTable[node][ch]
        if (next === undefined) {
          next = gotoTable.length
          gotoTable[node][ch] = next
          gotoTable.push(Object.create(null))
          fail.push(0)
          depth.push(depth[node] + 1)
          outputs.push([])
        }
        node = next
      }
      outputs[node].push(meta)
    }

    var list = Array.isArray(entries) ? entries : []
    for (var k = 0; k < list.length; k++) {
      var e = list[k]
      if (!e || typeof e.word !== 'string') continue
      var f = foldCase(e.word)
      if (f) addWord(f, { word: f, category: e.category || '', severity: e.severity || 'should' })
    }

    // BFS：失败指针 + goto 补全 + 输出沿 fail 链聚合（扫描时节点自带全部后缀词）
    var queue = []
    var rootEdges = gotoTable[0]
    Object.keys(rootEdges).forEach(function (ch) {
      var child = rootEdges[ch]
      fail[child] = 0
      queue.push(child)
    })
    var head = 0
    while (head < queue.length) {
      var u = queue[head++]
      var edges = gotoTable[u]
      Object.keys(edges).forEach(function (ch) {
        var v = edges[ch]
        var f = fail[u]
        while (f !== 0 && gotoTable[f][ch] === undefined) f = fail[f]
        fail[v] = gotoTable[f][ch] !== undefined && gotoTable[f][ch] !== v ? gotoTable[f][ch] : 0
        outputs[v] = outputs[v].concat(outputs[fail[v]])
        queue.push(v)
      })
    }

    function scan(text) {
      var hits = []
      var node = 0
      for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i)
        var next = gotoTable[node][ch]
        if (next !== undefined) {
          node = next
        } else {
          var f = node
          while (f !== 0 && gotoTable[f][ch] === undefined) f = fail[f]
          node = gotoTable[f][ch] !== undefined ? gotoTable[f][ch] : 0
        }
        var outs = outputs[node]
        for (var j = 0; j < outs.length; j++) {
          var m = outs[j]
          hits.push({ word: m.word, category: m.category, severity: m.severity, start: i + 1 - m.word.length, end: i + 1 })
        }
      }
      return hits
    }

    return { scan: scan }
  }

  /**
   * 命中去重：按 start 排序；区间与已选命中重叠时**长词优先**（等长取先出现的）。
   * 实现：按 (start asc, length desc) 排序后顺序扫描，与已接受区间重叠即丢弃。
   */
  function dedupLongest(hits) {
    var sorted = hits.slice().sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start
      return (b.end - b.start) - (a.end - a.start)
    })
    var accepted = []
    for (var i = 0; i < sorted.length; i++) {
      var h = sorted[i]
      var overlap = false
      for (var j = 0; j < accepted.length; j++) {
        var a = accepted[j]
        // a.start <= h.start（排序保证）⇒ 重叠 ⇔ h.start < a.end
        if (h.start < a.end) { overlap = true; break }
      }
      if (!overlap) accepted.push(h)
    }
    return accepted
  }

  // ── 扫描器 ──────────────────────────────────────────────────────────────

  var VALID_SEVERITY = { must: 1, should: 1, nice: 1 }
  var SEV_RANK = { must: 3, should: 2, nice: 1 }

  /**
   * scanText(text, opts)
   *   opts.categories : {id:[words...]}  内置词库（按分类）
   *   opts.enabled    : {id:boolean}     分类开关（false/缺失 ⇒ 该类不扫；custom 走同一张表）
   *   opts.customWords: []|换行文本       用户自定义词（severity=should, category=custom）
   *   opts.ignoreWords: []|换行文本       忽略词（折叠后命中一律剔除，最高优先）
   * → [{word, category, severity, start, end}]，按 start 升序
   */
  function scanText(text, opts) {
    var src = String(text == null ? '' : text)
    if (!src) return []
    var folded = foldCase(src)
    var o = opts && typeof opts === 'object' ? opts : {}
    var enabled = o.enabled && typeof o.enabled === 'object' ? o.enabled : {}
    var cats = o.categories && typeof o.categories === 'object' ? o.categories : {}

    // categories 支持三种形态：
    //   1) 词库数据包原样：[{id, severity, words, ...}]（UI 直接传 WCSensitiveWords.categories）
    //   2) id → words[]（severity 按分类 id 推导）
    //   3) id → {words, severity}
    var catList = []
    if (Array.isArray(cats)) {
      catList = cats
    } else {
      var catIds = Object.keys(cats)
      for (var ci = 0; ci < catIds.length; ci++) {
        var cid = catIds[ci]
        var cv = cats[cid]
        if (Array.isArray(cv)) catList.push({ id: cid, severity: severityOfCategory(cid), words: cv })
        else if (cv && Array.isArray(cv.words)) catList.push({ id: cid, severity: cv.severity || severityOfCategory(cid), words: cv.words })
      }
    }

    var entries = []
    for (var c = 0; c < catList.length; c++) {
      var cat = catList[c]
      if (!enabled[cat.id]) continue
      var words = Array.isArray(cat.words) ? cat.words : []
      var sev = VALID_SEVERITY[cat.severity] ? cat.severity : severityOfCategory(cat.id)
      for (var w = 0; w < words.length; w++) {
        entries.push({ word: words[w], category: cat.id, severity: sev })
      }
    }
    // 自定义词：enabled.custom !== false 时参与（默认开，见配置）
    if (enabled.custom !== false) {
      var custom = parseWordList(o.customWords)
      for (var x = 0; x < custom.length; x++) entries.push({ word: custom[x], category: 'custom', severity: 'should' })
    }
    if (!entries.length) return []

    // 同一折叠词可能来自多个开启分类 ⇒ 合并元数据，severity 取高者
    var byWord = Object.create(null)
    for (var i2 = 0; i2 < entries.length; i2++) {
      var en = entries[i2]
      var ef = foldCase(en.word)
      if (!ef) continue
      var prev = byWord[ef]
      if (!prev || SEV_RANK[en.severity] > SEV_RANK[prev.severity]) {
        byWord[ef] = { word: ef, category: en.category, severity: VALID_SEVERITY[en.severity] ? en.severity : 'should' }
      }
    }
    var merged = Object.keys(byWord).map(function (k) { return byWord[k] })

    // 忽略词：单独建一个 ignore matcher，命中区间用于过滤（ignore 优先于一切）
    var ignores = parseWordList(o.ignoreWords)
    var ignoreRanges = []
    if (ignores.length) {
      var igEntries = ignores.map(function (w) { return { word: w, category: '__ignore__', severity: 'nice' } })
      var igHits = buildMatcher(igEntries).scan(folded)
      ignoreRanges = dedupLongest(igHits)
    }
    function isIgnored(h) {
      for (var i = 0; i < ignoreRanges.length; i++) {
        var r = ignoreRanges[i]
        if (r.start > h.start) break
        if (h.start < r.end && r.start < h.end) return true // 区间相交
      }
      return false
    }

    var raw = buildMatcher(merged).scan(folded)
    var hits = dedupLongest(raw)
    var out = []
    for (var i3 = 0; i3 < hits.length; i3++) {
      if (isIgnored(hits[i3])) continue
      // word 回填为**原串里的原文**（折叠串下标与原串 1:1）
      out.push({
        word: src.slice(hits[i3].start, hits[i3].end),
        category: hits[i3].category,
        severity: hits[i3].severity,
        start: hits[i3].start,
        end: hits[i3].end,
      })
    }
    return out
  }

  /** 分类 id → 默认 severity（custom 不在内置表里，单独 should） */
  function severityOfCategory(id) {
    if (id === 'politics' || id === 'violence' || id === 'porn') return 'must'
    if (id === 'gamble' || id === 'drugs' || id === 'fraud') return 'should'
    return 'nice' // ads / abuse / 未知
  }

  // ── 片段 ────────────────────────────────────────────────────────────────

  /**
   * snippetAround(text, start, end, radius=12)：命中所在句片段。
   * 以命中为中心各取 radius 个字符，再向外扩到**句界标点/换行**（让片段是完整的半句）；
   * 截到边界就停。返回纯文本（调用方用 textContent 渲染，禁 innerHTML）。
   */
  function snippetAround(text, start, end, radius) {
    var src = String(text == null ? '' : text)
    var rad = radius === undefined ? 12 : radius
    if (!isFinite(rad) || rad < 0) rad = 12
    var isStop = function (ch) {
      return '，。！？；：、…—.,!?;:\n\r）)】」』”"'.indexOf(ch) >= 0
    }
    // 从命中边界本身向两侧扩到**最近句界**（上限 rad+24，超长句截在 cap 处），不带上/下句
    var s = start
    var leftFloor = Math.max(0, start - rad - 24)
    while (s > leftFloor && !isStop(src.charAt(s - 1))) s -= 1
    var e2 = end
    var rightCap = Math.min(src.length, end + rad + 24)
    while (e2 < rightCap && !isStop(src.charAt(e2))) e2 += 1
    var prefix = s > 0 ? '…' : ''
    var suffix = e2 < src.length ? '…' : ''
    return prefix + src.slice(s, e2) + suffix
  }

  /** 按分类汇总计数：{categoryId: count}（右栏 chips 用） */
  function summarize(hits) {
    var by = Object.create(null)
    var total = 0
    for (var i = 0; i < (hits || []).length; i++) {
      var h = hits[i]
      by[h.category] = (by[h.category] || 0) + 1
      total += 1
    }
    return { total: total, byCategory: by }
  }

  return {
    foldCase: foldCase,
    foldChar: foldChar,
    parseWordList: parseWordList,
    buildMatcher: buildMatcher,
    dedupLongest: dedupLongest,
    scanText: scanText,
    snippetAround: snippetAround,
    summarize: summarize,
    severityOfCategory: severityOfCategory,
  }
})
