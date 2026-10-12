'use strict'

// ============================================================================
// 写作客户端 · 「纯文本写作区」纯逻辑（B4 · 2026-09-27 用户拍板）
//
// 形态（参考 ai-writing-coach 的写作区）：
//   · **单栏**：只有写作区，**没有源码/预览对照**；
//   · 正文是**纯文本**（contentEditable + `white-space: pre-wrap`）：不做 md 渲染、不做格式工具栏，
//     工作区里仍是 .md 文件，但写作区把内容**原样显示**；
//   · **不用块模型**：整篇一个文本流，Enter = 换行（不新建块）。
//
// 本模块只负责**判据与串行化规则**（零 DOM、零 IPC），与渲染层分工照 send.js / send-net.js 的先例：
//   · domToText     —— contentEditable 子树 ⇒ 纯文本（BR/块元素 ⇒ `\n`）**兜底**用
//   · decideKey     —— 键盘该不该拦（Enter/Shift+Enter 插字面换行；Tab 插两个全角空格缩进；
//                     Shift+Tab 打 dedent 标记；输入法组词中**一律不拦**）
//   · dedentLine    —— Shift+Tab 取消缩进：算出行首要删的区间与新光标
//   · findMatches / replaceAt / replaceAll —— 查找替换的纯逻辑（Ctrl+F 查找条）
//   · buildCopyHtml —— 复制时给剪贴板补 `text/html`（每行一个 `<div>` ⇒ 外部富文本不再行黏连）
//   · pastePlain    —— 从剪贴板只取**纯文本**（不许外部 HTML 带样式进来）
//
// 🔴 两个不能省的拦截（否则纯文本不成立）：
//   ① 默认 Enter 在 contentEditable 里插 `<div>` ⇒ `textContent` **丢换行**；
//   ② 默认粘贴会把外部 HTML（字号/颜色/表格）带进来。
//   ⇒ 拦掉后正文始终是纯文本 + 字面 `\n`；`domToText` 仍留作兜底（Shift+Enter / 输入法 / 浏览器偶发块元素）。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCEditorPlain = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  var TEXT_NODE = 3
  var ELEMENT_NODE = 1

  /** 会被浏览器"当成一整段"的标签 ⇒ 前后要补一个 `\n`（否则 textContent 会把两段粘一起） */
  var BLOCK_TAGS = {
    DIV: 1,
    P: 1,
    LI: 1,
    BLOCKQUOTE: 1,
    PRE: 1,
    H1: 1,
    H2: 1,
    H3: 1,
    H4: 1,
    H5: 1,
    H6: 1,
  }

  /** 缓冲区末尾是否已经是换行（避免给同一处补两个 `\n`） */
  function endsWithNewline(buf) {
    if (!buf.length) return false
    var last = buf[buf.length - 1]
    return typeof last === 'string' && last.slice(-1) === '\n'
  }

  function walk(node, buf) {
    if (!node) return
    var type = node.nodeType
    if (type === TEXT_NODE) {
      buf.push(node.nodeValue == null ? '' : String(node.nodeValue))
      return
    }
    if (type !== ELEMENT_NODE) return // 注释 / 处理指令一律忽略
    var tag = String(node.nodeName || '').toUpperCase()
    if (tag === 'BR') {
      buf.push('\n') // `<br>` 就是一次换行（它自己不带文本）
      return
    }
    var block = !!BLOCK_TAGS[tag]
    if (block && buf.length && !endsWithNewline(buf)) buf.push('\n')
    var kids = node.childNodes || []
    for (var i = 0; i < kids.length; i++) walk(kids[i], buf)
    // 块元素**只补前不补后**：`<div>a</div><div>b</div>` ⇒ `a\nb`（补后会给整篇留尾换行）
  }

  /**
   * contentEditable 子树 ⇒ 纯文本（**兜底**用；正常路径下 DOM 里就是一个文本节点，原样返回）。
   * 规则：文本节点原样；`<br>` ⇒ `\n`；块元素内容前补一个 `\n`（相邻已有 `\n` 则不重复）。
   */
  function domToText(node) {
    var buf = []
    if (node && node.nodeType === TEXT_NODE) return node.nodeValue == null ? '' : String(node.nodeValue)
    walk(node, buf)
    return buf.join('')
  }

  /**
   * 键盘判据（**纯函数**，只读事件字段）。
   * @returns {{prevent:boolean, insert:(string|null), dedent?:boolean}} prevent=true 时调用方要 `preventDefault()`；
   *   insert 非空则插入这个字面文本（Enter ⇒ `'\n'`；Tab ⇒ 两个全角空格）；
   *   dedent=true（Shift+Tab）则由调用方走 `dedentLine` 删行首缩进。
   */
  function decideKey(ev) {
    ev = ev || {}
    // 🔴 输入法组词中：Enter/空格/Tab 是"确认候选"，**绝不能拦**（中文输入必踩；拦了就打不出字）
    if (ev.isComposing === true || ev.keyCode === 229) return { prevent: false, insert: null }
    // Tab ⇒ 段落缩进（插两个全角空格，中文排版惯例）；Shift+Tab ⇒ 取消缩进（dedent 标记）。
    // Ctrl/Alt/Meta+Tab **不拦**：系统切窗 / 浏览器切焦点的语义不能抢。
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (ev.shiftKey) return { prevent: true, insert: null, dedent: true }
      return { prevent: true, insert: '　　' }
    }
    // Enter / Shift+Enter ⇒ 字面换行（不新建块）。
    // Shift+Enter 原先漏给浏览器默认（会造 `<div>` 靠 domToText 兜底），2026-10-13 起显式同 Enter。
    // Ctrl/Alt/Meta+Enter 仍走浏览器默认（domToText 兜底）。
    if (ev.key === 'Enter' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      return { prevent: true, insert: '\n' }
    }
    return { prevent: false, insert: null }
  }

  /**
   * 取消缩进（Shift+Tab）：删 caret 所在行的**行首缩进**，返回要删的区间与新光标。
   * 只动行首：两个全角空格 ＞ 单个全角 ＞ 两个半角 ＞ 单个半角（按这个顺序认）。
   * @param {string} text 编辑器全文
   * @param {number} caret 光标（纯文本下标）
   * @returns {{start:number, end:number, caret:number}|null} 删 `[start,end)`、光标落到 caret；行首无缩进 ⇒ `null`
   */
  function dedentLine(text, caret) {
    var s = String(text == null ? '' : text)
    var c = Number(caret)
    if (!isFinite(c) || c < 0) c = 0
    if (c > s.length) c = s.length
    var lineStart = s.lastIndexOf('\n', c - 1) + 1
    var remove = 0
    if (s.substr(lineStart, 2) === '　　') remove = 2
    else if (s.charAt(lineStart) === '　') remove = 1
    else if (s.substr(lineStart, 2) === '  ') remove = 2
    else if (s.charAt(lineStart) === ' ') remove = 1
    if (!remove) return null
    return { start: lineStart, end: lineStart + remove, caret: Math.max(lineStart, c - remove) }
  }

  /**
   * 全文查找（**纯函数**，node 可单测）。
   * @param {string} text 编辑器全文
   * @param {string} query 查找词（空串 ⇒ 无命中）
   * @param {{caseSensitive?:boolean}} [opts] 默认**不区分大小写**
   * @returns {Array<{start:number, end:number}>} 按出现顺序、**不重叠**（命中后从 end 继续找）
   */
  function findMatches(text, query, opts) {
    var s = String(text == null ? '' : text)
    var q = String(query == null ? '' : query)
    if (!q) return []
    var cs = !!(opts && opts.caseSensitive === true)
    var hay = cs ? s : s.toLowerCase()
    var needle = cs ? q : q.toLowerCase()
    var out = []
    var pos = 0
    for (;;) {
      var i = hay.indexOf(needle, pos)
      if (i < 0) break
      out.push({ start: i, end: i + needle.length })
      pos = i + needle.length
    }
    return out
  }

  /**
   * 替换 `[start,end)` 区间 ⇒ `{text, caret}`（caret 落在替换后文本的末尾；区间自动夹紧，不抛）。
   */
  function replaceAt(text, start, end, replacement) {
    var s = String(text == null ? '' : text)
    var a = Number(start) || 0
    var b = Number(end) || 0
    a = Math.max(0, Math.min(a, s.length))
    b = Math.max(a, Math.min(b, s.length))
    var rep = String(replacement == null ? '' : replacement)
    return { text: s.slice(0, a) + rep + s.slice(b), caret: a + rep.length }
  }

  /**
   * 全部替换 ⇒ `{text, count}`。大小写口径与 `findMatches` 一致；
   * 🔴 扫的是**原文**（替换串里含 query 也不会死循环）；query 为空 ⇒ 原样 + 0。
   */
  function replaceAll(text, query, replacement, opts) {
    var s = String(text == null ? '' : text)
    var q = String(query == null ? '' : query)
    if (!q) return { text: s, count: 0 }
    var cs = !!(opts && opts.caseSensitive === true)
    var hay = cs ? s : s.toLowerCase()
    var needle = cs ? q : q.toLowerCase()
    var rep = String(replacement == null ? '' : replacement)
    var out = []
    var pos = 0
    var count = 0
    for (;;) {
      var i = hay.indexOf(needle, pos)
      if (i < 0) break
      out.push(s.slice(pos, i), rep)
      pos = i + needle.length
      count += 1
    }
    if (!count) return { text: s, count: 0 }
    out.push(s.slice(pos))
    return { text: out.join(''), count: count }
  }

  /** HTML 转义（`buildCopyHtml` 用；原文里的 `< & > "` 不能变成标签） */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /**
   * 纯文本 ⇒ 复制用的 `text/html`：**每行一个 `<div>`，空行补 `<br>`**。
   * 🔴 为什么必须有它（2026-10-13 用户报「复制到别的富文本编辑器里不同行黏连」）：
   *   写作区整篇是**一个文本节点**，换行只是字面 `\n`，DOM 里没有 `<br>`/`<div>` ——
   *   浏览器默认生成的 text/html 里也就没有换行标签，贴进 Word/飞书等时 `\n` 被当空白折叠 ⇒ 行黏连。
   *   复制时显式给出块结构，外部富文本按块解析，行就不再黏。
   *   CRLF 文本的行尾 `\r` 顺手剥掉（不把 `\r` 带进 HTML）。
   */
  function buildCopyHtml(text) {
    var lines = String(text == null ? '' : text).split('\n')
    var out = []
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (line.slice(-1) === '\r') line = line.slice(0, -1)
      out.push(line === '' ? '<div><br></div>' : '<div>' + escapeHtml(line) + '</div>')
    }
    return out.join('')
  }

  /**
   * 从剪贴板只取**纯文本**（拿不到 ⇒ `''`）。
   * 顺手把 `\r\n` / `\r` 归一为 `\n`：粘贴进来的是**新内容**，不是既有文件内容，
   * 归一不会改动磁盘上已有的任何字节（`setValue` 那条路**不做**归一，保证读写往返一字不差）。
   */
  function pastePlain(clipboardData) {
    if (!clipboardData || typeof clipboardData.getData !== 'function') return ''
    var raw = ''
    try {
      raw = clipboardData.getData('text/plain')
    } catch (e) {
      return ''
    }
    return String(raw == null ? '' : raw).replace(/\r\n?/g, '\n')
  }

  /**
   * 写作区的「有没有归属」判据（**纯函数**，node 可单测）。
   *
   * 🔴 为什么要有这个判据（缺陷 D-6，2026-09-28 用户实测）：
   *   写作区是**常开可编辑**的，但没选文档时内容**没有保存目标** ——
   *   自动保存（`flush`）与草稿兜底都会**静默跳过**，切文档时又会被直接覆盖 ⇒ **丢字且无提示**。
   *   规则一句话：**没有归属就不让写**（`editable = !!hasDoc`）。
   *   「没有工作区」是更前置的一种无归属：连落点都不存在，文案要说清是"先去建/选工作区"。
   *
   * @param {{hasDoc?:boolean, hasRoot?:boolean}} o
   * @returns {{editable:boolean, title:string, hint:string, canQuickNew:boolean}}
   */
  function lockState(o) {
    o = o || {}
    var hasDoc = o.hasDoc === true
    var hasRoot = o.hasRoot === true
    if (hasDoc) {
      return { editable: true, title: '', hint: '', canQuickNew: false }
    }
    if (!hasRoot) {
      return {
        editable: false,
        title: '未选择工作区',
        hint: '还没有工作区：请先在左侧选择或新建一个工作区，再开始写。',
        canQuickNew: false,
      }
    }
    return {
      editable: false,
      title: '未打开文档',
      hint: '没选文档时，写进来的内容没有保存目标（自动保存与草稿兜底都会跳过）⇒ 已锁定以免丢字。请在左侧选一篇，或点下面的「新建一篇」。',
      canQuickNew: true,
    }
  }

  return {
    TEXT_NODE: TEXT_NODE,
    ELEMENT_NODE: ELEMENT_NODE,
    BLOCK_TAGS: BLOCK_TAGS,
    domToText: domToText,
    decideKey: decideKey,
    dedentLine: dedentLine,
    findMatches: findMatches,
    replaceAt: replaceAt,
    replaceAll: replaceAll,
    escapeHtml: escapeHtml,
    buildCopyHtml: buildCopyHtml,
    pastePlain: pastePlain,
    lockState: lockState,
  }
})
