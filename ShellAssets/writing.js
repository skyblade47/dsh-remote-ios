/* ============================================================================
   写作页（阶段② v1）—— 渲染层逻辑
   加载于壳层页面（与 [DSH] iframe 同源），通过 preload 暴露的 window.wcStorage 触达本地文件。

   目录结构：<工作区根>/<作品>/<章>.md    （作品 = 子目录，一 md 一文档）

   本文件把「**写作区**」做成一个**独立、可替换**的单元（B4 起**只有一个区块**）：
     ┌ EDITOR BLOCK ──────────────────────────────────────────────┐
     │ 当前 = **纯文本所见即所得写作区**（contentEditable + pre-wrap）│
     │ 对外契约：getText / setValue / onChange / focus / el          │
     └────────────────────────────────────────────────────────────┘
   ⇒ 换实现（如将来改富文本）**只需重写 EDITOR BLOCK**：保持上面那组方法名，
     其余（自动保存 / 状态栏 / 草稿保险 / 番茄钟 / 发送给任务中心）一行都不用改。
   🔴 **单栏形态**（2026-09-27 用户拍板，参考 ai-writing-coach 的写作区）：
     · 原「md 源码 textarea + 实时预览 HTML」的**并排对照已取消**（PREVIEW BLOCK 整块删除）；
     · 正文是**纯文本**：不做 md 渲染、没有格式工具栏 —— 工作区里仍是 .md 文件，
       但写作区把内容**原样显示**（`# 标题`、`**粗体**` 以字面量出现）；
     · **不用块模型**：整篇一个文本流，Enter = 换行（纯逻辑见 editor-plain.js，node 可单测）。

   ── 左栏的**三层**（设计文档 §18「作品隔离与查找」）──────────────────────────
     ① 空态 `#w-side-empty`：尚未选工作区 ⇒ 「选择已有目录」+ 壳层自己「新建工作区」
        （Windows 原生对话框的"新建文件夹"在本机会直接报没有权限 ⇒ 不能依赖它；
         候选父目录刻意避开 OneDrive 同步区，见 main.js 的 localParents()）
     ② 作品卡片墙 `#w-works-view`（顶层）：作品卡片 = 名字 + 章数 + 最后修改；点卡片进入作品
     ③ 作品内文档树 `#w-tree-view`：该作品的 .md 列表 + 搜索 + 新建文档；左上角「← 所有作品」返回
   两病两药（§18.1）：**跨作品**靠卡片墙（治"作品互相干扰"），
                     **作品内**靠"只看一个作品的树 + 搜索"（治"章节多、一长条平铺"）。

   ── 与"不丢稿"有关的两块（设计文档 §22）──────────────────────────────────────
     · 关窗/切页前 flush + 草稿保险（userData/drafts）；主进程拦一次窗口 close 等这里回执；
     · **启动横幅**：上次会话有保存失败 / 有没落正式盘的草稿 ⇒ 写作页顶部一条**非阻塞**、
       可关闭的横幅（**不是模态**；原来这里的 window.confirm 已并入它，避免两个弹窗打架）。
   =========================================================================== */

;(function () {
  'use strict'

  // 自动保存去抖：**默认 1000**，可由配置覆盖（「设置 → 编辑器 → 自动保存去抖」）。
  // 启动时从 getState().settings.autosave.debounceMs 读入（见 init），改设置后**立即生效**（applySettings）。
  var DEBOUNCE_MS = 1000
  // 草稿保险的周期：比自动保存去抖**长**（5s）。它是**兜底**（崩溃/强杀时少丢一点），
  // 不是主保存路径；只要还脏就周期写一份到 userData/drafts（与工作区解耦）。
  var DRAFT_MS = 5000

  var api = window.wcStorage
  var WCWCore = window.WCWritingCore
  // 上一次上报给主进程的「有无未保存内容」——变了才发（主进程据此决定关窗要不要拦一次）
  var lastReportedDirty = null
  // 启动横幅的数据（本轮）：上次会话的失败记录 + 未落正式盘的草稿
  var bannerState = { failed: [], drafts: [] }

  // ── 状态 ────────────────────────────────────────────────────────────────
  var state = {
    root: null,
    treeError: '',
    works: [],
    view: 'empty', // empty | works | tree | trash —— 左栏四层（§18 + B3）
    currentWork: null, // 已进入的作品名（view==='tree' 时有效）
    worksQuery: '',
    docQuery: '',
    hint: '', // 空态里的可操作提示（多行文本）
    // B3：当前展开的「⋯」操作面板（key = 'd:<relPath>' | 'w:<作品名>'；mode = menu | rename | move）
    ops: { key: null, mode: null },
    trash: [], // B3：回收站条目（listTrash 的 items 原样）
    // ⑪ C11 多端文档同步：
    //   baseline —— `userData/sync/baseline.json` 的内存镜像（纯函数增删，见 sync-core.js）
    //   list     —— 远端清单缓存 `{ at, index }`（`index` = sync-core 的 indexList 结果，含 `known`）
    //   last     —— 最近一次判定结论（排障/自测用）
    //   pending  —— 横幅上等待用户决策的那一条 `{ relPath, kind, detail }`
    //   seq      —— 递增令牌：切文档后旧请求的结论**必须丢弃**（否则会把 A 的结论画到 B 身上）
    sync: { baseline: null, list: null, last: null, note: '', pending: null, seq: 0, listPending: false, sig: '',
      // ⑪ C11 补（2026-09-29 用户报「保存不推线上」）：
      //   pushWanted —— 待推的那一份 `{rel, text}`（自动保存会反复覆盖它，只推最后一份）
      //   pushTimer  —— 去抖/补推定时器（**保证最终一定推**，不会因为节流把最后一段改动丢掉）
      //   lastPushAt —— 上次**成功**推送的时刻（算最小间隔用）
      pushWanted: null, pushTimer: null, lastPushAt: 0 },
    // ⑥ CR-6 分栏：on = 写作页与对话页并排；ratio = 写作页占的宽度比例（0.2–0.8）；
    //   docs / board = 左栏 / 右栏浮层**当前是否展开**（只在分栏时有意义，是瞬时 UI 态、不落盘）
    split: { on: false, ratio: 0.5, docs: false, board: false },
    defaultRootName: 'dsh工作区',
    suggestedRoot: '',
    draftsDir: '', // 草稿兜底落点（主进程给；横幅里如实告诉用户"内容在哪"）
    // ⑥ B5：校对专用会话 id（客户端首次校对时自动新建 ⇒ 落配置复用；空 = 还没建）
    proofreadSessionId: '',
    current: null, // { relPath, work, name }
    dirty: false,
    saveState: 'idle', // idle | dirty | saving | saved | error
    lastSavedAt: 0,
    lastError: '',
    timer: null,
    pickAttempted: false,
    importBusy: false,
    pomodoro: { focusMin: 25, breakMin: 5, autoNext: true },
    // 「设置」弹层的配置（主进程回的是**已 clamp 归一化**的值）——默认值与"没这层设置时"逐项一致
    settings: {
      autosave: { debounceMs: 1000 },
      drafts: { maxFiles: 200, maxBytes: 5 * 1024 * 1024, notifyOnStartup: true },
      theme: 'auto',
      // ── 「排版」两组（中文码字）——逐项默认 = **加本组之前的行为**（见 main.js 的 SETTINGS_DEFAULTS）
      //    输入区（textarea）只能做这 6 类；段间距 / 首行缩进是**富文本能力**，textarea 没有（见下 preview）
      editor: {
        fontSize: 0, // 0 = 跟随 --dsh-content-font-size（原行为，既有键）
        fontFamily: 'mono', // mono(原行为/等宽) | serif | sans | dsh(跟随 [DSH])
        lineHeight: 0, // 0 = 跟随 --dsw-font-markdown-base-line-height（原行为）
        letterSpacing: 0, // 0 = 无字间距（原行为）
        measure: 0, // 0 = 跟随窗口/不限宽（原行为）
        colorPreset: 'default', // default(走 --dsw-*) | sepia(米白) | green(淡绿)
      },
      // 预览区是 **HTML**（渲染结果）⇒ 可做全套：字号/行高/字体族 + **段间距** + **首行缩进**
      preview: {
        fontSize: 0, // 0 = 跟随 [DSH] 字号轴（原行为）
        lineHeight: 0, // 0 = 跟随 token（原行为）
        fontFamily: 'auto', // auto = 跟随 [DSH]（原行为）
        paraSpacing: 'auto', // 'auto' = 原 `.6em` 段间距（原行为）；0–2 em 为显式值
        indent: 0, // 0 = 不缩进（原行为）
      },
      remote: { gateway: '', port: 18080 },
    },
    // 「远程」的**当前生效值**（启动时解析；env 可能覆盖 config）⇒ UI 里如实显示"重启生效"
    remoteEffective: null,
  }

  var els = {
    saveBtn: document.getElementById('w-save'),
    save: document.getElementById('w-status-save'),
    autosave: document.getElementById('w-autosave'),
    count: document.getElementById('w-count'),
    path: document.getElementById('w-path'),
    msg: document.getElementById('w-msg'),
    // ① 空态
    sideEmpty: document.getElementById('w-side-empty'),
    emptyHint: document.getElementById('w-empty-hint'),
    hintText: document.getElementById('w-empty-hint-text'),
    hintCreate: document.getElementById('w-hint-create'),
    hintClose: document.getElementById('w-hint-close'),
    pickRoot: document.getElementById('w-pick-root'),
    newRootName: document.getElementById('w-new-root-name'),
    createRoot: document.getElementById('w-create-root'),
    createRootHere: document.getElementById('w-create-root-here'),
    // ①-a 常驻工作区栏（「工作区：<路径> ▾ 切换」）
    wsBar: document.getElementById('w-ws-bar'),
    wsMenu: document.getElementById('w-ws-menu'),
    wsPop: document.getElementById('w-ws-pop'),
    wsSwitch: document.getElementById('w-ws-switch'),
    wsName: document.getElementById('w-ws-name'),
    wsCreate: document.getElementById('w-ws-create'),
    wsCreateHere: document.getElementById('w-ws-create-here'),
    // ② 作品卡片墙
    sideWorks: document.getElementById('w-works-view'),
    rootLabel: document.getElementById('w-root-label'),
    refresh: document.getElementById('w-refresh'),
    importWorks: document.getElementById('w-import-works'),
    worksSearch: document.getElementById('w-works-search'),
    worksGrid: document.getElementById('w-works-grid'),
    newWorkName: document.getElementById('w-new-work-name'),
    newWork: document.getElementById('w-new-work'),
    // ③ 作品内
    sideTree: document.getElementById('w-tree-view'),
    backWorks: document.getElementById('w-back-works'),
    treeWorkName: document.getElementById('w-tree-work-name'),
    importTree: document.getElementById('w-import-tree'),
    docSearch: document.getElementById('w-doc-search'),
    newDocName: document.getElementById('w-new-doc-name'),
    newDoc: document.getElementById('w-new-doc'),
    tree: document.getElementById('w-tree'),
    // ③-b 回收站（B3）
    trashOpen: document.getElementById('w-trash-open'),
    sideTrash: document.getElementById('w-trash-view'),
    trashBack: document.getElementById('w-trash-back'),
    trashCount: document.getElementById('w-trash-count'),
    trashList: document.getElementById('w-trash-list'),
    // ②-b 导入模态
    importBox: document.getElementById('w-import'),
    importClose: document.getElementById('w-import-close'),
    importWork: document.getElementById('w-import-work'),
    importNewWork: document.getElementById('w-import-newwork'),
    importFilesBtn: document.getElementById('w-import-files'),
    importDirBtn: document.getElementById('w-import-dir'),
    importNote: document.getElementById('w-import-note'),
    importResult: document.getElementById('w-import-result'),
    // ④ 启动横幅（「上次有内容没保存成功」·非阻塞·可关闭）
    banner: document.getElementById('w-banner'),
    bannerTitle: document.getElementById('w-banner-title'),
    bannerList: document.getElementById('w-banner-list'),
    bannerNote: document.getElementById('w-banner-note'),
    bannerClose: document.getElementById('w-banner-close'),
    bannerRetry: document.getElementById('w-banner-retry'),
    bannerOpen: document.getElementById('w-banner-open'),
    bannerDismiss: document.getElementById('w-banner-dismiss'),
    // ⑪ C11 多端文档同步：专用横幅（另一组动作）+ 状态栏指示
    syncBanner: document.getElementById('w-sync-banner'),
    syncTitle: document.getElementById('w-sync-title'),
    syncNote: document.getElementById('w-sync-note'),
    syncClose: document.getElementById('w-sync-close'),
    syncReupload: document.getElementById('w-sync-reupload'),
    syncTakeRemote: document.getElementById('w-sync-take-remote'),
    syncKeepLocal: document.getElementById('w-sync-keep-local'),
    syncTrashLocal: document.getElementById('w-sync-trash-local'),
    syncState: document.getElementById('w-sync'),
    // ⑪ D-sync-1：横幅「看远端内容」入口 + 只读浮层（看清远端新旧再决定，不碰本地一字）
    syncRemoteView: document.getElementById('w-sync-remote-view'),
    remoteView: document.getElementById('w-remote-view'),
    remoteViewTitle: document.getElementById('w-remote-view-title'),
    remoteViewBody: document.getElementById('w-remote-view-body'),
    remoteViewClose: document.getElementById('w-remote-view-close'),
    // ③ 查找/替换条（Ctrl+F 开合；纯逻辑在 editor-plain.js 与 node 单测同一份）
    findbar: document.getElementById('w-findbar'),
    findInput: document.getElementById('w-find-input'),
    findCount: document.getElementById('w-find-count'),
    findPrev: document.getElementById('w-find-prev'),
    findNext: document.getElementById('w-find-next'),
    findCase: document.getElementById('w-find-case'),
    replaceInput: document.getElementById('w-replace-input'),
    replaceOne: document.getElementById('w-replace-one'),
    replaceAll: document.getElementById('w-replace-all'),
    findClose: document.getElementById('w-find-close'),
    // ③ 实体按钮入口（iPad 无 Tab/Ctrl 键，见 shell.html 工具栏注释）
    findOpenBtn: document.getElementById('w-find-open'),
    indentBtn: document.getElementById('w-indent'),
    dedentBtn: document.getElementById('w-dedent'),
    // 中栏（B4 起只有写作区）/ 番茄钟
    editor: document.getElementById('w-editor'),
    // 🔴 D-6：写作区锁定时的覆盖层（未选文档 / 未选工作区）
    editorEmpty: document.getElementById('w-editor-empty'),
    editorEmptyTitle: document.getElementById('w-editor-empty-title'),
    editorEmptyHint: document.getElementById('w-editor-empty-hint'),
    editorNewDoc: document.getElementById('w-editor-newdoc'),
    // ⑥ CR-6 分栏：开关 + 两个浮层入口 + 两个被浮层化的栏
    split: document.getElementById('w-split'),
    splitDocs: document.getElementById('w-docs'),
    splitBoard: document.getElementById('w-board'),
    sidebar: document.getElementById('w-sidebar'),
    right: document.getElementById('w-right'),
    pomoTime: document.getElementById('w-pomo-time'),
    pomoMode: document.getElementById('w-pomo-mode'),
    pomoToggle: document.getElementById('w-pomo-toggle'),
    pomoReset: document.getElementById('w-pomo-reset'),
    pomoNote: document.getElementById('w-pomo-note'),
    focusMin: document.getElementById('w-focus-min'),
    breakMin: document.getElementById('w-break-min'),
    // ⑤ 「设置」弹层（壳层级；DOM 在 body 下，不在 #page-writing 里）
    setBtn: document.getElementById('shell-settings'),
    setBox: document.getElementById('s-modal'),
    setClose: document.getElementById('s-close'),
    setRoot: document.getElementById('s-root'),
    setName: document.getElementById('s-ws-name'),
    setSwitch: document.getElementById('s-ws-switch'),
    setCreate: document.getElementById('s-ws-create'),
    setCreateHere: document.getElementById('s-ws-create-here'),
    setDebounce: document.getElementById('s-debounce'),
    setFontSize: document.getElementById('s-fontsize'),
    // ③ 排版（B4 起只有**写作区**一组）+ 一键预设
    setTypoEditorFF: document.getElementById('s-typo-editor-ff'),
    setTypoLineHeight: document.getElementById('s-typo-lineheight'),
    setTypoLineHeightRec: document.getElementById('s-typo-lh-recommend'),
    setTypoLetterSpacing: document.getElementById('s-typo-letterspacing'),
    setTypoMeasure: document.getElementById('s-typo-measure'),
    setTypoColor: document.getElementById('s-typo-color'),
    typoPresetDefault: document.getElementById('s-typo-default'),
    typoPresetComfort: document.getElementById('s-typo-comfort'),
    typoPresetCompact: document.getElementById('s-typo-compact'),
    typoPresetNote: document.getElementById('s-typo-preset-note'),
    setFocus: document.getElementById('s-focus'),
    setBreak: document.getElementById('s-break'),
    setAutoNext: document.getElementById('s-autonext'),
    setDraftFiles: document.getElementById('s-draft-files'),
    setDraftBytes: document.getElementById('s-draft-bytes'),
    setDraftTotal: document.getElementById('s-draft-total'), // 总容量上限（MB）
    setDraftsUsage: document.getElementById('s-drafts-usage'), // 设置页「当前占用」
    draftsUsageLabel: document.getElementById('w-drafts-usage'), // 状态栏「草稿 占用/上限（%）」
    setNotify: document.getElementById('s-notify'),
    setDraftsDir: document.getElementById('s-drafts-dir'),
    setSendIntents: document.getElementById('s-send-intents'), // ⑨ 诉求预设（**可自定义**，2026-09-28）
    setGateway: document.getElementById('s-gateway'),
    setPort: document.getElementById('s-port'),
    setRemoteMode: document.getElementById('s-remote-mode'), // ⑨ C9：入口 自动 / 手动
    setProofSession: document.getElementById('s-proof-session'),
    setRemoteNote: document.getElementById('s-remote-note'), // 静态规则（不覆盖）
    setRemoteEff: document.getElementById('s-remote-eff'), // ⑨ C9：入口实况（本次生效 + 顺位 + 逐条结果）
    setRestart: document.getElementById('s-restart'), // ⑩ U-20 #40④：一键重启客户端
    // ⑧ T-10：启动与托盘
    setAutoStart: document.getElementById('s-autostart'),
    setTray: document.getElementById('s-tray'),
    setTrayNote: document.getElementById('s-tray-note'),
  }

  // ════════════════════════════════════════════════════════════════════════
  // EDITOR BLOCK（可替换单元）—— 当前实现：**纯文本所见即所得写作区**（contentEditable）
  // 对外契约（换实现时保持一致）：
  //   getText():string  setValue(s):void  onChange(cb):void  focus():void  el
  //
  // 🔴 为什么必须拦 Enter / 粘贴（不能全交给浏览器默认）：
  //   ① contentEditable 默认的 Enter 会插 `<div>` ⇒ `textContent` **拿不到换行**（存盘就丢空行）；
  //   ② 默认粘贴会把外部 HTML（字号/颜色/表格）带进来 ⇒ 破坏"纯文本"这一前提。
  //   拦掉后正文始终是**纯文本 + 字面 `\n`**，`white-space: pre-wrap` 负责显示。
  //   判据（含输入法组词保护）全在 editor-plain.js，与 node 单测跑**同一份**。
  // ════════════════════════════════════════════════════════════════════════
  var Editor = (function () {
    var box = els.editor
    var Plain = window.WCEditorPlain

    /** 编辑器全文（判据与发送/校对同一份：`Plain.domToText`） */
    function getText() {
      if (!box) return ''
      return Plain ? Plain.domToText(box) : (box.textContent || '')
    }

    /** 把光标处的选区替换成一段纯文本（`execCommand` 失败时手工做 range 插节点） */
    function insertText(text) {
      try {
        // ⚠️ execCommand 已废弃，但它是**零依赖**且能进浏览器原生 undo 栈的唯一手段；
        //    子系统局限在本函数内 ⇒ 将来换实现只动这里。
        if (document.execCommand('insertText', false, text)) return
      } catch (e) { /* 落到手工路径 */ }
      var sel = window.getSelection()
      if (!sel || !sel.rangeCount) return
      var r = sel.getRangeAt(0)
      r.deleteContents()
      var node = document.createTextNode(text)
      r.insertNode(node)
      r.setStartAfter(node)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      box.dispatchEvent(new Event('input', { bubbles: true })) // 手工路径不触发 input ⇒ 补（自动保存靠它）
    }

    // ── 纯文本下标 ⇄ DOM 选区 的换算（③ 查找替换 / Shift+Tab 用）──────────────
    // 走法与 `Plain.domToText` **同一套**（文本节点原样、BR 算 1、块元素前补 \n）⇒ 下标对得上。
    // 正常路径整篇是一个文本节点 ⇒ 换算就是加减法；多节点是输入法/浏览器的偶发兜底，尽量一致。
    function indexOf(target, offset) {
      var idx = 0
      var done = false
      var lastChar = ''
      function walk(n) {
        if (done) return
        if (n.nodeType === 3) {
          if (n === target) { idx += offset; done = true; return }
          var v = n.nodeValue || ''
          idx += v.length
          if (v) lastChar = v.charAt(v.length - 1)
          return
        }
        if (n.nodeType !== 1) return
        if (n.nodeName === 'BR') { idx += 1; lastChar = '\n'; return }
        if (n === target) {
          // 端点落在元素上：offset 是子节点序号 ⇒ 累计前 offset 个子节点的文本长
          var kids = n.childNodes
          for (var i = 0; i < offset && i < kids.length; i++) walk(kids[i])
          done = true
          return
        }
        if (Plain && Plain.BLOCK_TAGS[n.nodeName] && idx > 0 && lastChar !== '\n') { idx += 1; lastChar = '\n' }
        var ks = n.childNodes
        for (var j = 0; j < ks.length; j++) walk(ks[j])
      }
      walk(box)
      return idx
    }

    /** 当前选区的纯文本下标（无选区 / 选区不在写作区内 ⇒ null） */
    function caretOffsets() {
      var sel = window.getSelection()
      if (!sel || !sel.rangeCount) return null
      var r = sel.getRangeAt(0)
      if (!box.contains(r.startContainer) || !box.contains(r.endContainer)) return null
      return { start: indexOf(r.startContainer, r.startOffset), end: indexOf(r.endContainer, r.endOffset) }
    }

    /** 纯文本下标 ⇒ DOM 位置（超界 ⇒ 夹到末尾） */
    function locate(pos) {
      var idx = 0
      var lastChar = ''
      var found = null
      function walk(n) {
        if (found) return
        if (n.nodeType === 3) {
          var v = n.nodeValue || ''
          if (v.length && pos <= idx + v.length) { found = { node: n, offset: pos - idx }; return }
          idx += v.length
          if (v) lastChar = v.charAt(v.length - 1)
          return
        }
        if (n.nodeType !== 1) return
        if (n.nodeName === 'BR') { idx += 1; lastChar = '\n'; return }
        if (Plain && Plain.BLOCK_TAGS[n.nodeName] && idx > 0 && lastChar !== '\n') { idx += 1; lastChar = '\n' }
        var ks = n.childNodes
        for (var i = 0; i < ks.length; i++) walk(ks[i])
      }
      walk(box)
      if (found) return found
      var lastText = null
      ;(function scan(n) {
        if (n.nodeType === 3) { lastText = n; return }
        if (n.nodeType !== 1) return
        var ks = n.childNodes
        for (var i = 0; i < ks.length; i++) scan(ks[i])
      })(box)
      if (lastText) return { node: lastText, offset: (lastText.nodeValue || '').length }
      return { node: box, offset: 0 }
    }

    /** 把选区设到纯文本下标 [start,end)（查找命中高亮 / Shift+Tab 选中缩进用） */
    function selectOffsets(start, end) {
      var a = locate(start)
      var b = end === start ? a : locate(end)
      var sel = window.getSelection()
      if (!sel) return
      var r = document.createRange()
      r.setStart(a.node, a.offset)
      r.setEnd(b.node, b.offset)
      sel.removeAllRanges()
      sel.addRange(r)
    }

    /** 把当前选区滚进写作区可视区（查找跳转用；滚动体就是 `.w-editor` 自己） */
    function scrollSelectionIntoView() {
      var sel = window.getSelection()
      if (!sel || !sel.rangeCount) return
      var rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!rect) return
      var host = box.getBoundingClientRect()
      if (rect.top < host.top || rect.bottom > host.bottom) {
        box.scrollTop = Math.max(0, box.scrollTop + (rect.top - host.top) - host.height / 3)
      }
    }

    /** Shift+Tab：删行首缩进（选中后走原生 delete ⇒ 进 undo 栈；失败才整篇重设） */
    function dedentAtCaret() {
      var off = caretOffsets()
      if (!off) return
      var r = Plain.dedentLine(getText(), off.start)
      if (!r) return
      selectOffsets(r.start, r.end)
      var ok = false
      try { ok = document.execCommand('delete') } catch (e) { ok = false }
      if (!ok) {
        var t = getText()
        box.textContent = t.slice(0, r.start) + t.slice(r.end)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
      selectOffsets(r.caret, r.caret)
    }

    /** 占位提示：contentEditable 没有 ::placeholder ⇒ 用 `data-empty` 标记（`:empty` 会被一个空 `<br>` 破掉） */
    function syncEmpty() {
      if (!box) return
      var empty = (Plain ? Plain.domToText(box) : box.textContent || '') === ''
      box.setAttribute('data-empty', empty ? '1' : '0')
    }

    /**
     * 🔴 复制/剪切黏连修复（2026-10-13 用户报「复制到别的富文本编辑器里不同行黏连」）：
     *   整篇是一个文本节点 ⇒ 浏览器默认生成的 text/html 里**没有换行标签**，
     *   贴进 Word/飞书等外部富文本时 `\n` 被当空白折叠 ⇒ 行黏连。
     *   这里把两种格式写全：`text/plain` 原样、`text/html` 按行给 `<div>`（外部按块解析）。
     * @returns {string} 取出的选区文本（空 ⇒ 调用方不动剪贴板）
     */
    function fillClipboard(e) {
      var sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return ''
      var r = sel.getRangeAt(0)
      if (!box.contains(r.startContainer) || !box.contains(r.endContainer)) return ''
      var text = String(sel.toString() || '')
      if (!text) return ''
      e.preventDefault()
      e.clipboardData.setData('text/plain', text)
      e.clipboardData.setData('text/html', Plain.buildCopyHtml(text))
      return text
    }

    function init() {
      if (!box) return
      // 初始内容为空 ⇒ 先把占位标记打上（写入/读文档时会由 setValue 再同步一次）
      syncEmpty()
      if (!Plain) {
        console.error('[wc] editor-plain.js 未加载（window.WCEditorPlain 缺失）：Enter/粘贴拦截与占位标记不生效')
        return
      }
      box.addEventListener('keydown', function (e) {
        var d = Plain.decideKey({
          key: e.key,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          isComposing: e.isComposing,
          keyCode: e.keyCode,
        })
        if (!d.prevent) return
        e.preventDefault()
        if (d.insert) { insertText(d.insert); return }
        if (d.dedent) dedentAtCaret()
      })
      box.addEventListener('paste', function (e) {
        e.preventDefault()
        var text = Plain.pastePlain(e.clipboardData)
        if (text) insertText(text) // 插入会触发 input ⇒ onChange（undo 栈也保住了）
      })
      box.addEventListener('copy', function (e) { if (e.clipboardData) fillClipboard(e) })
      // 剪切 = 复制 + 删掉选区（preventDefault 后浏览器不删 ⇒ 自己删，走原生 delete 保 undo 栈）
      box.addEventListener('cut', function (e) {
        if (!e.clipboardData || !fillClipboard(e)) return
        var ok = false
        try { ok = document.execCommand('delete') } catch (err) { ok = false }
        if (!ok) {
          var sel = window.getSelection()
          if (sel && sel.rangeCount) sel.getRangeAt(0).deleteContents()
          box.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      box.addEventListener('input', syncEmpty)
    }

    /**
     * 锁定 / 解锁写作区（D-6：**没有归属就不让写**）。
     * `contenteditable=false` 是硬闸门 —— 不是靠提示劝退，而是**物理上打不进字**。
     * 顺带 class 供 CSS 用（光标语义 + 关掉"在此写正文…"那句诱导性占位）。
     */
    function setEditable(on) {
      if (!box) return
      box.contentEditable = on ? 'true' : 'false'
      box.classList.toggle('w-editor-locked', !on)
      if (!on) box.blur()
    }

    if (box) init()

    return {
      el: box,
      setEditable: setEditable,
      getText: getText,
      setValue: function (v) {
        if (!box) return
        box.textContent = v == null ? '' : String(v)
        syncEmpty()
      },
      onChange: function (cb) {
        if (box) box.addEventListener('input', cb)
      },
      focus: function () {
        if (box) box.focus()
      },
      // ③ 查找替换 / 缩进用（纯逻辑在 editor-plain.js；这些是 DOM 侧仅有的几个钩子）
      insertText: insertText,
      dedent: dedentAtCaret,
      caretOffsets: caretOffsets,
      selectOffsets: selectOffsets,
      scrollSelectionIntoView: scrollSelectionIntoView,
    }
  })()

  // ── ③ 查找/替换条（2026-10-13 三段优化 · 第一段）──────────────────────────
  // 纯逻辑（findMatches / replaceAt / replaceAll）在 editor-plain.js、与 node 单测跑同一份；
  // 这里只做 DOM：命中用**原生选区**选中并滚进可视区（不改正文 DOM、不打断输入）。
  var findState = { matches: [], current: -1 }

  function findIsOpen() { return !!(els.findbar && !els.findbar.hidden) }
  function findQuery() { return els.findInput ? els.findInput.value : '' }
  function findCaseOn() { return !!(els.findCase && els.findCase.checked) }

  function findOpen() {
    if (!els.findbar) return
    els.findbar.hidden = false
    // 预填：写作区里有**单行**选区 ⇒ 拿它当查找词
    var selText = ''
    try {
      var sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        var r = sel.getRangeAt(0)
        if (Editor.el && Editor.el.contains(r.startContainer) && Editor.el.contains(r.endContainer)) {
          selText = String(sel.toString() || '')
          if (selText.indexOf('\n') >= 0) selText = ''
        }
      }
    } catch (e) { selText = '' }
    if (els.findInput) {
      if (selText) els.findInput.value = selText
      els.findInput.focus()
      els.findInput.select()
    }
    findRefresh(true)
  }

  /** 只收条、清状态（`focusEditor=false` 供切文档等内部路径用） */
  function findHide(focusEditor) {
    if (els.findbar) els.findbar.hidden = true
    findState.matches = []
    findState.current = -1
    if (focusEditor !== false) Editor.focus()
  }
  function findClose() { findHide(true) }

  /**
   * 重算命中，并把"当前命中"对齐到光标（光标正落在某命中上 ⇒ 以它为准，替换后不跳走）。
   * @param {boolean} jump true ⇒ 把当前命中选上并滚进可视区；false ⇒ 只刷新计数（写作区输入时）
   */
  function findRefresh(jump) {
    if (!findIsOpen()) return
    var Plain = window.WCEditorPlain
    var q = findQuery()
    findState.matches = Plain && q ? Plain.findMatches(Editor.getText(), q, { caseSensitive: findCaseOn() }) : []
    var n = findState.matches.length
    if (!n) {
      findState.current = -1
      if (els.findCount) els.findCount.textContent = q ? '无结果' : ''
      return
    }
    var off = Editor.caretOffsets()
    var pos = off ? off.start : 0
    var cur = 0
    for (var i = 0; i < n; i++) {
      if (findState.matches[i].start >= pos) { cur = i; break }
    }
    for (var j = 0; j < n; j++) {
      var m = findState.matches[j]
      if (off && off.start === m.start && off.end === m.end) { cur = j; break }
    }
    findState.current = cur
    if (jump) findSelectCurrent()
    else if (els.findCount) els.findCount.textContent = (cur + 1) + '/' + n
  }

  function findSelectCurrent() {
    var m = findState.matches[findState.current]
    if (!m) return
    Editor.selectOffsets(m.start, m.end)
    Editor.scrollSelectionIntoView()
    if (els.findCount) els.findCount.textContent = (findState.current + 1) + '/' + findState.matches.length
  }

  function findNext(dir) {
    var n = findState.matches.length
    if (!n) return
    findState.current = (((findState.current + dir) % n) + n) % n
    findSelectCurrent()
  }

  /** 替换当前命中：选中后走原生 insertText ⇒ 进 undo 栈、自然触发 input（自动保存不用补） */
  function findReplaceOne() {
    var m = findState.matches[findState.current]
    if (!m) return
    Editor.selectOffsets(m.start, m.end)
    Editor.insertText(els.replaceInput ? els.replaceInput.value : '')
    findRefresh(true) // 光标落在替换后文本的末尾 ⇒ 当前命中 = 下一个
  }

  /** 全部替换：整篇重设（undo 栈让位于批量操作）+ 手动补 input（程序化 setValue 不触发） */
  function findReplaceAll() {
    var Plain = window.WCEditorPlain
    var q = findQuery()
    if (!Plain || !q) return
    var r = Plain.replaceAll(Editor.getText(), q, els.replaceInput ? els.replaceInput.value : '', { caseSensitive: findCaseOn() })
    if (!r.count) return
    Editor.setValue(r.text)
    if (Editor.el) Editor.el.dispatchEvent(new Event('input', { bubbles: true }))
    notice('已替换 ' + r.count + ' 处')
    findRefresh(true)
  }

  function wireFind() {
    // 实体按钮入口（iPad 触屏没有 Ctrl+F；PC 快捷键在 window keydown 里）
    if (els.findOpenBtn) els.findOpenBtn.addEventListener('click', function () { findOpen() })
    if (els.findClose) els.findClose.addEventListener('click', findClose)
    if (els.findNext) els.findNext.addEventListener('click', function () { findNext(1) })
    if (els.findPrev) els.findPrev.addEventListener('click', function () { findNext(-1) })
    if (els.replaceOne) els.replaceOne.addEventListener('click', findReplaceOne)
    if (els.replaceAll) els.replaceAll.addEventListener('click', findReplaceAll)
    if (els.findCase) els.findCase.addEventListener('change', function () { findRefresh(true) })
    if (els.findInput) {
      els.findInput.addEventListener('input', function () { findRefresh(true) })
      els.findInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1) }
        else if (e.key === 'Escape') { e.preventDefault(); findClose() }
      })
    }
    if (els.replaceInput) {
      els.replaceInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); findReplaceOne() }
        else if (e.key === 'Escape') { e.preventDefault(); findClose() }
      })
    }
  }

  // ── 小工具 ──────────────────────────────────────────────────────────────
  function countWords(text) {
    return String(text || '').replace(/\s+/g, '').length
  }

  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10)
    if (!isFinite(n)) return dflt
    return Math.min(hi, Math.max(lo, n))
  }

  function notice(text, isError) {
    if (!els.msg) return
    els.msg.textContent = text || ''
    // 颜色走 dsh token（原为硬编码 #c02626 / #666）：内联样式优先级高于样式表，
    // 不换成 token 的话暗色主题下这句话会与整页割裂。仅外观，无行为变化。
    els.msg.style.color = isError
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-label-secondary)'
    if (isError) console.error('[wc] ' + text)
  }

  // ════════════════════════════════════════════════════════════════════════
  // 保存 / 自动保存
  // ════════════════════════════════════════════════════════════════════════
  /**
   * 把「当前文档有没有未保存内容」上报给主进程（变了才发）。
   * 为什么要有它：主进程的关窗拦截**只在真有未保存内容时**才拦（干净就放行，不拖慢正常关闭），
   *   所以它必须先知道这个状态，不能每次关闭都先拦下来问一轮。
   */
  function reportDirty() {
    var v = !!(state.current && state.dirty)
    if (v === lastReportedDirty) return
    lastReportedDirty = v
    try { if (api && api.reportDirty) api.reportDirty(v) } catch (e) { /* 上报失败不影响编辑 */ }
  }

  function renderSaveState() {
    var el = els.save
    if (!el) return
    el.className = 'w-save state-' + state.saveState
    if (state.saveState === 'error') el.textContent = '✗ 保存失败'
    else if (state.saveState === 'saving') el.textContent = '保存中…'
    else if (state.saveState === 'dirty') el.textContent = '未保存'
    else if (state.saveState === 'saved') el.textContent = '已保存'
    else el.textContent = '—'
    renderAutosaveLabel()
    reportDirty()
  }

  /**
   * 工具栏「✓ 自动保存 · N 秒前」。
   * ⚠️ 不能只靠心跳定时器刷新：窗口失焦/后台时 Chromium 会**节流定时器**
   *   （实测后台窗口 500ms 定时器降到 ~1Hz），只靠轮询会让标签明显滞后。
   *   ⇒ 状态一变（renderSaveState）就立即刷一次，心跳只负责把「N 秒前」的 N 递增。
   */
  function renderAutosaveLabel() {
    if (!els.autosave) return
    if (state.saveState === 'error') { els.autosave.textContent = '✗ 自动保存失败'; return }
    if (state.saveState === 'dirty' || state.saveState === 'saving') {
      els.autosave.textContent = '… 待自动保存'
      return
    }
    // 🔴 2026-10-13：saved 时用静态文本（不显示"N 秒前"）——
    //   自动保存成功是常态（本地最新），每 500s 刷秒数 ⇒ 文本宽度变 ⇒ 工具栏 wrap 重排 ⇒ 整页跳动。
    //   状态变化（dirty→saving→saved）只改一次文本，宽度不再持续变。
    els.autosave.textContent = '✓ 自动保存'
  }

  function scheduleAutosave() {
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(function () {
      state.timer = null
      flush({ reason: 'autosave' })
    }, DEBOUNCE_MS)
  }

  /** 把当前编辑内容写盘。force=true 时即使不脏也写（手动保存）。 */
  function renderGoalChip(view) {
    var goalChip = document.getElementById('w-goal-chip')
    if (!goalChip) return
    if (!view || view.words == null) {
      goalChip.hidden = true
      goalChip.textContent = ''
      return
    }
    goalChip.hidden = false
    goalChip.className = 'w-goal-chip' + (view.done ? ' is-done' : '')
    if (!view.goal || view.goal <= 0) {
      goalChip.textContent = '今日 ' + view.words + ' 字'
      goalChip.title = '今日全部写作工作区汇总，点击查看统计页'
      return
    }
    goalChip.textContent = view.done
      ? '今日已达标 · ' + view.words + ' 字'
      : '今日 ' + view.words + ' / ' + view.goal + ' 字 · ' + view.percent + '%'
    goalChip.title = '今日全部写作工作区汇总，点击查看统计页'
  }

  function refreshToday() {
    if (!WCWCore) return Promise.resolve()
    return fetch('/api/writing/today?date=' + WCWCore.localDateString(new Date()), {
      credentials: 'same-origin',
    }).then(function (r) {
      if (!r.ok) return null
      return r.json()
    }).then(function (view) {
      if (view) renderGoalChip(view)
    }).catch(function () {})
  }

  function reportSavedEntry(baseText, rel, text) {
    if (!WCWCore) return Promise.resolve()
    var delta = WCWCore.deltaWords(baseText, text)
    if (delta <= 0) return Promise.resolve()
    return Promise.all([
      sha1Twelve(baseText),
      sha1Twelve(text),
    ]).then(function (hashes) {
      var wsId = state.root || 'local'
      var entry = {
        date: WCWCore.localDateString(new Date()),
        key: WCWCore.buildKey(wsId, rel, hashes[0], hashes[1]),
        words: delta,
      }
      return postEntry(entry)
    })
  }

  function sha1Twelve(text) {
    if (window.wcWriting && window.wcWriting.hash12) {
      return window.wcWriting.hash12(String(text == null ? '' : text))
    }
    return Promise.resolve('')
  }

  function postEntry(entry) {
    return fetch('/api/writing/entries', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    }).then(function (r) {
      if (r.status === 200) {
        WCWCore.removeKey(localStorage, entry.key)
        return r.json().then(function (view) {
          renderGoalChip(view)
          return view
        })
      }
      WCWCore.appendQueue(localStorage, entry)
      return null
    }).catch(function () {
      WCWCore.appendQueue(localStorage, entry)
      return null
    })
  }

  function drainWritingQueue() {
    if (!WCWCore) return Promise.resolve()
    var queued = WCWCore.readQueue(localStorage)
    if (!queued.length) return Promise.resolve()
    return Promise.all(queued.map(postEntry))
  }

  function flush(opts) {
    opts = opts || {}
    if (!state.current) return Promise.resolve({ ok: true, skipped: 'no-doc' })
    if (!state.dirty && !opts.force) return Promise.resolve({ ok: true, skipped: 'clean' })

    var rel = state.current.relPath
    var text = Editor.getText()
    if (state.timer) { clearTimeout(state.timer); state.timer = null }
    state.saveState = 'saving'
    renderSaveState()

    return api.writeDoc(rel, text).then(
      function (res) {
        if (res && res.ok) {
          state.lastSavedAt = res.mtime || Date.now()
          // ⑪ C11 补（2026-09-29）：**保存即推**。本地落盘成功后把**刚写盘的这份**推上线 ——
          //   否则另一台 PC 永远看不到（用户报的「本地保存的时候不推线上，导致客户端之间不能同步」）。
          //   ⚠️ 推的是 `text`（刚写进盘的那份），不是此刻编辑器里的内容 —— 后者是下一次 flush 的事。
          //   去抖/节流/是否真的推，全在 syncPushSoon 里（它可能一个网络请求都不发）。
          syncPushSoon(rel, text, opts.force === true ? 'manual' : 'auto')
          reportSavedEntry(state.current.baseText, rel, text).then(function () {
            state.current.baseText = text
            drainWritingQueue()
          })
          if (Editor.getText() === text) {
            state.dirty = false
            state.saveState = 'saved'
            clearDraftAsync(rel) // 正式盘已是最新 ⇒ 清掉兜底草稿
            notice('已保存 ' + rel)
          } else {
            // 保存期间又有新输入 ⇒ 继续脏，重新排队
            state.dirty = true
            state.saveState = 'dirty'
            scheduleAutosave()
          }
        } else {
          // 保存失败要响亮：状态栏红字 + console.error（不静默吞掉）
          state.saveState = 'error'
          state.lastError = (res && res.error) || '未知错误'
          notice('保存失败：' + state.lastError, true)
        }
        renderSaveState()
        renderStatusBar()
        renderDraftsUsage() // 保存成功 ⇒ 兜底草稿被清；失败 ⇒ 可能刚写了草稿 ⇒ 占用会变
        return res
      },
      function (err) {
        state.saveState = 'error'
        state.lastError = String((err && err.message) || err)
        notice('保存异常：' + state.lastError, true)
        renderSaveState()
        renderStatusBar()
        return { ok: false, error: state.lastError }
      },
    )
  }

  /**
   * 关窗前/切页前的**同步** flush。
   * 异步 IPC 在 unload 阶段不保证送达，故走 sendSync（preload 的 writeDocSync）。
   * ⚠️ 写正式盘失败时**不能静默**：console.error + 状态栏红字，并**同步**把这一稿塞进草稿槽
   *   （`userData/drafts`，应用数据目录一定可写）⇒ 下次启动还能恢复，不会因为"关窗时正好写不进"就丢掉。
   * @returns {{ok:boolean, error?:string}}
   */
  function flushSync(reason) {
    if (!state.current || !state.dirty) return { ok: true, skipped: true }
    var rel = state.current.relPath
    var text = Editor.getText()
    var out
    try {
      var res = api.writeDocSync(rel, text)
      if (res && res.ok) {
        state.dirty = false
        state.lastSavedAt = res.mtime || Date.now()
        state.saveState = 'saved'
        clearDraftAsync(rel)
        out = { ok: true }
      } else {
        state.saveState = 'error'
        state.lastError = (res && res.error) || '未知错误'
        console.error('[wc] ' + reason + ' flush 失败：' + state.lastError)
        keepDraftSync(rel, text)
        // ⚠️ relPath / code 一并回给主进程：它据此写 last-session.json，
        //    下次启动的横幅才能说清「哪一篇、什么 errno」
        out = { ok: false, error: state.lastError, relPath: rel, code: (res && res.code) || null }
      }
    } catch (e) {
      state.saveState = 'error'
      state.lastError = String((e && e.message) || e)
      console.error('[wc] ' + reason + ' flush 异常：' + state.lastError)
      keepDraftSync(rel, text)
      out = { ok: false, error: state.lastError, relPath: rel, code: null }
    }
    reportDirty()
    return out
  }

  // ════════════════════════════════════════════════════════════════════════
  // 草稿保险（兜底；与工作区**解耦**，落在 userData/drafts）
  //
  // 定位：正式盘（工作区）写不进 / 没赶上（系统强杀、进程崩溃）时，至少把内容留在**一定能写**的地方。
  //   · 正常落盘成功 ⇒ 清掉对应草稿（clearDraftAsync）；
  //   · 关窗 flush 失败 ⇒ 立刻**同步**塞一份（keepDraftSync）；
  //   · 编辑期间**每 DRAFT_MS 且仍脏**才写一次（writeDraftNow）—— 干净就不写，避免留下"假草稿"；
  //   · 下次启动由主进程 listPendingDrafts() 找出"比正式盘新 或 正式盘不存在"的草稿并提示恢复。
  // ════════════════════════════════════════════════════════════════════════
  /** 正式盘已是最新 ⇒ 清掉对应草稿（失败只记，不影响编辑） */
  function clearDraftAsync(rel) {
    try {
      if (api && api.clearDraft) {
        api.clearDraft(rel).then(function () { renderDraftsUsage() }, function () { /* 忽略 */ })
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 编辑期间周期写草稿（**只写本地兜底槽**；正式盘仍由去抖自动保存负责） */
  function writeDraftNow() {
    if (!state.current || !state.dirty || !api || !api.writeDraft) return
    var rel = state.current.relPath
    var text = Editor.getText()
    // 🔴 写完要刷占用显示：草稿是**周期写**的，光靠"启动/flush 时刷"会让状态栏长期停在旧值
    //    （实测就出现过：写了 3 份、状态栏还写着"0 份"）
    api.writeDraft(rel, text).then(function () { renderDraftsUsage() }, function () {})
  }

  /** 同步把这一稿塞进草稿槽（关窗前 flush 失败时的最后一道兜底） */
  function keepDraftSync(rel, text) {
    try {
      if (!api || !api.writeDraftSync) return
      var r = api.writeDraftSync(rel, text)
      if (r && r.ok) console.error('[wc] 已把未保存内容留在草稿：' + rel + '（下次启动会提示恢复）')
      else console.error('[wc] 草稿兜底也失败：' + ((r && r.error) || '未知错误'))
    } catch (e) {
      console.error('[wc] 草稿兜底异常：' + ((e && e.message) || e))
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 状态栏 / 预览
  // ════════════════════════════════════════════════════════════════════════
  function renderStatusBar() {
    if (els.count) els.count.textContent = '字数 ' + countWords(Editor.getText())
    if (els.path) {
      els.path.textContent = state.current
        ? state.current.relPath
        : (state.root ? '（未选择文档）' : '（未选择工作区）')
      els.path.title = state.root ? (state.root + '\\' + (state.current ? state.current.relPath.replace(/\//g, '\\') : '')) : ''
    }
  }

  // （原 updatePreviewNow / schedulePreview 已随 PREVIEW BLOCK 一起删除 —— B4 起没有预览栏）

  /**
   * 草稿占用实况（`#37` 之后新增）：状态栏 + 设置页「当前占用」**同一份数据、同一句话**。
   * 为什么要有它：草稿目录会随崩溃恢复兜底而堆积，而 `%APPDATA%` 又不是用户平时会去看的地方
   * ⇒ 把「占用 / 总容量上限（百分比）」摆在写作界面上，用户能自己决定要不要调上限。
   * 🔴 接近上限（≥80%）变警示色 —— 与「保存失败」「托盘未建」同一条纪律：别让它在沉默中发生。
   */
  function renderDraftsUsage() {
    if (!api.draftsUsage) return
    api.draftsUsage().then(function (u) {
      if (!u || !u.ok) return
      var MB = 1024 * 1024
      // 单位自适应：草稿常态只有几十字节（打几个字就写一份）⇒ 一律按 MB 会显示成"0.00 MB"，看不出有东西
      var fmt = function (b) {
        if (b < 1024) return b + ' B'
        if (b < MB) return (b / 1024).toFixed(1) + ' KB'
        return (b / MB).toFixed(1) + ' MB'
      }
      var pct = u.limitBytes > 0 ? Math.round((u.bytes / u.limitBytes) * 100) : 0
      var over = pct >= 80
      var text = u.files === 0
        ? '草稿 0 份 · ' + fmt(0) + ' / ' + fmt(u.limitBytes)
        : '草稿 ' + u.files + ' 份 · ' + fmt(u.bytes) + ' / ' + fmt(u.limitBytes) + '（' + pct + '%）'
      var color = over ? 'var(--w-warn, #c77)' : ''
      if (els.draftsUsageLabel) {
        els.draftsUsageLabel.textContent = text
        els.draftsUsageLabel.title = u.dir + '\n' + text + '（总容量上限超出时按最旧删）'
        els.draftsUsageLabel.style.color = color
      }
      if (els.setDraftsUsage) {
        els.setDraftsUsage.textContent = text + '　·　份数上限 ' + u.limitFiles + ' 份'
        els.setDraftsUsage.style.color = color
      }
    })
  }

  // ════════════════════════════════════════════════════════════════════════
  // 左栏三层（③ §18）：空态 / 作品卡片墙 / 作品内文档树
  // ════════════════════════════════════════════════════════════════════════
  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  /** 作品「最后修改」= 其文档 mtime 的最大值（mtime 由 listWorkspace 的 docs[].mtime 提供） */
  function workMtime(w) {
    var t = 0
    ;(w.docs || []).forEach(function (d) { if (d.mtime && d.mtime > t) t = d.mtime })
    return t || null
  }

  function fmtTime(ms) {
    if (!ms) return '—'
    var d = new Date(ms)
    function p(n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  /** 窄栏卡片用短日期：今年只显「MM-DD」，往年才带年份（绝不在 240px 侧栏里挤出省略号） */
  function fmtShortDate(ms) {
    if (!ms) return '—'
    var d = new Date(ms)
    function p(n) { return (n < 10 ? '0' : '') + n }
    var md = p(d.getMonth() + 1) + '-' + p(d.getDate())
    return (d.getFullYear() === new Date().getFullYear()) ? md : (d.getFullYear() + '-' + md)
  }

  function renderRootLabel() {
    if (!els.rootLabel) return
    els.rootLabel.textContent = state.root ? ('工作区：' + state.root) : '尚未选择工作区'
    els.rootLabel.title = state.root || ''
  }

  // ════════════════════════════════════════════════════════════════════════
  // ①-a 修改 / 切换工作区路径（常驻入口）
  //
  // 复用现有 IPC（**没有新增**）：
  //   · 「切换到已有目录…」→ `wc:pick-root` —— 语义完全一致（选一个**已有目录**当工作区根，
  //     落配置前做**真写自检**，不可写则不落配置并回 `writableHint()` 文案）
  //   · 「新建工作区」→ `wc:create-root`（壳层自己 mkdir，不依赖系统对话框的"新建文件夹"）
  //   · 「新建到指定位置…」→ `wc:pick-dir` + `wc:create-root`
  // ⚠️ 切换前若有未保存编辑 ⇒ **先弹确认、再 flush**（照切文档/关窗的做法），flush 失败即中止切换。
  // ════════════════════════════════════════════════════════════════════════
  function renderWsBar() {
    if (els.wsBar) els.wsBar.hidden = !state.root
  }

  function openWsPop(open) {
    if (!els.wsPop) return
    els.wsPop.hidden = !open
    if (els.wsMenu) els.wsMenu.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  function closeWsPop() { openWsPop(false) }

  /**
   * 把 state 整体切到新工作区：**不把旧工作区的状态带过去**
   * （文档树 / 卡片墙 / 当前文档 / 搜索框 / 卡片展开 / 编辑器正文全部重置，随后 refreshTree 重列）。
   * ⚠️ 必须清掉自动保存定时器：relPath 是**相对路径**，定时器若在切换后触发会把旧稿写进**新工作区**。
   */
  function applyRoot(root) {
    if (state.timer) { clearTimeout(state.timer); state.timer = null }
    state.root = root || null
    state.hint = ''
    state.treeError = ''
    state.works = []
    state.current = null
    state.currentWork = null
    state.dirty = false
    state.saveState = 'idle'
    state.lastSavedAt = 0
    state.worksQuery = ''
    state.docQuery = ''
    if (els.worksSearch) els.worksSearch.value = ''
    if (els.docSearch) els.docSearch.value = ''
    state.view = state.root ? 'works' : 'empty'
    Editor.setValue('')
    proofReset() // B5：换了工作区 ⇒ 校对建议一定失效（内容和会话都换了）
    renderRootLabel()
    renderWsBar()
    renderSidebar()
    renderSaveState()
    renderStatusBar()
    if (settingsIsOpen()) renderSettings() // 设置弹层里「工作区」那一行跟着更新
  }

  /** 切换工作区前的**确认 + flush**：脏 ⇒ 弹确认；确认后 flush，flush 失败即中止（不回滚，也不继续切） */
  function beforeSwitchWorkspace() {
    if (!state.dirty) return Promise.resolve(true)
    var name = (state.current && state.current.name) || '当前文档'
    var ok = window.confirm(
      '《' + name + '》有未保存的修改。\n' +
      '切换工作区前会先把修改写盘到当前工作区：\n' + state.root + '\n\n' +
      '然后才切换（旧工作区的 md 不会被改动，只是不再指向它）。\n继续？',
    )
    if (!ok) { notice('已取消：未保存的修改仍在编辑器里，工作区未切换'); return Promise.resolve(false) }
    return flush({ force: true, reason: 'switch-workspace' }).then(function (res) {
      if (res && res.ok) return true
      notice('切换前保存失败，已中止切换：' + ((res && res.error) || '未知错误'), true)
      return false
    })
  }

  /** 切换到**已有**目录（复用 wc:pick-root；首启「选择工作区」走的也是这条） */
  function switchToExistingRoot() {
    closeWsPop()
    // 首启（还没工作区）时是「**选择**」，已有工作区时才是「**切换**」—— 文案分开，避免首启说成"切换"
    var label = state.root ? '切换工作区' : '选择工作区'
    return beforeSwitchWorkspace().then(function (go) {
      if (!go) return
      return api.pickRoot().then(function (res) {
        if (res && res.ok) {
          applyRoot(res.root)
          notice((label === '选择工作区' ? '工作区已设为 ' : '工作区已切换到 ') + res.root)
          return refreshTree()
        }
        if (res && res.canceled) return
        // 失败（含"所选目录不可写"）⇒ 多行可操作文案落到左栏（常驻提示块，任何层都看得到）
        state.hint = label + '失败：' + ((res && res.error) || '未知错误')
        notice(label + '失败（详见左栏提示）', true)
        renderSidebar()
      })
    })
  }

  /** 决定左栏显示哪一层（并渲染它） */
  function renderSidebar() {
    var view = !state.root
      ? 'empty'
      : (state.view === 'trash' ? 'trash' : (state.view === 'tree' && state.currentWork ? 'tree' : 'works'))
    state.view = view
    renderWsBar()
    if (els.sideEmpty) els.sideEmpty.hidden = view !== 'empty'
    if (els.sideWorks) els.sideWorks.hidden = view !== 'works'
    if (els.sideTree) els.sideTree.hidden = view !== 'tree'
    if (els.sideTrash) els.sideTrash.hidden = view !== 'trash'
    // 可操作提示：**常驻**（不随层切换消失）—— 切换/新建工作区失败时用户在任何一层都能看到原因与直达按钮
    if (els.emptyHint) els.emptyHint.hidden = !state.hint
    if (els.hintText) els.hintText.textContent = state.hint || ''
    if (view === 'works') renderWorks()
    else if (view === 'tree') renderTree()
    else if (view === 'trash') renderTrash()
    // 🔴 D-6：写作区的"有没有归属"在这里同步 —— 左栏是**所有状态变化的必经之路**
    //   （selectDoc / bannerOpenDraft / applyRoot 都会走到 renderSidebar ⇒ 不愁漏调）
    renderEditorState()
    // ⑪ C11：顺带懒拉一次远端清单（只在"清单签名变了"时重画 ⇒ 不会自己转圈）。
    //   放在**最后**：先让本地内容立刻上屏，远端那几条随后补进来（与"比对不阻塞打开"同一取向）。
    syncEnsureListForSidebar()
  }

  // ════════════════════════════════════════════════════════════════════════
  // ③-c 条目操作（B3 / CR-1）：重命名 / 移动到… / 删除
  //
  // 形态：每个条目右侧一个「⋯」，展开后是**内联行**面板（重命名出输入框、移动出作品按钮），
  //   不用模态、不用系统 confirm —— 与本仓"横幅而非模态"的既有取向一致。
  // 后端判据全在 guard.js：**目标已存在一律拒绝**（不覆盖）；删除 = 软删进 `_回收/`。
  // ════════════════════════════════════════════════════════════════════════

  /** 内联操作面板：只在 `state.ops.key === key` 时渲染内容，其余条目只留隐藏占位 */
  function opsPanel(key, build) {
    var box = el('div', 'w-ops')
    if (state.ops.key !== key) {
      box.hidden = true
      return box
    }
    try {
      build(box)
    } catch (e) {
      box.appendChild(el('div', 'w-note', '操作面板渲染失败：' + ((e && e.message) || e)))
    }
    return box
  }

  /** 同一个 key 再点一次（或点当前模式）⇒ 收起 */
  function toggleOps(key, mode) {
    if (state.ops.key === key && (!mode || state.ops.mode === mode)) state.ops = { key: null, mode: null }
    else state.ops = { key: key, mode: mode || 'menu' }
    renderSidebar()
  }

  function opsBtn(label, run, danger) {
    var b = el('button', 'w-mini' + (danger ? ' w-danger' : ''), label)
    b.addEventListener('click', function (e) {
      e.stopPropagation()
      run()
    })
    return b
  }

  /** 内联输入（Enter 确定 / Esc 取消）；⚠️ 按键不能冒泡到全局（那里有写作快捷键与 Esc 处理） */
  function opsInput(value, ariaLabel, onOk, onCancel) {
    var input = document.createElement('input')
    input.className = 'w-ops-input'
    input.value = value == null ? '' : String(value)
    input.setAttribute('aria-label', ariaLabel)
    input.addEventListener('keydown', function (e) {
      e.stopPropagation()
      if (e.key === 'Enter') onOk(input.value)
      else if (e.key === 'Escape') onCancel()
    })
    setTimeout(function () {
      try { input.focus(); input.select() } catch (e) { /* 不在可见树上就算了 */ }
    }, 0)
    return input
  }

  /** 一个文档条目：行 + 「⋯」+ 面板（重命名 / 移动到… / 删除） */
  function docEntry(d, workName, onOpen) {
    var box = el('div', 'w-doc-wrap')
    var row = el('div', 'w-doc')
    row.title = d.relPath + '\n最后修改 ' + fmtTime(d.mtime)
    if (state.current && state.current.relPath === d.relPath) row.classList.add('active')
    row.appendChild(el('span', 'w-doc-name', d.name))
    var more = el('button', 'w-mini w-more', '⋯')
    more.title = '重命名 / 移动到… / 删除'
    more.setAttribute('aria-label', more.title)
    more.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleOps('d:' + d.relPath)
    })
    row.appendChild(more)
    row.addEventListener('click', function (e) {
      e.stopPropagation()
      if (onOpen) onOpen()
      else selectDoc(d)
    })
    box.appendChild(row)
    box.appendChild(opsPanel('d:' + d.relPath, function (host) { buildDocOps(host, workName, d) }))
    return box
  }

  function buildDocOps(host, workName, d) {
    var key = 'd:' + d.relPath
    if (state.ops.mode === 'rename') {
      host.appendChild(opsInput(d.name.replace(/\.md$/i, ''), '新名称',
        function (v) { doRenameDoc(workName, d, v) }, function () { toggleOps(key) }))
      host.appendChild(opsBtn('确定', function () { doRenameDoc(workName, d, host.querySelector('input').value) }))
      host.appendChild(opsBtn('取消', function () { toggleOps(key) }))
      return
    }
    if (state.ops.mode === 'move') {
      var others = state.works.filter(function (w) { return w.name !== workName })
      others.forEach(function (w) {
        host.appendChild(opsBtn('→ 《' + w.name + '》', function () { doMoveDoc(workName, d, w.name) }))
      })
      host.appendChild(opsBtn('取消', function () { toggleOps(key) }))
      return
    }
    var move = opsBtn('移动到…', function () { toggleOps(key, 'move') })
    var hasOther = state.works.some(function (w) { return w.name !== workName })
    move.disabled = !hasOther
    if (!hasOther) move.title = '没有别的作品可以挪过去'
    host.appendChild(opsBtn('重命名', function () { toggleOps(key, 'rename') }))
    host.appendChild(move)
    host.appendChild(opsBtn('删除', function () { doTrashDoc(workName, d) }, true))
  }

  function buildWorkOps(host, w) {
    var key = 'w:' + w.name
    // 纯云端作品：本地没有目录，重命名无意义；只给「删除云端此作品」
    if (w.cloudOnly) {
      host.appendChild(opsBtn('删除云端此作品', function () { doDeleteCloudWork(w) }, true))
      return
    }
    if (state.ops.mode === 'rename') {
      host.appendChild(opsInput(w.name, '新作品名',
        function (v) { doRenameWork(w, v) }, function () { toggleOps(key) }))
      host.appendChild(opsBtn('确定', function () { doRenameWork(w, host.querySelector('input').value) }))
      host.appendChild(opsBtn('取消', function () { toggleOps(key) }))
      return
    }
    host.appendChild(opsBtn('重命名', function () { toggleOps(key, 'rename') }))
    host.appendChild(opsBtn('删除整个作品', function () { doTrashWork(w) }, true))
  }

  /** 操作收尾：收起面板 → 重列工作区（回收站视图里连回收站一起刷）→ 重渲染左栏 */
  function afterOp(msg) {
    state.ops = { key: null, mode: null }
    if (msg) notice(msg)
    var chain = refreshTree()
    if (state.view === 'trash') chain = chain.then(function () { return loadTrash(true) })
    return chain.then(function () { renderSidebar() })
  }

  function opFail(what, res) {
    notice(what + '失败：' + ((res && res.error) || '未知错误'), true)
  }

  /**
   * 当前文档被删/被移走 ⇒ 让编辑器与状态一起脱钩。
   * 🔴 必须做：否则下一次自动保存会把内容又写到旧路径（文件"复活"）。
   */
  function detachCurrent() {
    Editor.setValue('')
    state.current = null
    state.dirty = false
    state.saveState = 'idle'
    proofReset() // B5：当前文档没了 ⇒ 校对建议立刻作废（否则会指着别的文档改字）
    reportDirty()
    renderSaveState()
    renderStatusBar()
    renderEditorState() // 🔴 D-6：没有归属了 ⇒ 立刻锁上写作区
  }

  /**
   * 🔴 D-6：写作区「有没有归属」的**唯一同步入口** —— 所有会改变"当前文档"的路径都必须经过它
   * （`applyRoot` / `detachCurrent` 直接调；`selectDoc` / `bannerOpenDraft` 经 `renderSidebar()` 走到）。
   * 判据在 `editor-plain.js` 的 `lockState()`（纯函数、有单测）；这里只做 DOM 与文案落地。
   */
  function renderEditorState() {
    var st = (window.WCEditorPlain && window.WCEditorPlain.lockState)
      ? window.WCEditorPlain.lockState({ hasDoc: !!state.current, hasRoot: !!state.root })
      : { editable: !!state.current, title: '', hint: '', canQuickNew: false }
    Editor.setEditable(st.editable)
    // ⚠️ 锁定态**不清空**写作区内容：清空是"销毁"，而这里只是"盖住"（万一将来有别的入口漏判，
    //    内容还躺在 DOM 里可救）。真正的清空只发生在 applyRoot / detachCurrent 这两处明确语义处。
    var box = els.editorEmpty
    if (!box) return
    box.hidden = st.editable
    if (st.editable) return
    if (els.editorEmptyTitle) els.editorEmptyTitle.textContent = st.title
    if (els.editorEmptyHint) els.editorEmptyHint.textContent = st.hint
    if (els.editorNewDoc) els.editorNewDoc.hidden = !st.canQuickNew
  }

  /**
   * 空态里的「新建一篇（自动命名）」。
   * ⚠️ 不直接复用左栏的 `newDoc()`：那个要求先在左栏填文档名（会把用户弹回去），
   *    这里干脆用时间戳起名（之后可用 B3 的重命名改）。作品回退口径与 `newDoc()` 保持一致。
   */
  function quickNewDoc() {
    if (!state.root) { notice('请先选择或新建工作区', true); return }
    var work = state.currentWork || (state.current && state.current.work) || (state.works[0] && state.works[0].name)
    if (!work) { notice('请先在左侧新建（或进入）一个作品', true); return }
    var d = new Date()
    var p = function (n) { return (n < 10 ? '0' : '') + n }
    var name = '未命名-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    if (state.currentWork !== work) { state.currentWork = work; state.view = 'tree' }
    api.createDoc(work, name).then(function (res) {
      if (!res || !res.ok) { notice('新建文档失败：' + ((res && res.error) || '未知错误'), true); return }
      return refreshTree().then(function () {
        renderSidebar()
        return selectDoc({ relPath: res.relPath })
      })
    })
  }

  // ════════════════════════════════════════════════════════════════════════
  // ⑥ 分栏模式（CR-6 · 2026-09-28 用户要求）
  //
  // 形态：**写作页与对话页并排**；分栏时左栏（作品/文档）与右栏（记录板）收进**浮层**。
  //
  // 🔑 为什么这件事便宜（这是全案最关键的一条）：
  //   ① 两页本来就是 `<main>` 下的**兄弟节点**（常驻、只用 `hidden` 显隐）
  //      ⇒ 并排 = 都不加 hidden + 定位分左右，**iframe 一步都没搬** ——
  //      而在 DOM 里搬动 iframe 会触发**重载**，对话现场（滚动位置、正在写的内容）就没了。
  //   ② 左栏/右栏只是换成 absolute 定位（CSS 层的事），**DOM 结构一点没动**
  //      ⇒ `renderSidebar()` 与它内部的全部事件绑定（含 B3 的 ⋯ 内联面板）**一行都不用改**。
  //   ③ 比例走 CSS 变量（百分比）⇒ 窗口 resize 不需要任何重算。
  //
  // ⚠️ 唯一的坑：拖拽分割条时 iframe 会**抢鼠标**（指针一进 iframe 就被它接管，分割条再也
  //    收不到 pointermove）⇒ 拖拽期间给对话区加 `.no-pointer`（pointer-events:none）。
  //    这是本批唯一必须真机反复试的交互点。
  // ════════════════════════════════════════════════════════════════════════
  var SPLIT_MIN = 0.2
  var SPLIT_MAX = 0.8

  function clampRatio(v) {
    var r = Number(v)
    if (!isFinite(r)) return 0.5
    return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, r))
  }

  /** 把分栏状态画到 DOM 上（**唯一渲染入口**：开关 / 拖拽 / 浮层开合都走它） */
  function renderSplit() {
    var on = !!(state.split && state.split.on)
    var main = document.getElementById('w-main')
    // 进去/出来之前先记下"原来在不在分栏" —— 退出时要据此把显隐交还给页签逻辑
    var wasSplit = !!(main && main.classList.contains('split'))
    if (main) {
      main.classList.toggle('split', on)
      main.style.setProperty('--w-split-pct', (clampRatio(state.split.ratio) * 100).toFixed(2) + '%')
    }
    /* 🔴 两页的显隐**只在分栏相关时由这里接管**（其余时候归 shell.html 的页签）：
          · 进分栏 → 两页都要显示，且两个页签都高亮（`__wcTabs.showBoth`）；
            不能靠 `showWritingPage()`（= 点页签）—— 那条路径一次只显示一页，会把对话页 hidden 掉，
            右半屏就是一片空白（这是本批最容易漏的一处）。
          · 退出分栏 → 回到「写作页独占」：分栏开关只存在于写作页的工具栏，用户此刻必然在这一页。 */
    if (on) {
      if (window.__wcTabs) window.__wcTabs.showBoth()
    } else if (wasSplit) {
      if (window.__wcTabs) window.__wcTabs.show('writing')
    }
    if (els.split) els.split.classList.toggle('active', on)
    // 两个浮层入口只在分栏时有意义（单页模式下左栏/右栏本来就在）
    if (els.splitDocs) els.splitDocs.hidden = !on
    if (els.splitBoard) els.splitBoard.hidden = !on
    // ⚠️ 单页模式下必须**显式恢复常驻**（hidden=false）：否则用户在分栏里开过浮层再退出，
    //    左栏会一直隐形 —— 这是"浮层态是瞬时 UI 态"的代价，得在这里兜住。
    if (els.sidebar) els.sidebar.hidden = on ? !state.split.docs : false
    if (els.right) els.right.hidden = on ? !state.split.board : false
  }

  /** 分栏开关与比例**落盘**（只写这两个；`docs`/`board` 是瞬时态，不落盘） */
  function saveSplit() {
    if (!api || !api.saveConfig) return
    api.saveConfig({
      ui: { split: { on: !!(state.split && state.split.on), ratio: clampRatio(state.split.ratio) } },
    })
  }

  /**
   * 让右侧 iframe 切到「AI 对话」（控制台路由 `#/chat`）。
   * 🔴 **只改 hash**：控制台是 SPA，hashchange 会重新渲染路由 ⇒ **不整页重载**，
   *   登录态与页面状态全都保住。跨源时（不该发生，壳层与 iframe 同源）降级为整页导航。
   */
  function frameGotoChat() {
    var frame = document.getElementById('dsh-frame')
    if (!frame) return
    try {
      var w = frame.contentWindow
      if (w && w.location && w.location.origin === location.origin) { w.location.hash = '#/chat'; return }
    } catch (e) { /* 跨源 ⇒ 走下面的降级 */ }
    if (String(frame.getAttribute('src') || '').indexOf('#/chat') < 0) frame.setAttribute('src', '/app#/chat')
  }

  function setSplit(on) {
    state.split.on = !!on
    // 退出时把两个浮层收掉（`docs`/`board` 是瞬时态：只在分栏里有意义，也不落盘）
    if (!state.split.on) {
      state.split.docs = false
      state.split.board = false
    }
    /* 顺序有讲究：先 renderSplit() 接管两页显隐（= 两页都显示），**再**切右侧路由。
       ⚠️ 不能像最早那样反过来先 `showWritingPage()`（点页签）—— 那条路径只显示一页，
          会把对话页 hidden 掉，右半屏一片空白（见 renderSplit 里的注释）。 */
    renderSplit()
    if (state.split.on) frameGotoChat()
    saveSplit()
  }

  /** 浮层开合（只在分栏时有效）；点面板外 / Esc 关闭的逻辑在 wire() 里 */
  function toggleSplitPanel(which) {
    if (!state.split.on) return
    state.split[which] = !state.split[which]
    renderSplit()
  }

  function closeSplitPanels() {
    if (!state.split.docs && !state.split.board) return
    state.split.docs = false
    state.split.board = false
    renderSplit()
  }

  /** 拖拽分割条：Pointer Events + 指针捕获；拖拽期间给对话区盖 `pointer-events:none` */
  function wireSplitHandle() {
    var h = document.getElementById('w-split-handle')
    var main = document.getElementById('w-main')
    var dsh = document.getElementById('page-dsh')
    if (!h || !main) return
    var dragging = false

    h.addEventListener('pointerdown', function (e) {
      if (!state.split.on) return
      dragging = true
      try { h.setPointerCapture(e.pointerId) } catch (err) { /* 捕获失败也还能用 move 兜住 */ }
      h.classList.add('dragging')
      if (dsh) dsh.classList.add('no-pointer') // 🔴 不让 iframe 抢鼠标
      e.preventDefault()
    })
    h.addEventListener('pointermove', function (e) {
      if (!dragging) return
      var r = main.getBoundingClientRect()
      if (!r.width) return
      state.split.ratio = clampRatio((e.clientX - r.left) / r.width)
      renderSplit() // 只改一个 CSS 变量 ⇒ 每帧都很便宜
    })
    function end(e) {
      if (!dragging) return
      dragging = false
      h.classList.remove('dragging')
      if (dsh) dsh.classList.remove('no-pointer')
      try { h.releasePointerCapture(e.pointerId) } catch (err) { /* 已释放 */ }
      saveSplit() // 松手才落盘（拖动过程不写配置）
    }
    h.addEventListener('pointerup', end)
    h.addEventListener('pointercancel', end)
    h.addEventListener('dblclick', function () {
      state.split.ratio = 0.5
      renderSplit()
      saveSplit()
    })
  }

  function doRenameDoc(workName, d, raw) {
    var v = String(raw == null ? '' : raw).trim()
    if (!v) { notice('请先填写新名称', true); return }
    api.renameDoc(workName, d.name, v).then(function (res) {
      if (!res || !res.ok) { opFail('重命名', res); return }
      // 正打开的文档被改名 ⇒ 状态跟到新路径（否则自动保存写回旧文件）+ 开看门狗盯旧路径
      if (state.current && state.current.relPath === d.relPath) {
        var oldRel = state.current.relPath
        var segs = res.relPath.split('/')
        state.current.relPath = res.relPath
        state.current.name = segs[segs.length - 1]
        forgetDraft(oldRel)
        startHoldWatch(oldRel, res.relPath)
      }
      return afterOp('已重命名为《' + res.relPath.split('/').pop() + '》')
    })
  }

  function doRenameWork(w, raw) {
    var v = String(raw == null ? '' : raw).trim()
    if (!v) { notice('请先填写新作品名', true); return }
    api.renameWork(w.name, v).then(function (res) {
      if (!res || !res.ok) { opFail('重命名作品', res); return }
      if (state.currentWork === w.name) state.currentWork = res.work
      if (state.current && state.current.work === w.name) {
        var oldRel = state.current.relPath
        state.current.work = res.work
        state.current.relPath = res.work + '/' + state.current.name
        forgetDraft(oldRel)
        startHoldWatch(oldRel, state.current.relPath)
      }
      return afterOp('作品已重命名为《' + res.work + '》')
    })
  }

  function doMoveDoc(fromWork, d, toWork) {
    api.moveDoc(fromWork, d.name, toWork).then(function (res) {
      if (!res || !res.ok) { opFail('移动', res); return }
      if (state.current && state.current.relPath === d.relPath) {
        var oldRel = state.current.relPath
        state.current.relPath = res.relPath
        state.current.work = toWork
        forgetDraft(oldRel)
        startHoldWatch(oldRel, res.relPath)
      }
      return afterOp('已把《' + d.name + '》移到《' + toWork + '》')
    })
  }

  /**
   * 软删联动云端：把给出的章节逐个归档进云端 `回收/`（clientZoneDelete = 正文→回收的原子 rename），
   * 每成功一件就从基线里清掉它。返回 `{tried, ok}`——调用方据 ok 数决定提示。
   * 归档失败只如实计数，**不回滚已完成的本地删除**（本地件仍在本机回收站，可恢复）。
   */
  function archiveCloudDocs(docs) {
    var res = { tried: docs.length, ok: 0 }
    var chain = Promise.resolve()
    docs.forEach(function (d) {
      chain = chain.then(function () {
        return window.WCSyncNet.deleteDraft(d.relPath).then(function (r) {
          if (!r || r.ok !== true) {
            notice('云端归档失败：' + d.name + ' ' + ((r && r.error) || ''), true)
            return
          }
          res.ok++
          return saveSyncBaseline(SYNC.dropBaseline(state.sync.baseline, d.relPath))
        })
      })
    })
    return chain.then(function () {
      state.sync.list = null
      return res
    })
  }

  /** 软删文档：**先 flush** 再本地删，随后把云端同名件归档进云端回收（否则作品页会把它当"仅云端"重复拉取） */
  function doTrashDoc(workName, d) {
    var holding = !!(state.current && state.current.relPath === d.relPath)
    var pre = holding ? flush({ reason: 'trash-doc' }) : Promise.resolve({ ok: true })
    pre.then(function (f) {
      if (holding && (!f || !f.ok)) { notice('删除前保存失败，已中止：' + ((f && f.error) || '未知错误'), true); return }
      return api.trashDoc(workName, d.name).then(function (res) {
        if (!res || !res.ok) { opFail('删除', res); return }
        if (holding) {
          // 旧路径本该永远消失 ⇒ 开看门狗盯着它，真"复活"了要当场看见
          forgetDraft(d.relPath)
          startHoldWatch(d.relPath, null)
          detachCurrent()
        }
        if (!syncReady()) {
          notice('已把《' + d.name + '》移入本地回收站（远程未就绪，联网后请重新删除以同步云端）')
          return afterOp()
        }
        notice('正在把云端《' + d.name + '》移入云端回收站…')
        return archiveCloudDocs([{ name: d.name, relPath: d.relPath }]).then(function (a) {
          return afterOp(a.ok === a.tried
            ? '已把《' + d.name + '》移入回收站（本地与云端均可恢复）'
            : '已把《' + d.name + '》移入本地回收站，但云端有 ' + (a.tried - a.ok) + ' 章没归档成功', true)
        })
      })
    })
  }

  function doTrashWork(w) {
    var holding = !!(state.current && state.current.work === w.name)
    var pre = holding ? flush({ reason: 'trash-work' }) : Promise.resolve({ ok: true })
    pre.then(function (f) {
      if (holding && (!f || !f.ok)) { notice('删除前保存失败，已中止：' + ((f && f.error) || '未知错误'), true); return }
      // 云端章节要在本地整目录删掉**之前**取（之后本地树里就没有这个作品了）
      var gather = syncReady()
        ? syncRemoteIndex(true).then(function (ix) { return cloudDocsOfWork(ix, w.name) })
        : Promise.resolve([])
      return gather.then(function (cdocs) {
        return api.trashWork(w.name).then(function (res) {
          if (!res || !res.ok) { opFail('删除作品', res); return }
          if (holding) {
            var oldRel = state.current.relPath
            forgetDraft(oldRel)
            startHoldWatch(oldRel, null)
            detachCurrent()
          }
          if (state.currentWork === w.name) { state.currentWork = null; state.view = 'works' }
          if (!syncReady()) {
            notice('已把作品《' + w.name + '》移入本地回收站（远程未就绪，联网后请重新删除以同步云端）')
            return afterOp()
          }
          if (!cdocs.length) {
            return afterOp('已把作品《' + w.name + '》移入本地回收站（云端清单里没有它的章节）')
          }
          notice('正在把云端《' + w.name + '》的 ' + cdocs.length + ' 章移入云端回收站…')
          return archiveCloudDocs(cdocs).then(function (a) {
            return afterOp(a.ok === a.tried
              ? '已把作品《' + w.name + '》移入回收站（本地与云端均可恢复）'
              : '已把作品《' + w.name + '》移入本地回收站，但云端有 ' + (a.tried - a.ok) + '/' + a.tried + ' 章没归档成功', true)
          })
        })
      })
    })
  }

  /**
   * 删除**纯云端作品**：本地没有目录，直接把它在服务器上的每一章**软删**
   * （clientZoneDelete = 服务端把件搬到云端 `回收/`，不是真删；与未来删除模型的"软删即归档云端回收"一致）。
   */
  function doDeleteCloudWork(w) {
    var rdocs = remoteOnlyDocs(w.name)
    if (!syncReady()) { notice('远程尚未就绪，暂时无法删除', true); return }
    if (!rdocs.length) { notice('清单里没有可删的章节，稍后再试', true); return }
    notice('正在把云端《' + w.name + '》的 ' + rdocs.length + ' 章移入云端回收站…')
    var chain = Promise.resolve()
    var fail = 0
    rdocs.forEach(function (d) {
      chain = chain.then(function () {
        return window.WCSyncNet.deleteDraft(d.relPath).then(function (r) {
          if (!r || !r.ok) { fail++; notice('删除失败：' + d.name + ' ' + ((r && r.error) || ''), true) }
        })
      })
    })
    chain.then(function () {
      state.sync.list = null
      state.ops = { key: null, mode: null }
      return refreshTree()
    }).then(function () {
      renderSidebar()
      notice(fail
        ? ('云端《' + w.name + '》有 ' + fail + ' 章没删成功')
        : ('已把云端《' + w.name + '》移入云端回收站（可恢复）'))
    })
  }

  // ── ③-d 回收站（B3）────────────────────────────────────────────────────

  function openTrash() {
    if (!state.root) { notice('请先选择或新建工作区', true); return }
    state.ops = { key: null, mode: null }
    state.view = 'trash'
    renderSidebar()
    loadTrash()
  }

  function loadTrash(silent) {
    return api.listTrash().then(function (res) {
      if (!res || !res.ok) {
        state.trash = []
        if (!silent) notice('读取回收站失败：' + ((res && res.error) || '未知错误'), true)
      } else {
        state.trash = res.items || []
      }
      renderTrash()
    })
  }

  function renderTrash() {
    var host = els.trashList
    if (!host) return
    host.textContent = ''
    if (els.trashCount) els.trashCount.textContent = state.trash.length ? (state.trash.length + ' 项') : ''
    if (!state.trash.length) {
      host.appendChild(el('div', 'w-empty', '回收站是空的。\n删除作品或文档后会先放到这里，可以再恢复。'))
      return
    }
    state.trash.forEach(function (it) {
      var box = el('div', 'w-doc-wrap')
      var row = el('div', 'w-doc')
      row.title = it.relPath + '\n删除时间 ' + fmtTime(it.mtime)
      row.appendChild(el('span', 'w-doc-name', it.kind === 'work' ? ('作品《' + it.name + '》') : it.name))
      box.appendChild(row)
      var ops = el('div', 'w-ops')
      ops.appendChild(opsBtn('恢复', function () { doRestore(it) }))
      ops.appendChild(opsBtn('彻底删除', function () { doPurge(it) }, true))
      box.appendChild(ops)
      host.appendChild(box)
    })
  }

  function doRestore(it) {
    api.restoreTrash(it.relPath).then(function (res) {
      if (!res || !res.ok) { opFail('恢复', res); return }
      var what = res.kind === 'work' ? ('作品《' + res.work + '》') : ('《' + res.relPath.split('/').pop() + '》')
      notice('已恢复 ' + what)
      return refreshTree().then(function () { return loadTrash(true) }).then(function () { renderSidebar() })
    })
  }

  function doPurge(it) {
    // 硬删**不可恢复** ⇒ 这里用一次系统确认（与本仓"切换工作区"同款；只此一处）
    var ok = window.confirm('彻底删除「' + it.name + '」？\n\n这一步是真删，删除后无法恢复。')
    if (!ok) return
    api.purgeTrash(it.relPath).then(function (res) {
      if (!res || !res.ok) { opFail('彻底删除', res); return }
      notice('已彻底删除「' + it.name + '」')
      return loadTrash(true).then(function () { renderSidebar() })
    })
  }

  // ════════════════════════════════════════════════════════════════════════
  // ③-e 旧路径看门狗（B3 兜底 · 2026-09-27 用户要求）
  //
  // 为什么要有它：改名 / 移动 / **删除**「正在编辑」的文档之后，旧路径本不该再出现。
  //   万一还有别处把它"复活"（漏改的定时器、草稿回写、将来新增的写入方），
  //   或者新路径根本没落住（指向错误），我们希望**当场看到提示**，而不是过几天发现多出一个文件。
  // 做法：一旦改动了当前文档 ⇒ 开一只 60 秒的看门狗，每 3 秒核一次：
  //   · 旧路径**又出现** ⇒ 「旧路径复活」
  //   · 新路径**读不到** ⇒ 「指向错误」（仅改名 / 移动有 newRel）
  // 🔴 **只提示、只记日志，绝不自动改**（留给人工排查 —— 自动"修"会把真正的成因盖掉）。
  //   每种异常**只报一次**（不刷屏）；同一时刻**最多一只**看门狗（后一次操作顶掉前一只）。
  // ════════════════════════════════════════════════════════════════════════
  var Watch = window.WCWatch // watch.js：看门狗**判据**（纯逻辑，与 watch.test.js 跑同一份）
  var holdWatch = null
  var pathIncidents = []
  window.__wcPathIncidents = pathIncidents // 排查入口：DevTools 控制台里直接看

  function stopHoldWatch() {
    if (holdWatch && holdWatch.timer) clearTimeout(holdWatch.timer)
    holdWatch = null
  }

  /** oldRel 原本该消失；newRel 若有（改名/移动）则必须读得到 */
  function startHoldWatch(oldRel, newRel) {
    if (!Watch) {
      console.error('[wc] watch.js 未加载（window.WCWatch 缺失），旧路径看门狗未启用')
      return
    }
    stopHoldWatch()
    holdWatch = {
      oldRel: oldRel,
      newRel: newRel || null,
      root: state.root,
      until: Date.now() + Watch.WATCH_MS,
      seen: {}, // 每种异常只报一次，不刷屏
      timer: setTimeout(watchTick, Watch.WATCH_TICK),
    }
  }

  function scheduleWatchTick() {
    if (!holdWatch || !Watch) return
    holdWatch.timer = setTimeout(watchTick, Watch.WATCH_TICK)
  }

  function watchTick() {
    if (!holdWatch) return
    var w = holdWatch
    if (!Watch.inWindow({ root: state.root, watchRoot: w.root, now: Date.now(), until: w.until })) {
      stopHoldWatch() // 超时 / 换了工作区 ⇒ 判据失效，收工
      return
    }
    Promise.all([api.readDoc(w.oldRel), w.newRel ? api.readDoc(w.newRel) : Promise.resolve(null)])
      .then(function (rs) {
        if (holdWatch !== w) return // 期间又操作过一次 ⇒ 这只作废
        Watch.findings({ oldRel: w.oldRel, newRel: w.newRel, oldRead: rs[0], newRead: rs[1] })
          .forEach(function (f) { reportPathIncident(f.kind, f.detail) })
        scheduleWatchTick()
      })
  }

  /** 记一条路径异常：状态条提示 + 控制台（带完整现场）+ 内存留档，供后续排查 */
  function reportPathIncident(kind, detail) {
    if (!holdWatch || holdWatch.seen[kind]) return
    holdWatch.seen[kind] = true
    var rec = {
      kind: kind,
      detail: detail,
      root: holdWatch.root,
      oldRel: holdWatch.oldRel,
      newRel: holdWatch.newRel,
      at: new Date().toISOString(),
    }
    pathIncidents.push(rec)
    console.error('[wc] 路径看门狗：' + kind + ' —— ' + detail, rec)
    notice('路径异常（已记控制台）：' + kind + ' —— ' + detail, true)
  }

  /** 旧路径作废 ⇒ 顺手清掉它的草稿槽（否则下次启动会为一个不存在的路径报"有内容没保存"） */
  function forgetDraft(relPath) {
    if (!api || !api.clearDraft) return
    try {
      var p = api.clearDraft(relPath)
      if (p && p.catch) p.catch(function () { /* 清不掉不影响主流程 */ })
    } catch (e) { /* 同上 */ }
  }

  var EMPTY_WORKSPACE_TIP = '工作区里还没有作品。\n在上方填名字点「新建作品」（= 建一个目录），\n进去后再「新建文档」（= 一个 .md）。'

  /** ② 作品卡片墙：名字 + 章数 + 最后修改；点卡片进入作品；可展开直接看/开文档 */
  function renderWorks() {
    var host = els.worksGrid
    if (!host) return
    host.textContent = ''
    if (state.treeError) { host.appendChild(el('div', 'w-empty', '读取工作区失败：' + state.treeError)); return }

    var q = state.worksQuery.trim().toLowerCase()
    var items = []
    state.works.forEach(function (w) {
      if (!q || w.name.toLowerCase().indexOf(q) >= 0) items.push({ w: w })
    })
    // ⑪ C11：把「仅云端有」的作品也当成卡片列出来（**只在清单已知时**；未知 ⇒ 列表原样不动）
    var cloudOnly = remoteOnlyWorks()
    if (cloudOnly.length && !q) {
      cloudOnly.forEach(function (name) { items.push({ w: { name: name, docs: [], cloudOnly: true } }) })
      items.sort(function (a, b) { return a.w.name.localeCompare(b.w.name, 'zh') })
    }

    if (!items.length) {
      host.appendChild(el('div', 'w-empty', q
        ? ('没有匹配「' + state.worksQuery + '」的作品。')
        : EMPTY_WORKSPACE_TIP))
      return
    }

    items.forEach(function (item) {
      var w = item.w
      var rdocs = remoteOnlyDocs(w.name)
      var wrap = el('div', 'w-work-item')
      if (w.cloudOnly) wrap.classList.add('w-card-cloud')
      if (state.current && state.current.work === w.name) wrap.classList.add('active')

      var card = el('button', 'w-card')
      card.type = 'button'
      if (w.cloudOnly) {
        card.appendChild(el('span', 'w-card-title', '《' + w.name + '》 ☁'))
        card.appendChild(el('span', 'w-card-meta', rdocs.length + ' 章 · 仅云端（点击拉取）'))
        card.addEventListener('click', function () { pullRemoteWork(w.name) })
      } else {
        var nLocal = (w.docs || []).length
        var metaText = rdocs.length
          ? (nLocal + ' 本地 + ' + rdocs.length + ' 云端 · ' + fmtShortDate(workMtime(w)))
          : (nLocal + ' 章 · ' + fmtShortDate(workMtime(w)))
        card.appendChild(el('span', 'w-card-title', '《' + w.name + '》'))
        card.appendChild(el('span', 'w-card-meta', metaText))
        card.appendChild(el('span', 'w-card-open', '打开 →'))
        card.addEventListener('click', function () { enterWork(w.name) })
      }
      wrap.appendChild(card)

      // 「⋯」内联操作：本地作品 = 重命名/删除；纯云端作品 = 只有删除（本地无目录可改名）。
      // 面板挂在卡片外侧，避免按钮内嵌按钮。
      var cardMore = el('button', 'w-mini w-more', '⋯')
      cardMore.title = w.cloudOnly ? '删除云端此作品' : '重命名 / 删除此作品'
      cardMore.setAttribute('aria-label', cardMore.title)
      cardMore.addEventListener('click', function (e) {
        e.stopPropagation()
        toggleOps('w:' + w.name)
      })
      wrap.appendChild(cardMore)
      wrap.appendChild(opsPanel('w:' + w.name, function (h) { buildWorkOps(h, w) }))
      host.appendChild(wrap)
    })
  }

  /** 点「仅云端」作品卡 ⇒ 把它在服务器上的全部章节拉到本地，再进入作品（已存在的不覆盖） */
  function pullRemoteWork(workName) {
    var rdocs = remoteOnlyDocs(workName)
    if (!syncReady()) { notice('远程尚未就绪，暂时无法拉取', true); return }
    if (!rdocs.length) { notice('清单里没有可拉取的章节，稍后再试', true); return }
    notice('正在把《' + workName + '》的 ' + rdocs.length + ' 章拉到本地…')
    var okCount = 0
    var chain = Promise.resolve()
    rdocs.forEach(function (d) {
      chain = chain.then(function () {
        return window.WCSyncNet.readDraft(d.relPath).then(function (r) {
          if (!r || !r.ok) { notice('拉取失败：' + d.name + ' ' + ((r && r.error) || ''), true); return null }
          return api.writeDoc(d.relPath, r.content).then(function (wr) {
            if (!wr || !wr.ok) { notice('写入本地失败：' + d.name, true); return null }
            okCount++
            return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, d.relPath, r.version, Date.now()))
          })
        })
      })
    })
    chain.then(function () {
      state.sync.list = null
      return refreshTree()
    }).then(function () {
      if (okCount === rdocs.length) notice('已把《' + workName + '》的 ' + okCount + ' 章拉到本地')
      else notice('《' + workName + '》拉取完成：' + okCount + '/' + rdocs.length + ' 章成功', true)
      enterWork(workName)
    })
  }


  /** ③ 作品内文档树：只列**当前作品**的 .md（+ 搜索） */
  function renderTree() {
    var host = els.tree
    if (!host) return
    host.textContent = ''
    if (els.treeWorkName) els.treeWorkName.textContent = state.currentWork ? ('《' + state.currentWork + '》') : ''

    var w = null
    for (var i = 0; i < state.works.length; i++) {
      if (state.works[i].name === state.currentWork) { w = state.works[i]; break }
    }
    if (!w) {
      host.appendChild(el('div', 'w-empty', '该作品已不存在（可能被改名或删掉了）。\n点左上角「← 所有作品」返回。'))
      return
    }

    var q = state.docQuery.trim().toLowerCase()
    var docs = (w.docs || []).filter(function (d) { return !q || d.name.toLowerCase().indexOf(q) >= 0 })
    // ⑪ C11：远端有、本地没有的文档也列进来（点它 ⇒ 拉到本地再打开）
    var rdocs = remoteOnlyDocs(w.name).filter(function (d) { return !q || d.name.toLowerCase().indexOf(q) >= 0 })
    host.appendChild(el('div', 'w-tree-work',
      (w.docs || []).length + ' 章' + (rdocs.length ? '（另有 ' + rdocs.length + ' 章仅云端）' : '') +
      ' · 最后修改 ' + fmtTime(workMtime(w)) + (q ? '（筛出 ' + (docs.length + rdocs.length) + ' 个）' : '')))

    if (!docs.length && !rdocs.length) {
      host.appendChild(el('div', 'w-empty', q
        ? ('没有匹配「' + state.docQuery + '」的文档。')
        : '此作品还没有文档。\n在上方填名字点「新建文档」。'))
      return
    }
    docs.forEach(function (d) {
      host.appendChild(docEntry(d, state.currentWork))
    })
    rdocs.forEach(function (d) { host.appendChild(remoteDocEntry(d)) })
  }

  function enterWork(name) {
    if (!name) return
    state.currentWork = name
    state.view = 'tree'
    state.docQuery = ''
    if (els.docSearch) els.docSearch.value = ''
    renderSidebar()
  }

  function backToWorks() {
    state.view = 'works'
    renderSidebar()
  }

  /** 卡片展开逻辑已取消（2026-09-30：作品墙不再外铺文档，统一进入作品内选择） */

  function refreshTree() {
    if (!state.root) { renderSidebar(); return Promise.resolve() }
    return api.listWorkspace().then(function (res) {
      if (res && res.ok) {
        state.works = res.works || []
        state.treeError = ''
        // 当前进入的作品没了（被删/改名）⇒ 退回卡片墙，避免停在一个不存在的作品里
        var still = state.currentWork && state.works.some(function (w) { return w.name === state.currentWork })
        if (state.currentWork && !still) {
          state.currentWork = null
          state.view = 'works'
        }
      } else {
        state.works = []
        state.treeError = (res && res.error) || '未知错误'
        notice('读取工作区失败：' + state.treeError, true)
      }
      renderSidebar()
    })
  }

  function selectDoc(d) {
    if (!d || !d.relPath) return
    if (state.current && state.current.relPath === d.relPath) return
    // 切文档前先 flush 当前稿
    flush({ reason: 'switch-doc' }).then(function () {
      return api.readDoc(d.relPath)
    }).then(function (res) {
      if (!res || !res.ok) {
        notice('读取失败：' + ((res && res.error) || '未知错误'), true)
        return
      }
      var parts = d.relPath.split('/')
      state.current = { relPath: d.relPath, work: parts[0], name: parts[parts.length - 1], baseText: res.content }
      state.dirty = false
      state.saveState = 'saved'
      // 🔴 这里**不能**把文件 mtime 塞进 lastSavedAt：那是"文件最后修改时间"，不是"本会话自动保存时间"。
      //    旧写法会让标签显示「✓ 自动保存 · 113389 秒前」（文件是三十多小时前改的）。
      //    本会话还没存过 ⇒ 置 0，标签回落到「✓ 自动保存「开」」；首次自动保存后自然变成「N 秒前」。
      state.lastSavedAt = 0
      Editor.setValue(res.content)
      proofReset() // B5：换文档 ⇒ 上一份的建议必须清掉（判据是"文本匹配"，留着会指错地方）
      findHide(false) // ③ 换文档 ⇒ 旧文档的查找命中作废（不抢焦点）
      remoteViewHide() // ⑪ D-sync-1：「看远端内容」浮层不跨文档留
      // 分栏下：选中文档后自动收起左栏浮层 —— 否则它正好盖着刚打开的正文（"用完即收"）
      if (state.split.on && state.split.docs) state.split.docs = false
      renderSidebar()
      renderSaveState()
      renderStatusBar()
      notice('已打开 ' + d.relPath)
      // ⑪ C11：**打开之后**才做后台比对（不阻塞；理由见 syncAfterOpen 的注释）
      syncAfterOpen(d.relPath, res.content)
    })
  }

  /** ① 选择**已有**目录 —— 与「▾ 切换 → 切换到已有目录…」是**同一条路**（首次启动也走它） */
  function pickRoot() {
    return switchToExistingRoot()
  }

  /** ①-b 在应用内**新建**工作区：<父>/<名字>，由主进程 mkdir + 真写自检（复用 wc:create-root） */
  function createRoot(parentDir, label, nameRaw) {
    var tag = label || '新建工作区'
    var name = String(nameRaw == null ? '' : nameRaw).trim() || state.defaultRootName
    return api.createRoot(name, parentDir || null).then(function (res) {
      if (!res || !res.ok) {
        state.hint = tag + '失败：' + ((res && res.error) || '未知错误')
        notice(tag + '失败（详见左栏提示）', true)
        renderSidebar()
        return { ok: false }
      }
      applyRoot(res.root)
      notice('工作区已创建：' + res.root + '（父目录来源 ' + res.parentSource + '）')
      return refreshTree().then(function () { return { ok: true, root: res.root } })
    })
  }

  /** ①-b 先选父目录、再在其下建工作区（原生对话框只用来"选目录"，不依赖它的"新建文件夹"） */
  function createRootHere(nameRaw) {
    closeWsPop()
    return beforeSwitchWorkspace().then(function (go) {
      if (!go) return
      return api.pickDir().then(function (res) {
        if (!res || !res.ok) {
          if (res && res.canceled) return
          state.hint = '选择父目录失败：' + ((res && res.error) || '未知错误')
          notice('选择父目录失败（详见左栏提示）', true)
          renderSidebar()
          return
        }
        return createRoot(res.dir, '新建到指定位置', nameRaw)
      })
    })
  }

  /** 「▾ 切换 → 新建工作区」：脏 ⇒ 先确认 + flush，再建（新工作区在候选父目录下） */
  function createRootFromBar() {
    closeWsPop()
    var name = (els.wsName && els.wsName.value.trim()) || (els.newRootName && els.newRootName.value.trim()) || state.defaultRootName
    return beforeSwitchWorkspace().then(function (go) {
      if (!go) return
      return createRoot(null, '新建工作区', name)
    })
  }

  /** 提示块里的**直达按钮**：用应用内「新建工作区」（空态 / 切换失败时都不用再找） */
  function createRootFromHint() {
    var name = (els.newRootName && els.newRootName.value.trim()) || (els.wsName && els.wsName.value.trim()) || state.defaultRootName
    return beforeSwitchWorkspace().then(function (go) {
      if (!go) return
      return createRoot(null, '新建工作区', name)
    })
  }

  function newWork() {
    var name = els.newWorkName.value.trim()
    if (!name) { notice('请先填写作品名', true); return }
    api.createWork(name).then(function (res) {
      if (!res || !res.ok) { notice('新建作品失败：' + ((res && res.error) || '未知错误'), true); return }
      els.newWorkName.value = ''
      notice('已新建作品《' + name + '》· 点卡片进入')
      return refreshTree()
    })
  }

  function newDoc() {
    if (!state.root) { notice('请先选择或新建工作区', true); return }
    var work = state.currentWork || (state.current && state.current.work) || (state.works[0] && state.works[0].name)
    if (!work) { notice('请先新建（或进入）一个作品', true); return }
    var name = els.newDocName.value.trim()
    if (!name) { notice('请先填写文档名', true); return }
    if (state.currentWork !== work) { state.currentWork = work; state.view = 'tree' }
    api.createDoc(work, name).then(function (res) {
      if (!res || !res.ok) { notice('新建文档失败：' + ((res && res.error) || '未知错误'), true); return }
      els.newDocName.value = ''
      return refreshTree().then(function () {
        renderSidebar()
        return selectDoc({ relPath: res.relPath })
      })
    })
  }

  // ════════════════════════════════════════════════════════════════════════
  // ②-b 导入作品与文档（左栏卡片墙 / 作品内树都有「导入」入口）
  //
  // 语义（与 UI 文案、README 一致）：
  //   · 只接受 `.md`（大小写不敏感）；非 md / 子目录**跳过并列出**；
  //   · **复制，不移动**源文件（主进程只读源，写盘走 guard.writeDoc）；
  //   · 重名**不覆盖**，自动加后缀「 2」「 3」…（由主进程做，结果里报告）；
  //   · 两种粒度：① 选多个 .md → 进「目标作品」（可选现有作品或新建）；② 选一个文件夹 → 其中的 .md 变成一个**新作品**。
  // ════════════════════════════════════════════════════════════════════════
  function importOpen(from) {
    if (!state.root) { notice('请先选择或新建工作区', true); return }
    if (!els.importBox) return
    var sel = els.importWork
    if (sel) {
      sel.textContent = ''
      state.works.forEach(function (w) {
        var o = document.createElement('option')
        o.value = w.name
        o.textContent = '《' + w.name + '》'
        sel.appendChild(o)
      })
      var oNew = document.createElement('option')
      oNew.value = '__new__'
      oNew.textContent = '＋ 新建作品…'
      sel.appendChild(oNew)
      // 从「作品内」进来 ⇒ 默认就是当前作品；没有作品时默认「新建作品」
      if (from === 'tree' && state.currentWork) sel.value = state.currentWork
      else if (state.current && state.current.work) sel.value = state.current.work
      else if (!state.works.length) sel.value = '__new__'
    }
    if (els.importResult) els.importResult.textContent = ''
    if (els.importNote) {
      els.importNote.textContent =
        '当前工作区：' + state.root + '\n' +
        '「选择 .md 文件…」进上面选的「目标作品」；「导入整个文件夹…」一律按**文件夹名新建一个作品**（不递归子目录）。'
    }
    els.importBox.hidden = false
    if (els.importFilesBtn) els.importFilesBtn.focus()
  }

  function importClose() {
    if (els.importBox) els.importBox.hidden = true
  }

  /** 目标作品（仅「选文件」用；导入文件夹时由主进程按文件夹名新建） */
  function importTargetSpec() {
    var v = els.importWork ? els.importWork.value : ''
    if (v === '__new__') {
      var n = (els.importNewWork && els.importNewWork.value.trim()) || ''
      if (!n) { notice('请先填写新作品名', true); return null }
      return { mode: 'new', name: n }
    }
    if (!v) { notice('请先选择目标作品', true); return null }
    return { mode: 'existing', name: v }
  }

  function renderImportResult(text) {
    if (els.importResult) els.importResult.textContent = text || ''
  }

  function importPickFiles() {
    if (!state.root) { notice('请先选择或新建工作区', true); return }
    var target = importTargetSpec()
    if (!target) return
    api.pickImportFiles().then(function (res) {
      if (!res || !res.ok) {
        if (res && res.canceled) return
        notice('选择文件失败：' + ((res && res.error) || '未知错误'), true)
        return
      }
      return runImport({ kind: 'files', paths: res.paths, target: target }, 'files')
    })
  }

  function importPickDir() {
    if (!state.root) { notice('请先选择或新建工作区', true); return }
    api.pickImportDir().then(function (res) {
      if (!res || !res.ok) {
        if (res && res.canceled) return
        notice('选择文件夹失败：' + ((res && res.error) || '未知错误'), true)
        return
      }
      return runImport({ kind: 'dir', dir: res.dir }, 'dir')
    })
  }

  function encLabel(e) {
    if (e === 'utf-8-bom') return '（UTF-8 BOM）'
    if (e === 'gbk') return '（GBK→UTF-8）'
    return ''
  }

  /** 汇总文本：成功 N / 跳过 M / 失败 K + 明细（不静默吞掉任何一条） */
  function summaryText(res) {
    var lines = []
    lines.push('导入完成 —— 成功 ' + res.counts.imported + ' / 跳过 ' + res.counts.skipped + ' / 失败 ' + res.counts.failed)
    lines.push(
      '目标作品：《' + res.work + '》' +
      (res.workCreated ? '（已新建）' : '（已存在）') +
      (res.workRenamedFrom ? '　⚠️ 原名《' + res.workRenamedFrom + '》已存在，改用带后缀的名字' : ''),
    )
    lines.push('源文件**一律未被移动**（只读取复制）。')
    if (res.imported.length) {
      lines.push('')
      lines.push('— 已导入（' + res.imported.length + '）—')
      res.imported.forEach(function (f) {
        lines.push(
          '  · ' + f.name + encLabel(f.encoding) + (f.empty ? '（0 字节空文件）' : '') +
          (f.renamed ? '　⚠️ 源名「' + f.from + '」→ ' + f.renamed : ''),
        )
      })
    }
    if (res.skipped.length) {
      lines.push('')
      lines.push('— 已跳过（' + res.skipped.length + '）—')
      res.skipped.forEach(function (f) { lines.push('  · ' + f.name + '：' + f.reason) })
    }
    if (res.failed.length) {
      lines.push('')
      lines.push('— 失败（' + res.failed.length + '）—')
      res.failed.forEach(function (f) { lines.push('  · ' + f.name + '：' + f.error) })
    }
    return lines.join('\n')
  }

  function runImport(spec, kindLabel) {
    if (els.importFilesBtn) els.importFilesBtn.disabled = true
    if (els.importDirBtn) els.importDirBtn.disabled = true
    state.importBusy = true
    renderImportResult('导入中…（' + (kindLabel === 'dir' ? '文件夹' : '文件') + '）')
    return api.importInto(spec).then(function (res) {
      state.importBusy = false
      if (els.importFilesBtn) els.importFilesBtn.disabled = false
      if (els.importDirBtn) els.importDirBtn.disabled = false
      if (!res || !res.ok) {
        var msg = (res && res.error) || '未知错误'
        renderImportResult('导入失败：' + msg)
        notice('导入失败：' + msg, true)
        return
      }
      renderImportResult(summaryText(res))
      notice(
        '导入完成：成功 ' + res.counts.imported + ' / 跳过 ' + res.counts.skipped +
        ' / 失败 ' + res.counts.failed + '（源文件未移动）',
      )
      // 刷新树 + 直接进入导入到的作品（让用户马上看到结果）
      return refreshTree().then(function () {
        if (res.work && state.works.some(function (w) { return w.name === res.work })) {
          enterWork(res.work)
        } else {
          renderSidebar()
        }
      })
    }, function (err) {
      state.importBusy = false
      if (els.importFilesBtn) els.importFilesBtn.disabled = false
      if (els.importDirBtn) els.importDirBtn.disabled = false
      var msg = String((err && err.message) || err)
      renderImportResult('导入异常：' + msg)
      notice('导入异常：' + msg, true)
    })
  }


  // ════════════════════════════════════════════════════════════════════════
  // 番茄钟（25/5 可配；顶部倒计时）
  // ════════════════════════════════════════════════════════════════════════
  var pomo = { mode: 'focus', running: false, remain: 0, id: null }

  function pomoRender() {
    if (els.pomoTime) {
      var m = Math.floor(pomo.remain / 60)
      var s = pomo.remain % 60
      els.pomoTime.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
    }
    if (els.pomoMode) els.pomoMode.textContent = pomo.mode === 'focus' ? '专注' : '休息'
    if (els.pomoToggle) els.pomoToggle.textContent = pomo.running ? '暂停' : '开始'
  }

  function pomoSay(text) {
    if (els.pomoNote) els.pomoNote.textContent = text
  }

  function pomoPause() {
    pomo.running = false
    if (pomo.id) { clearInterval(pomo.id); pomo.id = null }
    pomoRender()
  }

  function pomoReset() {
    pomoPause()
    pomo.mode = 'focus'
    pomo.remain = state.pomodoro.focusMin * 60
    pomoSay('')
    pomoRender()
  }

  function pomoToggle() {
    if (pomo.running) { pomoPause(); return }
    if (pomo.remain <= 0) pomo.remain = state.pomodoro.focusMin * 60
    pomo.running = true
    pomo.id = setInterval(function () {
      pomo.remain -= 1
      if (pomo.remain <= 0) {
        pomo.mode = pomo.mode === 'focus' ? 'break' : 'focus'
        pomo.remain = (pomo.mode === 'focus' ? state.pomodoro.focusMin : state.pomodoro.breakMin) * 60
        // ⑩ U-20 #40①：**专注轮**走完 ⇒ 往工作区「番茄钟记录.md」追加一行。
        //   ⚠️ 只在 focus→break 这一步记（break→focus 不计）；**重置/暂停不记**。
        //   写失败只回 error、不打断番茄钟（主进程已兜住）。
        if (pomo.mode === 'break') {
          var cur = state.current
          api
            .appendPomodoro({
              focusMin: state.pomodoro.focusMin,
              doc: cur ? '《' + cur.work + '/' + cur.name + '》' : '',
            })
            .catch(function () {})
        }
        var msg = pomo.mode === 'focus' ? '🍅 休息结束，回到专注' : '🍅 专注结束，休息一下'
        // 「设置 → 番茄钟 → 自动开始下一轮」：默认开（= 原行为）；关掉则一轮结束即**暂停**
        if (state.pomodoro.autoNext === false) {
          pomoPause()
          pomoSay(msg + '（已暂停，点「开始」继续）')
          return
        }
        pomoSay(msg)
      }
      pomoRender()
    }, 1000)
    pomoSay('')
    pomoRender()
  }

  /**
   * 番茄钟配置的**唯一写入口**（设置弹层与工具栏输入框都走它 ⇒ **不造第二份配置**）。
   * 写 state → 同步**两处**输入框 → 落配置（以主进程 clamp 后的值为准回填）→ 重置倒计时。
   * ⚠️ `opts.noReset`：只改「自动开始下一轮」这种**不影响时长**的开关时**不重置**倒计时
   *   （否则用户切一下开关就会把正在走的这一轮清回起点 —— 那与设置项本身无关）。
   */
  function applyPomodoro(focusRaw, breakRaw, autoNext, opts) {
    var noReset = !!(opts && opts.noReset)
    var f = clampInt(focusRaw, 1, 180, 25)
    var b = clampInt(breakRaw, 1, 60, 5)
    var an = autoNext === undefined ? state.pomodoro.autoNext !== false : autoNext !== false
    state.pomodoro = { focusMin: f, breakMin: b, autoNext: an }
    syncPomodoroInputs()
    api.saveConfig({ pomodoro: state.pomodoro }).then(function (res) {
      if (res && res.ok && res.config && res.config.pomodoro) {
        state.pomodoro = res.config.pomodoro // 主进程 clamp 后的值 = 权威值
        syncPomodoroInputs()
      }
    })
    if (!noReset) pomoReset()
  }

  /** 把 state.pomodoro 回填到**工具栏**与**设置弹层**两处输入框（保持两者一致） */
  function syncPomodoroInputs() {
    var p = state.pomodoro
    if (els.focusMin) els.focusMin.value = p.focusMin
    if (els.breakMin) els.breakMin.value = p.breakMin
    if (els.setFocus) els.setFocus.value = p.focusMin
    if (els.setBreak) els.setBreak.value = p.breakMin
    if (els.setAutoNext) els.setAutoNext.checked = p.autoNext !== false
  }

  function onPomodoroConfigChange() {
    applyPomodoro(els.focusMin.value, els.breakMin.value)
    notice('番茄钟已设为 专注 ' + state.pomodoro.focusMin + ' 分 / 休息 ' + state.pomodoro.breakMin + ' 分')
  }

  // ════════════════════════════════════════════════════════════════════════
  // ⑤ 「设置」弹层（**壳层级** · 不占三栏空间 · 动态可调项）
  //
  // 形态：壳层 header 上「⚙ 设置」→ `#s-modal`（body 下、`position: fixed`）⇒ 从 [DSH] / [写作]
  //   任一页都能打开，且**不参与三栏布局**。样式照 §19（Modal r24 + elevation-prominent + 遮罩 token）。
  //
  // 🔴 每一项都**真正生效**（不做"存了但没用"的假开关）：
  //   · 自动保存去抖 → DEBOUNCE_MS（立即；scheduleAutosave 用它）
  //   · 编辑器字号   → textarea 的 inline font-size（0 = 移除 ⇒ 回到跟随 [DSH] 字号轴）
  //   · 番茄钟时长/自动下一轮 → 与工具栏**同一份** state.pomodoro + 同一份配置（applyPomodoro）
  //   · 主题         → window.__wcTheme.setOverride（强制覆盖跟随；切回"跟随"即恢复镜像）
  //   · 草稿上限/单份上限 → 主进程 writeDraft/pruneDrafts 每次读配置（下一个草稿写入时生效）
  //   · 启动提示开关 → checkStartupNotices() 是否显示横幅（下次启动生效）
  //   · 网关地址/端口 → **只写配置**；反代在启动时绑端口 ⇒ UI 明说「重启生效」，运行期**不**热改反代
  //
  // ⚠️ 配置统一落 `userData/config.json`（沿用既有 `wc:save-config`，**不新造文件**）；
  //   写入值一律以**主进程 clamp 后的回读值**为准 ⇒ 非法输入不会写坏配置、也不会留在界面上。
  // ════════════════════════════════════════════════════════════════════════
  function settingsOpen() {
    if (!els.setBox) return
    renderSettings()
    els.setBox.hidden = false
    if (els.setClose) els.setClose.focus()
  }

  function settingsClose() {
    if (els.setBox) els.setBox.hidden = true
  }

  function settingsIsOpen() {
    return !!els.setBox && !els.setBox.hidden
  }

  /** 把当前配置填进弹层（打开时 / 外部变更后调用） */
  function renderSettings() {
    var s = state.settings || {}
    var a = s.autosave || {}
    var d = s.drafts || {}
    var e = s.editor || {}
    var r = s.remote || {}
    if (els.setRoot) {
      els.setRoot.textContent = state.root || '（未选择工作区）'
      els.setRoot.title = state.root || ''
    }
    if (els.setName && !els.setName.value) els.setName.value = state.defaultRootName
    if (els.setDebounce) els.setDebounce.value = a.debounceMs != null ? a.debounceMs : 1000
    if (els.setFontSize) els.setFontSize.value = e.fontSize || 0
    renderTypoInputs()
    syncPomodoroInputs() // 番茄钟两处输入框（工具栏 + 弹层）保持同一份
    var theme = s.theme || 'auto'
    Array.prototype.forEach.call(document.querySelectorAll('input[name="s-theme"]'), function (radio) {
      radio.checked = radio.value === theme
    })
    if (els.setDraftFiles) els.setDraftFiles.value = d.maxFiles != null ? d.maxFiles : 200
    if (els.setDraftBytes) {
      var mb = (d.maxBytes != null ? d.maxBytes : 5 * 1024 * 1024) / (1024 * 1024)
      els.setDraftBytes.value = Math.round(mb * 1000) / 1000
    }
    if (els.setNotify) els.setNotify.checked = d.notifyOnStartup !== false
    // 总容量上限（MB；两侧同口径：主进程存字节、界面显示 MB，与「单份上限」一致）
    if (els.setDraftTotal) {
      var mbTotal = (d.maxTotalBytes != null ? d.maxTotalBytes : 128 * 1024 * 1024) / (1024 * 1024)
      els.setDraftTotal.value = Math.round(mbTotal * 1000) / 1000
    }
    // 设置页的「当前占用」也刷一次（它随编辑变化，不只是开关弹层时）
    renderDraftsUsage()
    // ⑨ 诉求预设（可自定义）：数组 ⇄ 每行一个的文本
    if (els.setSendIntents) {
      var si = (s.send && s.send.intents) || []
      els.setSendIntents.value = si.join('\n')
    }
    if (els.setDraftsDir) {
      els.setDraftsDir.textContent = state.draftsDir || '（未知）'
      els.setDraftsDir.title = state.draftsDir || ''
    }
    if (els.setGateway) els.setGateway.value = r.gateway || ''
    if (els.setPort) els.setPort.value = r.port != null ? r.port : 18080
    // ⑨ C9：入口模式（自动 = 按顺位探测 + 降级；手动 = 只用上面的地址）
    if (els.setRemoteMode) els.setRemoteMode.value = r.mode === 'manual' ? 'manual' : 'auto'
    // ⑥ B5：校对专用会话 id（主进程已把"配置为空 ⇒ 内置默认"解析好 ⇒ 这里显示的是**生效值**）
    if (els.setProofSession) els.setProofSession.value = state.proofreadSessionId || ''
    // ⑧ T-10：启动与托盘（默认值与 main.js 的 SETTINGS_DEFAULTS.general 一致：自启关、托盘开）
    //   tray = **托盘图标 + 关闭时收起**合为一个开关（只开其中一个没有意义，见 main.js 注释）
    var gen = (s.general && typeof s.general === 'object') ? s.general : {}
    if (els.setAutoStart) els.setAutoStart.checked = gen.autoStart === true
    if (els.setTray) els.setTray.checked = gen.tray !== false
    // 托盘**实况**：主进程如实回报「已就绪 / 未建 · 原因」——本仓打包后看不到 stdout 日志，
    //   所以"托盘到底建没建成"只能靠这一行告诉用户（见 main.js 的 trayState 注释）
    if (els.setTrayNote) {
      var note = String(gen.note || '')
      els.setTrayNote.textContent = note ? ('托盘状态：' + note) : ''
      els.setTrayNote.style.color = (gen.ready === true) ? '' : 'var(--w-warn, #c77)'
    }
    refreshRemoteEffectiveNote()
  }

  /**
   * 「远程」的说明里如实写出**两条实况**：
   *   · 下次启动要用的值（= 刚保存进 config 的 remote.mode/gateway/port）
   *   · 本次启动**真正生效**的那条线路 + 顺位 + 逐条结果（失败/跳过一律写明原因 —— D-8/D-11 的教训）
   */
  function refreshRemoteEffectiveNote() {
    if (!els.setRemoteEff) return
    var r = (state.settings && state.settings.remote) || {}
    var parts = [
      '下次启动：入口=' + (r.mode === 'manual' ? '手动' : '自动') +
        ' · 网关=' + (r.gateway || '（默认）') +
        ' · 端口=' + (r.port != null ? r.port : '（默认）'),
    ]
    var eff = state.remoteEffective
    if (eff) {
      parts.push('本次生效：' + eff.gateway + ' · 端口 ' + eff.port)
      var rp = eff.report
      if (rp) {
        if (rp.mode === 'auto') {
          parts.push('入口 自动' + (rp.tailnet ? '（本机在 tailnet 内）' : '（本机不在 tailnet 内）'))
          if (rp.order && rp.order.length) parts.push('顺位 ' + rp.order.join(' → '))
          var lines = rp.lines || []
          for (var i = 0; i < lines.length; i++) parts.push(lines[i])
        } else {
          parts.push('入口 ' + rp.mode + '（来源 ' + rp.source + '）')
        }
      }
    }
    els.setRemoteEff.textContent = parts.join('　｜　')
  }

  /** 把配置**真正作用到运行时**（供启动时与每次保存后调用） */
  function applySettings() {
    var s = state.settings || {}
    var a = s.autosave || {}
    DEBOUNCE_MS = clampInt(a.debounceMs, 200, 10000, 1000)
    applyTypography() // ③ 排版：输入区 6 类 + 预览区全套（默认值 = 原行为）
    applyTheme(s.theme || 'auto')
    renderAutosaveLabel()
  }

  // ════════════════════════════════════════════════════════════════════════
  // ③ 排版（中文码字）—— **只有「写作区」一组**（B4 起中栏只有它，预览区连同 `markdown.js` 已删，见 C8）：
  //   · 写作区 = 纯文本 `contentEditable`（`pre-wrap`，整篇一个文本流）⇒ 可做：字号 / 字体族 / 行高 /
  //     字间距 / 行宽(最大宽度) / 配色(底·字·光标·选区)。
  //     🔴 **不做**段间距 / 首行缩进 —— 那两项必须挂在**段落元素**上，而这里 DOM 里没有段落元素
  //     （用户 2026-09-27 拍 A：靠**空行**分段，段距 = 0；见 open-items CR-5）。
  // 实现一律走 **inline 样式 / CSS 变量**，不改 token、不加依赖；置空(移除属性) 即回原样式 ⇒
  //   「默认值 = 加本组之前的行为」是天然成立的（不设 inline 就是原状态）。
  // ════════════════════════════════════════════════════════════════════════

  /**
   * 字体族预设（**中文优先**；理由）：
   *   · kai   楷体 = **默认**（2026-09-27 用户习惯字体；中文小说有手写"书感"）。
   *                 ⚠️ 族名要同时给**英文名与中文名**：Windows 上 `KaiTi`（simkai.ttf）注册名即 `KaiTi`，
   *                 部分环境按中文名 `楷体` 匹配；macOS 侧华文楷体是 `Kaiti SC` / `STKaiti`。
   *                 都没有时退到 serif（**不编造不存在的字体名**）。
   *   · mono  等宽 = 原默认（`var(--ds-font-family-code)`）—— md 源码对齐舒服，纯写作偏硬。
   *   · serif 衬线 = 宋体系（Windows `SimSun` / macOS `Songti SC` / 思源宋体）⇒ 写小说更有"书感"。
   *   · sans  无衬线 = 雅黑 / 苹方系 ⇒ 屏幕最清晰（长文略"平"）。
   *   · dsh   跟随 [DSH] = 用 DSH 的正文 token `--dsw-font-family`（唯一"跟随"档）。
   */
  var FONT_STACKS = {
    kai: '"KaiTi", "楷体", "Kaiti SC", "STKaiti", "Kaiti TC", "AR PL UKai CN", "SimSun", serif',
    mono: 'var(--ds-font-family-code)',
    dsh: 'var(--dsw-font-family)',
    serif: '"Songti SC", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif',
    sans: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif',
  }

  function toNum(v, dflt) {
    var n = typeof v === 'string' ? parseFloat(v) : Number(v)
    return isFinite(n) ? n : dflt
  }

  function applyTypography() {
    // B4 起只有**一组**排版（写作区）；原「预览区」那一组已随单栏改造下线（见 shell.html 注释）
    applyEditorTypography((state.settings && state.settings.editor) || {})
  }

  /** 写作区（contentEditable）：字号 / 字体族 / 行高 / 字间距 / 行宽 / 配色 */
  function applyEditorTypography(e) {
    var ta = Editor.el // 变量名沿用 `ta`（原为 textarea）；现在指向 `.w-editor` 那个 contentEditable
    if (!ta) return
    // 字号（既有项）：0 = 移除 inline ⇒ 回 `var(--dsh-content-font-size, 14px)`
    var fs = clampInt(e.fontSize, 0, 32, 0)
    if (fs > 0 && fs < 10) fs = 10 // 与主进程的 [10, 32] 对齐
    if (fs <= 0) ta.style.removeProperty('font-size')
    else ta.style.fontSize = fs + 'px'
    // 字体族：**总是写 inline**（含 'mono'）。
    //   ⚠️ 上游做法是"mono = 移除 inline ⇒ 用样式表的 `var(--ds-font-family-code)`"，但**默认已改成楷体**
    //     ⇒ 样式表的默认值现在是楷体改不回来了 ⇒ 必须显式写，否则选「等宽」会拿到楷体。
    //   未知值 ⇒ 退到默认档（kai），不写一个不存在的字体名。
    ta.style.fontFamily = FONT_STACKS[e.fontFamily] || FONT_STACKS.kai
    // 行高：0 = 移除 inline ⇒ 回 `--dsw-font-markdown-base-line-height`
    var lh = toNum(e.lineHeight, 0)
    if (lh > 0) ta.style.lineHeight = String(lh)
    else ta.style.removeProperty('line-height')
    // 字间距：0 = 移除 ⇒ 无字间距
    var ls = toNum(e.letterSpacing, 0)
    if (ls > 0) ta.style.letterSpacing = ls + 'em'
    else ta.style.removeProperty('letter-spacing')
    // 行宽（measure）：max-width + 居中；0 = 不限宽（原行为）
    // ⚠️ 单位用 **em**（不用 ch）：中文全角字宽 ≈ 1em，而 `ch` 是"0"的宽度（等宽字体下 ≈0.6em）
    //     ⇒ 用 ch 会严重低估每行汉字数（实测见报告）。em 还能随字号一起缩放。
    var m = clampInt(e.measure, 0, 48, 0)
    if (m > 0) {
      ta.style.maxWidth = m + 'em'
      ta.style.marginLeft = 'auto'
      ta.style.marginRight = 'auto'
    } else {
      ta.style.removeProperty('max-width')
      ta.style.removeProperty('margin-left')
      ta.style.removeProperty('margin-right')
    }
    // 配色（底/字/光标/选区）：'default' = 移除属性 ⇒ 回 --dsw-* 与浏览器默认（原行为）；
    //   预设（sepia 米白 / green 淡绿）在 writing.css 里按 `[data-typo-color]` 写死值（不新造 token）
    var host = document.getElementById('page-writing')
    if (host) {
      if (!e.colorPreset || e.colorPreset === 'default') host.removeAttribute('data-typo-color')
      else host.setAttribute('data-typo-color', e.colorPreset)
    }
  }

  // （原 applyPreviewTypography 已删除 —— B4 起没有预览区那一栏，设置里的预览组也一并下线）

  /** 主题：「跟随 [DSH]」= auto（原行为）；「强制亮/暗」覆盖跟随（shell.html 的 window.__wcTheme） */
  function applyTheme(theme) {
    if (window.__wcTheme && window.__wcTheme.setOverride) window.__wcTheme.setOverride(theme)
  }

  /**
   * 保存设置并**以主进程回读的归一化值为准**应用（clamp 在 main.js 做）⇒ 非法输入既写不进配置、
   * 也不会在界面上留下非法值（renderSettings 会用回读值重填）。
   */
  function saveSettings(patch) {
    return api.saveConfig(patch).then(
      function (res) {
        if (res && res.ok && res.settings) {
          state.settings = res.settings
          applySettings()
          renderSettings()
        } else {
          notice('设置保存失败：' + ((res && res.error) || '未知错误'), true)
          renderSettings() // 回填 ⇒ 界面上不留非法值
        }
        return res
      },
      function (err) {
        notice('设置保存异常：' + String((err && err.message) || err), true)
        renderSettings()
        return { ok: false }
      },
    )
  }

  // ── ③ 排版：一键预设 + 控件回填 + 变更接线 ────────────────────────────────
  // 「默认」= 与加本组之前的行为**逐项一致**（不留任何 inline/属性）；「舒适」「紧凑」为中文码字的推荐档。
  // ⚠️ 预设只写「排版」，不碰其它设置（去抖 / 番茄钟 / 主题 / 草稿 / 远程）。
  // ⚠️ B4 起只有**一组**（写作区）：原「预览区」那一组的键（settings.preview）**不再被这里读写**
  //    （UI 已下线；main.js 的 clamp/默认值保留不动，属于无谓兼容面，不值得为它改主进程）。
  var TYPO_PRESETS = {
    'default': { fontSize: 0, fontFamily: 'kai', lineHeight: 0, letterSpacing: 0, measure: 0, colorPreset: 'default' },
    comfort: { fontSize: 18, fontFamily: 'serif', lineHeight: 1.9, letterSpacing: 0.03, measure: 36, colorPreset: 'default' },
    compact: { fontSize: 0, fontFamily: 'sans', lineHeight: 1.5, letterSpacing: 0, measure: 0, colorPreset: 'default' },
  }

  var TYPO_PRESET_TEXT = {
    'default': '「默认」= 出厂设置：楷体 · 字号/行高跟随 [DSH] · 不限宽 · 配色跟随主题。',
    comfort: '「舒适」（中文长文）：衬线 18px · 行高 1.9 · 字间距 0.03em · 行宽 36em。',
    compact: '「紧凑」（快速核对）：无衬线 · 行高 1.5 · 不限宽 · 字号跟随。',
  }

  /** 把 state.settings 的排版值回填到弹层控件（**以主进程归一化后的值为准**） */
  function renderTypoInputs() {
    var s = state.settings || {}
    var e = s.editor || {}
    if (els.setFontSize) els.setFontSize.value = e.fontSize || 0
    if (els.setTypoEditorFF) els.setTypoEditorFF.value = e.fontFamily || 'kai'
    if (els.setTypoLineHeight) els.setTypoLineHeight.value = e.lineHeight || 0
    if (els.setTypoLetterSpacing) els.setTypoLetterSpacing.value = e.letterSpacing || 0
    if (els.setTypoMeasure) els.setTypoMeasure.value = e.measure || 0
    if (els.setTypoColor) els.setTypoColor.value = e.colorPreset || 'default'
    renderTypoPresetNote()
  }

  /** 预设说明 + 当前值是否**正好等于**某档（点了按钮后能确认真的落上了） */
  function renderTypoPresetNote() {
    if (!els.typoPresetNote) return
    var cur = typoMatchesPreset()
    var lines = [
      TYPO_PRESET_TEXT['default'],
      TYPO_PRESET_TEXT.comfort,
      TYPO_PRESET_TEXT.compact,
      '口径：字号 0 = 跟随 [DSH] 字号轴；行高 0 = 跟随原 token；字间距 0 = 不加；行宽 0 = 跟随窗口（不限宽）。',
      '写作区是纯文本（contentEditable）⇒ 只有上面这几项；段间距 / 首行缩进需要有"渲染结果"那一栏，已在单栏改造中去掉。',
    ]
    if (cur) lines.push('当前 = 「' + cur + '」档。')
    els.typoPresetNote.textContent = lines.join('\n')
  }

  /** 当前排版值是否正好等于某一档预设（返回中文档名或 null） */
  function typoMatchesPreset() {
    var s = state.settings || {}
    var e = s.editor || {}
    var names = { 'default': '默认', comfort: '舒适', compact: '紧凑' }
    var keys = Object.keys(TYPO_PRESETS)
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      var pe = TYPO_PRESETS[k]
      var hit = true
      Object.keys(pe).forEach(function (f) {
        if ((e[f] === undefined ? 0 : e[f]) !== pe[f]) hit = false
      })
      if (hit) return names[k]
    }
    return null
  }

  /** 一键预设：写这一组排版（仍是同一个 saveSettings 通道 ⇒ 同一份配置） */
  function applyTypoPreset(name) {
    var preset = TYPO_PRESETS[name]
    if (!preset) return
    saveSettings({ editor: preset }).then(function (res) {
      if (res && res.ok) {
        var label = name === 'default' ? '默认' : name === 'comfort' ? '舒适' : '紧凑'
        notice('排版已应用「' + label + '」预设（立即生效）')
      }
    })
  }

  function wireSettings() {
    if (els.setBtn) els.setBtn.addEventListener('click', function () { settingsOpen() })
    if (els.setClose) els.setClose.addEventListener('click', settingsClose)
    if (els.setBox) {
      els.setBox.addEventListener('click', function (e) {
        if (e.target === els.setBox) settingsClose() // 点遮罩关闭（照导入模态）
      })
    }

    // ① 工作区：复用**既有** IPC 与既有流程（含 flush + confirm）
    if (els.setSwitch) {
      els.setSwitch.addEventListener('click', function () {
        switchToExistingRoot().then(function () { renderSettings() })
      })
    }
    if (els.setCreate) {
      els.setCreate.addEventListener('click', function () {
        createRoot(null, '新建工作区', els.setName ? els.setName.value : '').then(function () {
          renderSettings()
        })
      })
    }
    if (els.setCreateHere) {
      els.setCreateHere.addEventListener('click', function () {
        createRootHere(els.setName ? els.setName.value : '').then(function () { renderSettings() })
      })
    }

    // ② 编辑器（立即生效）
    if (els.setDebounce) {
      els.setDebounce.addEventListener('change', function () {
        saveSettings({ autosave: { debounceMs: els.setDebounce.value } }).then(function (res) {
          if (res && res.ok) notice('自动保存去抖已设为 ' + DEBOUNCE_MS + ' ms（立即生效）')
        })
      })
    }
    if (els.setFontSize) {
      els.setFontSize.addEventListener('change', function () {
        saveSettings({ editor: { fontSize: els.setFontSize.value } })
      })
    }

    // ③ 排版（输入区 / 预览区）——逐项 change ⇒ 立即生效 + 落配置；预设按钮一次写两组
    if (els.setTypoEditorFF) {
      els.setTypoEditorFF.addEventListener('change', function () {
        saveSettings({ editor: { fontFamily: els.setTypoEditorFF.value } })
      })
    }
    if (els.setTypoLineHeight) {
      els.setTypoLineHeight.addEventListener('change', function () {
        saveSettings({ editor: { lineHeight: els.setTypoLineHeight.value } })
      })
    }
    if (els.setTypoLineHeightRec) {
      els.setTypoLineHeightRec.addEventListener('click', function () {
        saveSettings({ editor: { lineHeight: 1.9 } }).then(function (res) {
          if (res && res.ok) notice('输入区行高已设为 1.9（中文舒适区 1.8–2.0）')
        })
      })
    }
    if (els.setTypoLetterSpacing) {
      els.setTypoLetterSpacing.addEventListener('change', function () {
        saveSettings({ editor: { letterSpacing: els.setTypoLetterSpacing.value } })
      })
    }
    if (els.setTypoMeasure) {
      els.setTypoMeasure.addEventListener('change', function () {
        saveSettings({ editor: { measure: els.setTypoMeasure.value } })
      })
    }
    if (els.setTypoColor) {
      els.setTypoColor.addEventListener('change', function () {
        saveSettings({ editor: { colorPreset: els.setTypoColor.value } })
      })
    }
    if (els.typoPresetDefault) els.typoPresetDefault.addEventListener('click', function () { applyTypoPreset('default') })
    if (els.typoPresetComfort) els.typoPresetComfort.addEventListener('click', function () { applyTypoPreset('comfort') })
    if (els.typoPresetCompact) els.typoPresetCompact.addEventListener('click', function () { applyTypoPreset('compact') })

    // ④ 番茄钟（与工具栏**共用** applyPomodoro ⇒ 同一份配置/同一个 state）
    if (els.setFocus) {
      els.setFocus.addEventListener('change', function () {
        applyPomodoro(els.setFocus.value, els.setBreak.value, els.setAutoNext ? els.setAutoNext.checked : undefined)
      })
    }
    if (els.setBreak) {
      els.setBreak.addEventListener('change', function () {
        applyPomodoro(els.setFocus.value, els.setBreak.value, els.setAutoNext ? els.setAutoNext.checked : undefined)
      })
    }
    if (els.setAutoNext) {
      els.setAutoNext.addEventListener('change', function () {
        // ⚠️ 只切开关 ⇒ `noReset`：不要因为切一下就把正在走的这一轮清回起点
        applyPomodoro(state.pomodoro.focusMin, state.pomodoro.breakMin, els.setAutoNext.checked, {
          noReset: true,
        })
      })
    }

    // ⑤ 外观（立即生效：强制覆盖跟随；切回跟随立即恢复镜像）
    Array.prototype.forEach.call(document.querySelectorAll('input[name="s-theme"]'), function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return
        applyTheme(radio.value)
        saveSettings({ theme: radio.value }).then(function (res) {
          if (res && res.ok) {
            notice('主题已设为 ' + (radio.value === 'auto' ? '跟随 [DSH]' : radio.value === 'light' ? '强制亮' : '强制暗'))
          }
        })
      })
    })

    // ⑥ 草稿（份数 / 单份大小 / 启动提示）
    if (els.setDraftFiles) {
      els.setDraftFiles.addEventListener('change', function () {
        saveSettings({ drafts: { maxFiles: els.setDraftFiles.value } })
      })
    }
    if (els.setDraftBytes) {
      els.setDraftBytes.addEventListener('change', function () {
        var mb = Number(els.setDraftBytes.value)
        saveSettings({ drafts: { maxBytes: Math.round((isFinite(mb) ? mb : 0) * 1024 * 1024) } })
      })
    }
    if (els.setDraftTotal) {
      els.setDraftTotal.addEventListener('change', function () {
        var mb = Number(els.setDraftTotal.value)
        saveSettings({ drafts: { maxTotalBytes: Math.round((isFinite(mb) ? mb : 0) * 1024 * 1024) } })
      })
    }
    if (els.setNotify) {
      els.setNotify.addEventListener('change', function () {
        saveSettings({ drafts: { notifyOnStartup: els.setNotify.checked } })
      })
    }

    // ⑨ 发送 · 诉求预设（用户 2026-09-28：**可自定义** —— 他一直在手填「成果」）
    //   存的是**多行文本**；主进程 `wc:save-config` 会归一化（每行一个、去空、去重、单条≤40字、最多20条）
    if (els.setSendIntents) {
      els.setSendIntents.addEventListener('change', function () {
        saveSettings({ send: { intents: els.setSendIntents.value } })
      })
    }

    // ⑧ T-10 启动与托盘：**立即生效**（主进程写盘后会 setLoginItemSettings / 建或拆托盘；
    //   只改一项时另两项由主进程按现值补齐，见 wc:save-config 的 general 分支）
    if (els.setAutoStart) {
      els.setAutoStart.addEventListener('change', function () {
        saveSettings({ general: { autoStart: els.setAutoStart.checked } })
      })
    }
    if (els.setTray) {
      els.setTray.addEventListener('change', function () {
        saveSettings({ general: { tray: els.setTray.checked } })
      })
    }

    // ⑦ 远程（**只写配置**；重启后生效 —— 运行期不改反代）
    if (els.setRemoteMode) {
      els.setRemoteMode.addEventListener('change', function () {
        saveSettings({ remote: { mode: els.setRemoteMode.value } }).then(function (res) {
          if (res && res.ok) notice('入口模式已保存 —— 重启客户端后生效')
        })
      })
    }
    // ⑩ U-20 #40④：一键重启（把"重启生效"从"要用户自己关开窗口"变成一次点击）。
    //   ⚠️ 先 `confirm` 是因为它会**关掉并重新拉起整个客户端**（含 [DSH] 页）；
    //   主进程走 `app.quit()` 优雅退出 ⇒ 未保存内容会先 flush，不是强杀。
    if (els.setRestart) {
      els.setRestart.addEventListener('click', function () {
        if (!window.confirm('立即重启客户端？\n\n窗口会关闭并自动重新打开（未保存内容会先落盘）。')) return
        els.setRestart.disabled = true
        els.setRestart.textContent = '正在重启…'
        api.relaunch().catch(function () {
          els.setRestart.disabled = false
          els.setRestart.textContent = '重启客户端'
          notice('重启失败：请手动关开客户端', true)
        })
      })
    }
    if (els.setGateway) {
      els.setGateway.addEventListener('change', function () {
        saveSettings({ remote: { gateway: els.setGateway.value } }).then(function (res) {
          if (res && res.ok) notice('网关地址已保存 —— 重启客户端后生效')
        })
      })
    }
    if (els.setPort) {
      els.setPort.addEventListener('change', function () {
        saveSettings({ remote: { port: els.setPort.value } }).then(function (res) {
          if (res && res.ok) notice('回环端口已保存 —— 重启客户端后生效')
        })
      })
    }
    // ⑥ B5 校对会话 id：改完**不用重启**（下一次点「校对」就用新的）；换会话 ⇒ 旧建议作废
    if (els.setProofSession) {
      els.setProofSession.addEventListener('change', function () {
        saveSettings({ proofread: { sessionId: els.setProofSession.value } }).then(function (res) {
          if (!res || !res.ok) { notice('校对会话 id 保存失败', true); return }
          var sid = (res.config && res.config.proofread && res.config.proofread.sessionId) || ''
          state.proofreadSessionId = sid
          els.setProofSession.value = sid // 回填主进程归一后的**生效值**（空 = 内置默认）
          if (window.__wcProofReset) window.__wcProofReset()
          notice(sid ? '校对会话已更新 —— 下次点「校对」用新会话' : '校对会话已清空（回到内置默认）')
        })
      })
    }
  }

  /** 当前文档上下文（没打开文档 ⇒ null）—— 发送与校对两个桥共用同一份判据 */
  function currentDocContext() {
    if (!state.current) return null
    return {
      docName: state.current.name,
      workName: state.current.work,
      relPath: state.current.relPath,
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // ⑪ C11 多端文档同步（**懒拉取 + 永不自动覆盖 + 永不静默删**）
  //
  // 设计：docs/superpowers/plans/2026-09-29-multidevice-doc-sync-design.md
  // 纯逻辑在 sync-core.js（与 node 单测同一份）；网络在 sync-net.js（本段只做编排与 UI）。
  //
  // 🔑 四个刻意的设计点：
  //   1. **不阻塞打开**：`selectDoc` 照旧立刻打开本地副本，比对在**后台**跑。
  //      理由：① 走 Funnel 单次请求实测 1.6–2.9 s，拿它挡住"打开文档"不可接受。
  //   2. **远端未知 ≠ 远端没有**：拉不到清单时只显示"未同步"，**绝不**据此判"远端已删/本地独有"。
  //   3. **覆盖本地前先把本地那份移进回收站**（fail-closed：备份不成 ⇒ 中止覆盖，本地一字不动）。
  //   4. **切文档令牌**（`state.sync.seq`）：慢请求回来时若用户已切走，结论必须丢弃。
  // ⚠️ 未加载 sync-core.js / sync-net.js 时本段整体降级为 no-op（不报错、不影响写作）。
  // ════════════════════════════════════════════════════════════════════════
  var SYNC = window.WCSync || null
  var SYNC_LIST_TTL_MS = 20000 // 清单缓存寿命：打开作品/文档时不至于每次都打服务器

  function syncReady() {
    return !!(SYNC && window.WCSyncNet)
  }

  function syncNotice(text) {
    state.sync.note = text || ''
    if (els.syncState) els.syncState.textContent = state.sync.note
  }

  /** 远端清单（带 TTL 缓存）。🔴 任何失败都回 `known:false` 的索引 —— 调用方按"远端未知"处理 */
  function syncRemoteIndex(force) {
    var now = Date.now()
    if (!force && state.sync.list && now - state.sync.list.at < SYNC_LIST_TTL_MS) {
      return Promise.resolve(state.sync.list.index)
    }
    if (!syncReady()) return Promise.resolve(SYNC ? SYNC.indexList(null) : { known: false, byRel: {}, tomb: {} })
    return window.WCSyncNet.listDrafts().then(function (r) {
      var idx = SYNC.indexList(r && r.ok ? r.data : null)
      state.sync.list = { at: Date.now(), index: idx }
      return idx
    })
  }

  function initSync() {
    if (!syncReady()) {
      // 模块缺失**不能**让写作功能受影响：只在状态栏如实说一句
      syncNotice(SYNC ? '未同步（链路未加载）' : '未同步（同步模块未加载）')
      return Promise.resolve()
    }
    if (!api.syncBaseline) { syncNotice('未同步（接口不可用）'); return Promise.resolve() }
    return api.syncBaseline().then(function (r) {
      state.sync.baseline = SYNC.normalizeBaseline(r && r.baseline)
      syncNotice('')
    })
  }

  /** 把基线**整体**写回主进程（纯函数算出新基线 ⇒ 主进程只做 IO） */
  function saveSyncBaseline(next) {
    state.sync.baseline = SYNC.normalizeBaseline(next)
    if (!api.syncBaselineSet) return Promise.resolve({ ok: false })
    return api.syncBaselineSet(state.sync.baseline).then(function (r) {
      if (!r || !r.ok) notice('同步基线写入失败：' + ((r && r.error) || '未知错误'), true)
      return r || { ok: false }
    })
  }

  function syncHideBanner() {
    state.sync.pending = null
    if (els.syncBanner) els.syncBanner.hidden = true
    remoteViewHide() // 「看远端内容」浮层跟着横幅一起收
  }

  function syncBtn(btn, on) {
    if (btn) btn.hidden = !on
  }

  /**
   * 弹同步横幅。**文案一律先说清"本地不会被自动动"**（设计铁律）。
   * @param {string} relPath 本地相对路径
   * @param {'remote-newer'|'conflict'|'remote-deleted'} kind
   * @param {object} detail `{ tomb, remoteVersion }`（墓碑信息 / 远端版本，供文案用）
   */
  function syncShowBanner(relPath, kind, detail) {
    if (!els.syncBanner) return
    state.sync.pending = { relPath: relPath, kind: kind, detail: detail || {} }
    var d = detail || {}
    if (kind === 'remote-deleted') {
      if (d.tomb) {
        els.syncTitle.textContent = '远端已删除《' + relPath + '》'
        els.syncNote.textContent = '服务器上这份已被删除' +
          (d.tomb.deletedBy ? '（由 ' + d.tomb.deletedBy + '）' : '') +
          '。🔴 本地这份**不会被自动删** —— 保留还是清掉，由你决定。'
      } else {
        els.syncTitle.textContent = '服务器上缺这份《' + relPath + '》'
        els.syncNote.textContent = '上次同步之后，服务器上现在查不到这份，也没在云端回收目录里看到它' +
          '（常见于服务端改了存储位置、或数据被挪动）。🔴 本地这份**不会被自动删**。' +
          '选「重新上传到服务器」可把本地这份重新共享给其它客户端。'
      }
    } else if (kind === 'remote-newer') {
      els.syncTitle.textContent = '《' + relPath + '》远端有更新'
      els.syncNote.textContent = '本地这份相对上次同步没动过，服务器上是更新的版本。' +
        '选「用远端覆盖本地」会先把你本地那份**移入回收站**（可恢复），再写入远端版本。'
    } else {
      els.syncTitle.textContent = '《' + relPath + '》本地与远端都改过'
      els.syncNote.textContent = '**不会自动合并**，也不替你选。' +
        '「用远端覆盖本地」会先把本地那份移入回收站（可恢复）；' +
        '「保留本地」则不动任何一侧，等你下次保存/发送时再决定。'
    }
    var canReupload = kind === 'remote-deleted' && !d.tomb
    syncBtn(els.syncReupload, canReupload)
    syncBtn(els.syncTakeRemote, kind !== 'remote-deleted')
    syncBtn(els.syncKeepLocal, true)
    syncBtn(els.syncTrashLocal, kind === 'remote-deleted')
    // ⑪ D-sync-1（b）：远端**有内容可看**的两种横幅才给「看远端内容」（已删除/缺件没得看）
    syncBtn(els.syncRemoteView, kind === 'remote-newer' || kind === 'conflict')
    els.syncBanner.hidden = false
  }

  /** 打开文档**之后**的后台比对（不阻塞） */
  function syncAfterOpen(relPath, localContent) {
    if (!syncReady()) return
    var token = ++state.sync.seq
    syncNotice('比对中…')
    syncRemoteIndex(false).then(function (idx) {
      if (token !== state.sync.seq) return // 用户已切走 ⇒ 丢弃这次结论
      var hit = idx.byRel[relPath] || null
      var tomb = idx.tomb[relPath] || null
      var r = SYNC.decide({
        localExists: true,
        localContent: localContent,
        remoteKnown: idx.known === true,
        remoteExists: !!hit,
        remoteVersion: hit ? hit.version : '',
        remoteBytes: hit ? hit.bytes : 0,
        tombstone: tomb,
        baselineVersion: SYNC.baselineVersionOf(state.sync.baseline, relPath),
      })
      state.sync.last = { relPath: relPath, action: r.action, at: Date.now() }
      syncNotice(SYNC.actionText(r.action))
      if (!idx.known) return // 远端未知：只显示状态，**不做任何判断**
      if (r.action === 'in-sync') {
        // 记下共同祖先 —— 下次才能区分"谁动过"（没有它就只能一律判冲突）
        return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, relPath, r.remoteVersion, Date.now()))
      }
      if (r.action === 'local-only') {
        // 正文缺、回收也无件 ⇒ 不是删除信号，**静默自动补传**（不打扰编辑）
        syncNotice('服务器上缺这份 —— 正在自动补传…')
        syncPushSoon(relPath, localContent, 'manual')
        return
      }
      if (r.action === 'remote-newer') return syncShowBanner(relPath, 'remote-newer', { remoteVersion: r.remoteVersion })
      if (r.action === 'conflict') return syncShowBanner(relPath, 'conflict', { remoteVersion: r.remoteVersion })
      if (r.action === 'remote-deleted') return syncShowBanner(relPath, 'remote-deleted', { tomb: tomb })
    }).catch(function () { syncNotice('未同步（比对失败）') })
  }

  // ── 保存即推（上行）：2026-09-29 用户报「本地保存的时候不推线上，导致客户端之间不能同步」──
  //
  // 原先推送只挂在「发送给任务中心」那条路上（`send-net.js`），而 `flush()`（自动保存/Ctrl+S/切文档）
  // **只写本地**。这里补上上行：每次**本地落盘成功**后，按 `sync-core.decidePush` 的判据决定推不推。
  //
  // 🔴 三条不丢稿/不打爆服务器的约束：
  //   ① **去抖 + 最小间隔**：自动保存可能几秒一次，绝不能每次都发请求；
  //   ② **保证最终一定推**：被最小间隔挡下时会再排一次补推 —— 否则最后一段改动可能永远上不去；
  //   ③ **409 绝不自动 force**：远端版本变了就停下、交用户（复用既有的冲突横幅）。
  var SYNC_PUSH_DEBOUNCE_MS = 3000    // 自动保存去抖
  var SYNC_PUSH_MIN_INTERVAL_MS = 15000 // 两次成功推送的最小间隔

  /** 正文的 UTF-8 字节数（与服务端 `checkSize` 同口径：按字节，不按字符） */
  function utf8Bytes(s) {
    var t = String(s === undefined || s === null ? '' : s)
    try { return new TextEncoder().encode(t).length } catch (e) { return t.length }
  }

  /**
   * 请求"稍后把这一份推上线"。自动保存会反复调用它 ⇒ 只保留最后一份。
   * @param {string} rel 本地相对路径
   * @param {string} text 刚写盘的正文
   * @param {'auto'|'manual'} kind 手动保存（Ctrl+S）不等去抖
   */
  function syncPushSoon(rel, text, kind) {
    if (!syncReady() || !rel) return
    state.sync.pushWanted = { rel: rel, text: text }
    if (kind === 'manual') { syncPushNow(); return }
    if (state.sync.pushTimer) clearTimeout(state.sync.pushTimer)
    state.sync.pushTimer = setTimeout(function () {
      state.sync.pushTimer = null
      syncPushNow()
    }, SYNC_PUSH_DEBOUNCE_MS)
  }

  /** 立刻推（若距上次成功推送不足最小间隔 ⇒ 排一个补推定时，**不丢**） */
  function syncPushNow() {
    var want = state.sync.pushWanted
    if (!want || !syncReady()) return Promise.resolve(null)
    var gap = Date.now() - (state.sync.lastPushAt || 0)
    if (gap < SYNC_PUSH_MIN_INTERVAL_MS) {
      if (state.sync.pushTimer) clearTimeout(state.sync.pushTimer)
      state.sync.pushTimer = setTimeout(function () {
        state.sync.pushTimer = null
        syncPushNow()
      }, SYNC_PUSH_MIN_INTERVAL_MS - gap + 50)
      return Promise.resolve(null)
    }
    state.sync.pushWanted = null
    return syncPush(want.rel, want.text)
  }

  /** 真正推一次（判据在决定，这里只编排 + 上报） */
  function syncPush(rel, text) {
    var seq = state.sync.seq // D-sync-1：重新上传成功后这个号会变 ⇒ 过期结论不许再**弹横幅**（推送本身照常）
    var localVersion = SYNC.versionOf(text)
    var base = SYNC.baselineVersionOf(state.sync.baseline, rel)
    return syncRemoteIndex(false).then(function (idx) {
      var hit = idx.byRel[rel] || null
      var d = SYNC.decidePush({
        localVersion: localVersion,
        localBytes: utf8Bytes(text),
        baselineVersion: base,
        remoteKnown: idx.known === true,
        remoteExists: !!hit,
        remoteVersion: hit ? hit.version : '',
        remotelyDeleted: !!(idx.tomb[rel] || null),
      })
      syncNotice(SYNC.pushText(d.action))
      state.sync.last = { relPath: rel, action: d.action, at: Date.now(), dir: 'push' }
      if (d.action !== 'push') {
        // 远端动过 / 远端已删 / 无从比较 ⇒ **不推**，把决定权交回用户（复用打开时那套横幅）
        if (seq !== state.sync.seq) return null // 🔴 D-sync-1：结论已过期（刚完成过重新上传等）⇒ 不弹横幅
        if (d.action === 'remote-newer') syncShowBanner(rel, 'remote-newer', { remoteVersion: hit ? hit.version : '' })
        else if (d.action === 'remote-deleted') syncShowBanner(rel, 'remote-deleted', { tomb: idx.tomb[rel] || null })
        else if (d.action === 'conflict') syncShowBanner(rel, 'conflict', { remoteVersion: hit ? hit.version : '' })
        return null
      }
      return window.WCSyncNet.saveDraft(rel, text, d.baseVersion ? { baseVersion: d.baseVersion } : null).then(function (r) {
        if (r && r.ok) {
          state.sync.lastPushAt = Date.now()
          state.sync.list = null // 远端内容变了 ⇒ 清单缓存作废
          syncNotice('已同步')
          notice('已同步到服务器：' + rel)
          return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, rel, r.version, Date.now()))
        }
        if (r && r.conflict) {
          // 🔴 409：**绝不自动 force 覆盖** —— 只能交用户
          state.sync.list = null
          syncNotice('推送被拒（远端版本已变）—— 等你决定')
          syncShowBanner(rel, 'conflict', { remoteVersion: '' })
          return null
        }
        // 离线/超时/413…：改动留在本地，**不阻塞保存**、不弹错误框（状态栏说清就行）
        syncNotice('未同步（' + ((r && r.error) || '推送失败') + '）—— 改动留在本地')
        return null
      })
    }).catch(function (e) {
      syncNotice('未同步（' + ((e && e.message) || String(e)) + '）—— 改动留在本地')
      return null
    })
  }

  /** 重新从磁盘装载某篇（覆盖后刷新编辑器用；`selectDoc` 同路径会提前 return，故单独走一个） */
  function syncReloadDoc(relPath) {
    return api.readDoc(relPath).then(function (res) {
      if (!res || !res.ok) return
      var parts = relPath.split('/')
      state.current = { relPath: relPath, work: parts[0], name: parts[parts.length - 1], baseText: res.content }
      state.dirty = false
      state.saveState = 'saved'
      state.lastSavedAt = res.mtime || Date.now()
      Editor.setValue(res.content)
      proofReset()
      renderSidebar()
      renderSaveState()
      renderStatusBar()
    })
  }

  /**
   * 「重新上传到服务器」：服务器缺这份、又没有删除墓碑时，把本地内容以 force 强覆盖写回，
   * 成功后更新基线、作废清单缓存。本地内容只读不改。
   *
   * 🔴 D-sync-1 修复（2026-10-12 真机首报，2026-10-13 修）：旧版在这里 `api.readDoc(rel)` 读
   *    **正式盘快照**强推 —— 编辑器里还没落盘的新输入（自动保存去抖未触发 / 保存中又在输入）
   *    会被旧稿盖掉 ⇒ **云端变成更旧的版本**。修复后，横幅针对的正是当前打开的文档时：
   *    ① 先 `flush(force)` 把编辑器内容落盘；② 推 **编辑器当前稿**（flush 期间又有输入 ⇒
   *    那份才是最新的）；③ 推送期间编辑器又变了 ⇒ 补一次 flush 让盘追上。
   *    横幅针对的不是当前文档（开着横幅又切了篇）⇒ 该篇没有编辑缓冲，读盘即最新，走旧路径。
   */
  function syncReupload() {
    var p = state.sync.pending
    if (!p || !p.relPath || !syncReady()) return
    var rel = p.relPath
    if (p.kind === 'remote-deleted' && p.detail && p.detail.tomb) return
    syncNotice('重新上传中…')
    var isCurrent = !!(state.current && state.current.relPath === rel)
    var step = isCurrent ? flush({ force: true, reason: 'reupload' }) : Promise.resolve({ ok: true })
    Promise.resolve(step).then(function (fl) {
      if (isCurrent && fl && fl.ok === false) {
        notice('上传已中止：本地这份保存失败（' + (fl.error || '未知错误') + '）—— 未推送', true)
        return null
      }
      var read = isCurrent
        ? Promise.resolve({ ok: true, content: Editor.getText() })
        : api.readDoc(rel)
      return read.then(function (rd) {
        if (!rd || !rd.ok) {
          notice('上传已中止：读不到本地这份（' + ((rd && rd.error) || '未知错误') + '）', true)
          return null
        }
        return window.WCSyncNet.saveDraft(rel, rd.content, { force: true }).then(function (r) {
          if (r && r.ok) {
            state.sync.lastPushAt = Date.now()
            state.sync.list = null
            state.sync.seq++ // 让重传期间并发的比对/推送结论**过期**（见 syncPush 的闸）
            syncHideBanner()
            syncNotice('已重新上传：' + rel)
            notice('已重新上传到服务器：' + rel)
            // 推送期间编辑器又有新输入 ⇒ 补一次落盘（盘追上编辑器；下一拍自动保存也会兜）
            if (isCurrent && Editor.getText() !== rd.content) flush({ reason: 'reupload-after' })
            return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, rel, r.version, Date.now()))
          }
          if (r && r.conflict) {
            syncNotice('上传被拒（远端版本冲突）—— 请改用其它处理')
            notice('服务器仍报版本冲突，未覆盖（' + ((r && r.error) || '409') + '）', true)
            return null
          }
          syncNotice('未上传（' + ((r && r.error) || '失败') + '）—— 本地内容未动')
          notice('重新上传失败：' + ((r && r.error) || '未知错误') + '（本地内容未动）', true)
          return null
        })
      })
    }).catch(function (e) {
      notice('重新上传失败：' + ((e && e.message) || String(e)) + '（本地内容未动）', true)
    })
  }

  /** 「看远端内容」浮层的收起（横幅收起 / 切文档时一起走） */
  function remoteViewHide() { if (els.remoteView) els.remoteView.hidden = true }

  /**
   * ⑪ D-sync-1（b）：「看远端内容」—— **只读**浮层显示远端正文。
   * 弹覆盖横幅时用户无从判断远端新旧（之前只能盲选）⇒ 先看清再决定；本函数不碰本地一字。
   */
  function syncRemoteView() {
    var p = state.sync.pending
    if (!p || !p.relPath || !syncReady()) return
    var rel = p.relPath
    if (els.remoteViewTitle) els.remoteViewTitle.textContent = '远端内容：' + rel + '（读取中…）'
    if (els.remoteViewBody) els.remoteViewBody.textContent = ''
    if (els.remoteView) els.remoteView.hidden = false
    window.WCSyncNet.readDraft(rel).then(function (r) {
      if (!r || !r.ok) {
        if (els.remoteViewTitle) els.remoteViewTitle.textContent = '远端内容：' + rel
        if (els.remoteViewBody) els.remoteViewBody.textContent = '（读取失败：' + ((r && r.error) || '未知错误') + '）'
        return
      }
      if (els.remoteViewTitle) {
        els.remoteViewTitle.textContent = '远端内容：' + rel + (r.version ? '（版本 ' + r.version + '）' : '')
      }
      if (els.remoteViewBody) els.remoteViewBody.textContent = r.content || '（远端是空文档）'
    })
  }

  /**
   * 「用远端覆盖本地」：**先移本地那份进回收站 → 拉远端 → 写本地 → 记基线**。
   * 🔴 fail-closed：第一步失败就中止，本地一字不动（绝不用"覆盖失败"换"本地内容已丢"）。
   */
  function syncTakeRemote() {
    var p = state.sync.pending
    if (!p || !p.relPath || !syncReady()) return
    var rel = p.relPath
    var parts = rel.split('/')
    var work = parts.length > 1 ? parts[0] : ''
    var name = parts[parts.length - 1]
    syncHideBanner()
    api.trashDoc(work, name).then(function (tr) {
      if (!tr || !tr.ok) {
        notice('覆盖已中止：无法把本地这份移入回收站（' + ((tr && tr.error) || '未知错误') + '）—— 本地内容未动', true)
        return null
      }
      notice('本地那份已移入回收站，可恢复：' + tr.relPath)
      return window.WCSyncNet.readDraft(rel)
    }).then(function (r) {
      if (!r) return null
      if (!r.ok) {
        notice('拉取远端失败：' + (r.error || '未知错误') + '（本地那份在回收站里，可恢复）', true)
        return null
      }
      return api.writeDoc(rel, r.content).then(function (w) {
        if (!w || !w.ok) { notice('写入本地失败：' + ((w && w.error) || '未知错误'), true); return null }
        return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, rel, r.version, Date.now()))
          .then(function () { return syncReloadDoc(rel) })
          .then(function () {
            state.sync.list = null // 远端已变 ⇒ 缓存作废
            syncNotice('已用远端版本覆盖本地（旧内容在回收站）')
            notice('已用远端版本覆盖本地（旧内容在回收站）')
          })
      })
    }).catch(function (e) {
      notice('覆盖失败：' + ((e && e.message) || String(e)) + '（本地那份在回收站里，可恢复）', true)
    })
  }

  /** 「保留本地」：什么都不做 —— 只关横幅，并把状态说清（改动会在下次保存/发送时走三选） */
  function syncKeepLocal() {
    var p = state.sync.pending
    syncHideBanner()
    syncNotice('保留本地（远端那份没动）')
    notice(p ? '已保留本地版本；远端那份保持不变（下次保存/发送时再处理冲突）' : '已保留本地版本')
  }

  /** 「把本地这份移入回收站」（只在"远端已删除"时出现）—— 复用既有的软删路径 */
  function syncTrashLocal() {
    var p = state.sync.pending
    if (!p || !p.relPath) return
    var parts = p.relPath.split('/')
    var work = parts.length > 1 ? parts[0] : ''
    var name = parts[parts.length - 1]
    syncHideBanner()
    doTrashDoc(work, { name: name, relPath: p.relPath })
    saveSyncBaseline(SYNC.dropBaseline(state.sync.baseline, p.relPath))
    syncNotice('已把本地这份移入回收站')
  }

  // ── 「仅云端」条目：把远端有、本地没有的作品/文档并进侧栏（**点它才拉**）────────
  //
  // 🔴 四条口径：
  //   1. **`known=false` 时一律不显示** —— 拉不到清单 ≠ 没有，瞎猜会让侧栏"忽有忽无"；
  //   2. **只显示"作品/文档"两层**（跳过工作区根下的散件）—— 根下的 `番茄钟记录.md` / `发送记录.md`
  //      是客户端自己的基础设施文件，**不该被当成稿子同步到别的机器**；
  //   3. **点之前本地不动**（懒拉取）：只在用户真点那一条时才 `clientZoneRead` + 落盘；
  //   4. **落盘前再判一次"本地是否已存在"** —— 侧栏是缓存，可能已被别的窗口/进程建出来了 ⇒ 已存在就**不覆盖**。

  /** 远端清单索引（没拉到 ⇒ `known:false`） */
  function syncIndex() {
    return (state.sync.list && state.sync.list.index) || { known: false, byRel: {}, tomb: {} }
  }

  /**
   * 某作品下「云端在正文区里的全部章节」（不排除本地也有的）。
   * 软删整个作品时用：本地整目录删掉的同时，把这些云端件逐个归档进云端 `回收/`。
   * `known:false` ⇒ 恒 `[]`（按云端未知处理，不据此判缺件）。
   */
  function cloudDocsOfWork(ix, workName) {
    if (!ix || !ix.known || !workName) return []
    var prefix = workName + '/'
    var out = []
    Object.keys(ix.byRel).forEach(function (localRel) {
      if (localRel.indexOf(prefix) !== 0) return
      var hit = ix.byRel[localRel]
      out.push({ name: localRel.slice(prefix.length), relPath: localRel, version: hit && hit.version })
    })
    return out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh') })
  }

  /** 某作品下「仅远端有」的文档（本地没有的）。`known:false` ⇒ 恒 `[]` */
  function remoteOnlyDocs(workName) {
    var ix = syncIndex()
    if (!ix.known || !workName) return []
    var prefix = workName + '/'
    var local = {}
    ;(state.works || []).forEach(function (w) {
      if (w.name !== workName) return
      ;(w.docs || []).forEach(function (d) { local[d.relPath] = 1 })
    })
    var out = []
    Object.keys(ix.byRel).forEach(function (localRel) {
      if (localRel.indexOf(prefix) !== 0) return
      if (local[localRel]) return
      var hit = ix.byRel[localRel]
      out.push({ name: localRel.slice(prefix.length), relPath: localRel, remote: true, bytes: hit.bytes, version: hit.version })
    })
    return out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh') })
  }

  /** 「仅远端有」的作品名（本地工作区里没有这个目录）。🔴 只认 `作品/文档.md` 两层 */
  function remoteOnlyWorks() {
    var ix = syncIndex()
    if (!ix.known) return []
    var local = {}
    ;(state.works || []).forEach(function (w) { local[w.name] = 1 })
    var seen = {}
    Object.keys(ix.byRel).forEach(function (localRel) {
      var i = localRel.indexOf('/')
      if (i <= 0) return // 根下散件：不同步（见上面口径 2）
      var work = localRel.slice(0, i)
      if (!local[work]) seen[work] = 1
    })
    return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, 'zh') })
  }

  /** 侧栏一行「仅云端」文档（点它 ⇒ 拉取并打开） */
  function remoteDocEntry(d) {
    var row = el('div', 'w-doc w-doc-remote')
    row.title = d.relPath + '\n服务器上有、本地没有 —— 点它会先拉到本地再打开'
    row.appendChild(el('span', 'w-doc-name', d.name))
    row.appendChild(el('span', 'w-note', '↓ 云端'))
    row.addEventListener('click', function (e) {
      e.stopPropagation()
      pullAndOpen(d.relPath)
    })
    return row
  }

  /** 点「仅云端」条目 ⇒ 拉到本地并打开。**已存在则不覆盖**（侧栏是缓存，可能已过期） */
  function pullAndOpen(relPath) {
    if (!relPath || !syncReady()) return
    notice('正在从服务器拉取《' + relPath + '》…')
    window.WCSyncNet.readDraft(relPath).then(function (r) {
      if (!r || !r.ok) {
        notice('拉取失败：' + ((r && r.error) || '未知错误'), true)
        return null
      }
      return api.readDoc(relPath).then(function (ex) {
        if (ex && ex.ok) {
          notice('本地已有同名文档，**未覆盖** —— 请在侧栏里直接打开它，或改名后再拉', true)
          return null
        }
        return api.writeDoc(relPath, r.content).then(function (wr) {
          if (!wr || !wr.ok) { notice('写入本地失败：' + ((wr && wr.error) || '未知错误'), true); return null }
          return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, relPath, r.version, Date.now()))
        }).then(function () {
          state.sync.list = null // 本地多了一篇 ⇒ 远端清单缓存作废，重拉
          return refreshTree()
        }).then(function () {
          return selectDoc({ relPath: relPath })
        }).then(function () {
          notice('已从服务器拉取《' + relPath + '》')
        })
      })
    }).catch(function (e) {
      notice('拉取失败：' + ((e && e.message) || String(e)), true)
    })
  }

  /**
   * 侧栏渲染时顺带把远端清单拉一次（**懒拉取**：设计 §5.1 的"打开作品拉清单"）。
   * 🔴 只在**清单签名变了**时才重画 ⇒ 否则 `renderSidebar → 拉 → 重画` 会自己转圈。
   */
  function syncEnsureListForSidebar() {
    if (!syncReady() || state.sync.listPending) return
    state.sync.listPending = true
    syncRemoteIndex(false).then(function (idx) {
      state.sync.listPending = false
      if (!idx || !idx.known) return
      var sig = Object.keys(idx.byRel).sort().join('|')
      if (sig === state.sync.sig) return
      state.sync.sig = sig
      renderSidebar()
    }).catch(function () { state.sync.listPending = false })
  }

  function wireSync() {
    if (els.syncClose) els.syncClose.addEventListener('click', syncHideBanner)
    if (els.syncReupload) els.syncReupload.addEventListener('click', syncReupload)
    if (els.syncTakeRemote) els.syncTakeRemote.addEventListener('click', syncTakeRemote)
    if (els.syncKeepLocal) els.syncKeepLocal.addEventListener('click', syncKeepLocal)
    if (els.syncTrashLocal) els.syncTrashLocal.addEventListener('click', syncTrashLocal)
    if (els.syncRemoteView) els.syncRemoteView.addEventListener('click', syncRemoteView)
    if (els.remoteViewClose) els.remoteViewClose.addEventListener('click', remoteViewHide)
  }

  // 给 sync-net.js 的窄桥（与 __wcSendBridge / __wcProofBridge 同口径）
  window.__wcSyncBridge = {
    notice: function (text, isError) { notice(text, isError) },
    /** 排障/自测用：当前同步态（不参与业务判断） */
    state: function () {
      return {
        ready: syncReady(),
        note: state.sync.note,
        last: state.sync.last,
        pending: state.sync.pending,
        remoteKnown: !!(state.sync.list && state.sync.list.index && state.sync.list.index.known),
        baselineKeys: state.sync.baseline ? Object.keys(state.sync.baseline.items || {}) : [],
        // ⑪ C11 补：上行（保存即推）的现场
        pushPending: !!state.sync.pushWanted,
        pushTimerArmed: !!state.sync.pushTimer,
        lastPushAt: state.sync.lastPushAt || 0,
      }
    },
  }

  // ════════════════════════════════════════════════════════════════════════
  // 阶段⑤「发送给任务中心」：给 send-net.js 的**窄桥**
  // 只暴露发送链路真正需要的东西（当前文档上下文 / 编辑器文本与选区 / 发送前 flush / 状态提示），
  // 让发送实现完全住在 send-net.js 里（**不加载它时这段没人调用，既有行为一字不变**；
  // 删掉本段 + send-net.js + shell.html 里两处引用 = 回到加本阶段之前）。
  // ════════════════════════════════════════════════════════════════════════
  window.__wcSendBridge = {
    /** 当前文档上下文（没打开文档 ⇒ null） */
    context: currentDocContext,
    /**
     * 诉求（意图）预设 —— **用户 2026-09-28 要求可自定义**（他一直在手填「成果」）。
     * 数据源 = 设置里的 `send.intents`（落 `userData/config.json`；设置弹层「发送」组可改）。
     * 空列表也照样返回（发送弹窗至少还剩「其他…」）。
     */
    intents: function () {
      var s = (state.settings && state.settings.send) || {}
      return Array.isArray(s.intents) ? s.intents : []
    },
    /**
     * 把整份诉求预设**写盘**（发送弹窗的「＋ 存为常用」走它）。
     * 复用既有 `saveSettings` ⇒ 成功后 `state.settings` 被回填成**主进程归一化后的权威值**；
     * 返回同一个 Promise，调用方 `.then` 之后重画下拉即可拿到新列表（**不静默**：失败时 saveSettings 自己会提示）。
     */
    saveIntents: function (list) {
      return saveSettings({ send: { intents: list } })
    },
    /** 编辑器全文 */
    text: function () { return Editor.getText() },
    /**
     * 编辑器里的选区文本（无选区 / 选区不在写作区内 ⇒ ''）。
     * 🔴 B4 改动点：写作区从 `<textarea>` 换成 contentEditable 后，**没有** `selectionStart/End/value`
     *   ⇒ 改用 `window.getSelection()`；并要求选区**两端都落在写作区内**，否则视为无选区
     *   （例如用户选中的是左栏文字，不该被当成"写作区选中段"发出去）。
     */
    selection: function () {
      var box = Editor.el
      if (!box) return ''
      var sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return ''
      var r = sel.getRangeAt(0)
      if (!box.contains(r.startContainer) || !box.contains(r.endContainer)) return ''
      return String(sel.toString() || '')
    },
    /** 发送前把关：先把本地未保存内容落到工作区（返回 {ok,error?}，调用方失败即中止发送） */
    flush: function () { return flush({ reason: 'send' }) },
    /** 状态条提示（成功/失败文案都走既有 notice ⇒ 沿用现有状态条机制） */
    notice: function (text, isError) { notice(text, isError) },
  }

  // ════════════════════════════════════════════════════════════════════════
  // ⑥ B5「AI 校对」：给 proofread-net.js 的**窄桥**（取向同 `send` 那段）
  //
  // 只暴露校对真正需要的：当前文档上下文 / 编辑器文本（读写）与 flush / 状态提示 /
  // 「有没有归属」（D-6 的规则：没文档就不让写，也就不该让改）/ 校对会话 id（读写配置）。
  // ⇒ 校对实现完全住在 proofread-net.js 里；**不加载它时这段没人调用，既有行为一字不变**。
  // 🔴 `setText` 是整条 B5 里**唯一**能改正文的入口 —— 只由「应用」按钮的点击回调调用。
  // ════════════════════════════════════════════════════════════════════════

  /** 换文档 / 换工作区 / 文档被删 ⇒ 让校对面板作废（面板自己实现；没加载时是空操作） */
  function proofReset() { if (window.__wcProofReset) window.__wcProofReset() }

  window.__wcProofBridge = {
    context: currentDocContext,
    /** 编辑器全文（判据与发送同一份：`Plain.domToText`） */
    text: function () { return Editor.getText() },
    /** 🔴 写回正文（**只给「应用」用**）；调用方必须先经 `Proof.applySuggestion` 校验 */
    setText: function (t) { Editor.setValue(t == null ? '' : String(t)) },
    /** 编辑器根节点（高亮要按它遍历文本节点建 Range） */
    editorEl: function () { return Editor.el },
    /** 应用改动后立刻落盘（失败 ⇒ 如实回报，交给调用方提示） */
    flush: function () { return flush({ reason: 'proofread-apply' }) },
    notice: function (text, isError) { notice(text, isError) },
    /** 「有没有归属」= D-6 的硬闸门：没打开文档 ⇒ 既不能写，也不该让校对去改 */
    editable: function () { return !!state.current },
    /** 校对专用会话 id（空 = 还没建；建好后由 setSessionId 落配置复用） */
    sessionId: function () { return state.proofreadSessionId || '' },
    setSessionId: function (id) {
      state.proofreadSessionId = String(id == null ? '' : id)
      if (api.saveConfig) api.saveConfig({ proofread: { sessionId: state.proofreadSessionId } })
    },
    /** ⑥ B5：把某篇文档的校对结果读回来（没有 ⇒ report:null；落 userData/proofread/，不进工作区） */
    loadReport: function (relPath) { return api.proofLoad(relPath) },
    /** ⑥ B5：存下某篇文档的校对结果（成功拿到报告 / 应用一条 / 忽略一条之后都会调） */
    saveReport: function (relPath, payload) {
      var p = payload && typeof payload === 'object' ? payload : {}
      p.relPath = relPath
      return api.proofSave(p)
    },
  }

  // ════════════════════════════════════════════════════════════════════════
  // 事件接线
  // ════════════════════════════════════════════════════════════════════════
  function wire() {
    wireSettings() // ⑤ 「设置」弹层（壳层级）
    Editor.onChange(function () {
      state.dirty = true
      if (state.saveState !== 'saving') { state.saveState = 'dirty'; renderSaveState() }
      renderStatusBar()
      scheduleAutosave()
      if (findIsOpen()) findRefresh(false) // ③ 查找条开着 ⇒ 重算命中与计数（不动选区、不抢焦点）
    })

    if (els.saveBtn) els.saveBtn.addEventListener('click', function () { flush({ force: true, reason: 'manual' }) })
    // ③ 缩进/取消缩进的实体按钮（iPad 虚拟键盘没有 Tab；与键盘路径同走 Editor 钩子，undo 行为一致）
    if (els.indentBtn) els.indentBtn.addEventListener('click', function () { Editor.focus(); Editor.insertText('　　') })
    if (els.dedentBtn) els.dedentBtn.addEventListener('click', function () { Editor.focus(); Editor.dedent() })
    if (els.pickRoot) els.pickRoot.addEventListener('click', function () { pickRoot() })
    if (els.newWork) els.newWork.addEventListener('click', newWork)
    if (els.newDoc) els.newDoc.addEventListener('click', newDoc)
    // 🔴 D-6：空态里的「新建一篇（自动命名）」
    if (els.editorNewDoc) els.editorNewDoc.addEventListener('click', quickNewDoc)
    // ⑥ CR-6 分栏：开关 + 两个浮层入口 + 分割条拖拽 + 点外/Esc 收浮层
    if (els.split) els.split.addEventListener('click', function () { setSplit(!state.split.on) })
    if (els.splitDocs) els.splitDocs.addEventListener('click', function () { toggleSplitPanel('docs') })
    if (els.splitBoard) els.splitBoard.addEventListener('click', function () { toggleSplitPanel('board') })
    wireSplitHandle()
    document.addEventListener('pointerdown', function (e) {
      if (!state.split.on || (!state.split.docs && !state.split.board)) return
      var t = e.target
      // 点在浮层内部、或点在那两个入口按钮上，都不算"点外面"（按钮自己要负责开合）
      if (els.sidebar && els.sidebar.contains(t)) return
      if (els.right && els.right.contains(t)) return
      if (els.splitDocs && els.splitDocs.contains(t)) return
      if (els.splitBoard && els.splitBoard.contains(t)) return
      // 分割条也不算：拖比例是"调布局"，不该顺手把开着的浮层关掉（它就在浮层旁边）
      var handle = document.getElementById('w-split-handle')
      if (handle && handle.contains(t)) return
      closeSplitPanels()
    })
    // ⚠️ 只收浮层，**不动分栏本身**（Esc 不该把并排也关掉）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSplitPanels()
    })
    if (els.refresh) els.refresh.addEventListener('click', function () { refreshTree() })

    // ①-b 新建工作区（自动选父目录 / 自己选父目录）
    if (els.createRoot) {
      els.createRoot.addEventListener('click', function () {
        createRoot(null, '新建工作区', els.newRootName ? els.newRootName.value : '')
      })
    }
    if (els.createRootHere) els.createRootHere.addEventListener('click', function () { createRootHere(els.newRootName ? els.newRootName.value : '') })
    if (els.newRootName) {
      els.newRootName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); createRoot(null, '新建工作区', els.newRootName.value) }
      })
    }

    // ①-a 常驻「工作区：<路径> ▾ 切换」
    if (els.wsMenu) {
      els.wsMenu.addEventListener('click', function (e) {
        e.stopPropagation()
        openWsPop(!!els.wsPop && els.wsPop.hidden)
      })
    }
    if (els.wsSwitch) els.wsSwitch.addEventListener('click', function () { switchToExistingRoot() })
    if (els.wsCreate) els.wsCreate.addEventListener('click', function () { createRootFromBar() })
    if (els.wsCreateHere) els.wsCreateHere.addEventListener('click', function () {
      createRootHere((els.wsName && els.wsName.value.trim()) || '')
    })
    if (els.wsName) {
      els.wsName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); createRootFromBar() }
      })
    }
    // 点空白 / Esc 收起「▾ 切换」菜单
    document.addEventListener('click', function (e) {
      if (!els.wsPop || els.wsPop.hidden) return
      if (els.wsBar && els.wsBar.contains(e.target)) return
      closeWsPop()
    })

    // ③-b 可操作提示里的**直达按钮**
    if (els.hintCreate) els.hintCreate.addEventListener('click', function () { createRootFromHint() })
    if (els.hintClose) {
      els.hintClose.addEventListener('click', function () {
        state.hint = ''
        renderSidebar()
      })
    }

    // ②-b 导入
    if (els.importWorks) els.importWorks.addEventListener('click', function () { importOpen('works') })
    if (els.importTree) els.importTree.addEventListener('click', function () { importOpen('tree') })
    if (els.importClose) els.importClose.addEventListener('click', importClose)
    if (els.importFilesBtn) els.importFilesBtn.addEventListener('click', importPickFiles)
    if (els.importDirBtn) els.importDirBtn.addEventListener('click', importPickDir)
    if (els.importBox) {
      els.importBox.addEventListener('click', function (e) {
        if (e.target === els.importBox) importClose() // 点遮罩关闭
      })
    }

    // ④ 启动横幅（非阻塞·可关闭）的三个动作
    if (els.bannerRetry) els.bannerRetry.addEventListener('click', bannerRetry)
    if (els.bannerOpen) els.bannerOpen.addEventListener('click', bannerOpenDraft)
    if (els.bannerDismiss) els.bannerDismiss.addEventListener('click', dismissBanner)
    if (els.bannerClose) els.bannerClose.addEventListener('click', dismissBanner)

    // ③ 作品墙 / 文档树
    if (els.backWorks) els.backWorks.addEventListener('click', backToWorks)
    // ③-b 回收站（B3）：入口在常驻工作区栏上；「← 返回」回上次那一层（作品内 / 卡片墙）
    if (els.trashOpen) {
      els.trashOpen.addEventListener('click', function () {
        if (state.view === 'trash') { state.view = state.currentWork ? 'tree' : 'works'; renderSidebar() }
        else openTrash()
      })
    }
    if (els.trashBack) {
      els.trashBack.addEventListener('click', function () {
        state.view = state.currentWork ? 'tree' : 'works'
        renderSidebar()
      })
    }
    if (els.worksSearch) {
      els.worksSearch.addEventListener('input', function () {
        state.worksQuery = els.worksSearch.value
        renderWorks()
      })
    }
    if (els.docSearch) {
      els.docSearch.addEventListener('input', function () {
        state.docQuery = els.docSearch.value
        renderTree()
      })
    }

    if (els.pomoToggle) els.pomoToggle.addEventListener('click', pomoToggle)
    if (els.pomoReset) els.pomoReset.addEventListener('click', pomoReset)
    if (els.focusMin) els.focusMin.addEventListener('change', onPomodoroConfigChange)
    if (els.breakMin) els.breakMin.addEventListener('change', onPomodoroConfigChange)

    // Ctrl/Cmd+S = 手动保存；Ctrl/Cmd+F = 查找条；Esc = 收查找条/设置弹层/「▾ 切换」菜单/导入模态
    window.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault()
        flush({ force: true, reason: 'manual' })
        return
      }
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'f') {
        e.preventDefault()
        findOpen() // ③ 查找/替换（写作页主导键；浏览器默认查找对长文写作不够用）
        return
      }
      if (e.key === 'Escape') {
        // ③ 查找条优先收（它浮在写作区上，最近的"弹层"）
        if (findIsOpen()) { findClose(); return }
        // ⑤ 设置弹层在最上层 ⇒ 先关它
        if (settingsIsOpen()) { settingsClose(); return }
        if (els.importBox && !els.importBox.hidden) { importClose(); return }
        closeWsPop()
      }
    })

    // 失焦 / 关窗 / 切页 前强制 flush
    window.addEventListener('blur', function () { flush({ reason: 'blur' }) })
    window.addEventListener('pagehide', function () { flushSync('pagehide') })
    window.addEventListener('beforeunload', function () { flushSync('beforeunload') })

    // 切到 [DSH] 页前 flush（切换本身由 shell.html 的 tab 逻辑负责，这里只补一个"离开前保存"）
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () {
        if (t.getAttribute('data-page') === 'dsh') flush({ reason: 'page-switch' })
      })
    })

    // 主进程的「关窗前 flush」请求：**同步**落盘后回执，主进程收到才真关窗。
    // （beforeunload / pagehide 仍保留 —— 那是"页面卸载"这条路，两者互为兜底。）
    if (api && api.onFlushRequest) {
      api.onFlushRequest(function () {
        var r = flushSync('window-close')
        try {
          if (api.flushDone) api.flushDone(r)
        } catch (e) { /* 忽略 */ }
      })
    }

    // Windows 关机/注销：主进程用 executeJavaScript 调它（时间极短 ⇒ 尽力而为）
    window.__wcFlushOnSessionEnd = function () { flushSync('session-end') }

    // 草稿保险心跳：**仍脏**才写（干净不写，避免留下"假草稿"误导下次启动的恢复提示）
    setInterval(function () {
      if (state.current && state.dirty) writeDraftNow()
    }, DRAFT_MS)

    // 🔴 2026-10-13：去掉 renderAutosaveLabel 的 500ms 心跳。
    //   原来用它递增「N 秒前」的 N，现在 saved 状态用静态文本「✓ 自动保存」不再需要持续刷。
    //   状态变化（dirty→saving→saved）由 renderSaveState 立即刷一次就够了。

    var goalChip = document.getElementById('w-goal-chip')
    goalChip.addEventListener('click', function () {
      var frame = document.getElementById('dsh-frame')
      window.__wcTabs.show('dsh')
      frame.contentWindow.location.hash = '#/stats'
    })
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refreshToday()
    })
    window.addEventListener('online', function () {
      refreshToday().then(drainWritingQueue)
    })
    refreshToday()
  }

  // ════════════════════════════════════════════════════════════════════════
  // 启动横幅「上次有内容没保存成功」（本轮）—— 🔴 **非阻塞**（不是模态）、可关闭
  //
  // 两个数据来源，合并成**一条**横幅：
  //   ① `getLastSession()`（主进程 userData/last-session.json）⇒ 关窗 flush 失败的**原因**（errno / 路径）；
  //   ② `listPendingDrafts()` ⇒ 未落正式盘的**草稿**（内容在哪；强杀 / 断电也靠它兜住）。
  // 🔴 为什么把原来的「启动 `window.confirm` 恢复」并进横幅：
  //   · 本轮硬要求是「**不要阻塞启动**」，而 `confirm` 是**模态**、会挡住启动；
  //   · 两者并存还会"横幅 + 弹窗"同时冒出来（两个弹窗打架）。
  //   ⇒ 横幅负责**告知 + 给动作**，恢复语义**没变**：「重试保存」= 用草稿覆盖写回正式盘，
  //     「知道了」= 先不动、草稿原样保留、下次启动再提示（与原 confirm 的「取消」等价）。
  // ════════════════════════════════════════════════════════════════════════
  function hideBanner() {
    if (els.banner) els.banner.hidden = true
  }

  /** 渲染横幅（failed 与 drafts 按 relPath 合并；没有可提示的就**保持隐藏**） */
  function renderBanner(failed, drafts) {
    bannerState.failed = failed || []
    bannerState.drafts = drafts || []
    if (!els.banner) return
    if (!failed.length && !drafts.length) { hideBanner(); return }

    var byRel = {}
    var order = []
    failed.forEach(function (f) {
      if (!f || !f.relPath) return
      if (!byRel[f.relPath]) { byRel[f.relPath] = { relPath: f.relPath, error: '', draft: null }; order.push(f.relPath) }
      byRel[f.relPath].error = f.error || '未知错误'
    })
    drafts.forEach(function (d) {
      if (!byRel[d.relPath]) { byRel[d.relPath] = { relPath: d.relPath, error: '', draft: null }; order.push(d.relPath) }
      byRel[d.relPath].draft = d
    })

    if (els.bannerTitle) els.bannerTitle.textContent = '⚠️ 上次有 ' + order.length + ' 篇没能保存进工作区'
    if (els.bannerList) {
      els.bannerList.textContent = order.map(function (k) {
        var it = byRel[k]
        var why = it.error ? ('保存失败：' + it.error) : '没写进正式文件'
        var where = it.draft
          ? ('；草稿已保住（' + fmtTime(it.draft.draftMtime) + ' · ' + it.draft.bytes + ' 字节）')
          : '；⚠️ 没找到对应的草稿'
        return '· ' + it.relPath + '\n    ' + why + where
      }).join('\n')
    }
    if (els.bannerNote) {
      var note = ['正式盘（工作区）：' + (state.root || '（未设置）')]
      if (state.draftsDir) note.push('当前内容在草稿里：' + state.draftsDir + '（应用数据目录，不在工作区）')
      if (!drafts.length) note.push('⚠️ 这次没有可恢复的草稿 —— 内容可能已丢失（当时草稿兜底也失败了）。')
      note.push('「重试保存」= 用草稿覆盖写回工作区；「知道了」= 先不动（草稿留着，下次启动还会提示）。')
      els.bannerNote.textContent = note.join('\n')
    }
    if (els.bannerRetry) els.bannerRetry.hidden = !drafts.length
    if (els.bannerOpen) els.bannerOpen.hidden = !drafts.length
    els.banner.hidden = false
  }

  /** 启动时查一次：上次会话有没有保存失败 / 有没有没落正式盘的草稿 ⇒ 决定要不要显示横幅 */
  function checkStartupNotices() {
    if (!api) return
    // 「设置 → 草稿 → 启动时提示」关掉 ⇒ **不在启动时自动弹横幅**。
    // ⚠️ 只是不自动提示：草稿仍照写、失败仍记账（`last-session.json` / `drafts/` 一样落盘）⇒ 不影响数据安全。
    if (state.settings && state.settings.drafts && state.settings.drafts.notifyOnStartup === false) {
      hideBanner()
      return
    }
    var drafts = []
    var chain = Promise.resolve()
    if (state.root && api.listPendingDrafts) {
      chain = chain.then(function () {
        return api.listPendingDrafts().then(
          function (res) { if (res && res.ok && res.drafts) drafts = res.drafts },
          function () { /* 列草稿失败不打扰启动 */ },
        )
      })
    }
    return chain
      .then(function () {
        if (!api.getLastSession) { renderBanner([], drafts); return }
        return api.getLastSession().then(
          function (res) {
            var rec = res && res.ok ? res.record : null
            var failed = rec && Array.isArray(rec.flushFailed) ? rec.flushFailed : []
            renderBanner(failed, drafts)
          },
          function () { renderBanner([], drafts) },
        )
      })
  }

  /** 横幅「重试保存」：把草稿写回正式盘（逐篇；成功才清草稿，失败保留） */
  function bannerRetry() {
    if (!bannerState.drafts.length) { notice('没有可恢复的草稿', true); return }
    restoreDrafts(bannerState.drafts)
  }

  /** 横幅「打开草稿看看」：把**第一篇**草稿载入编辑器（只读出来给人看，不写正式盘） */
  function bannerOpenDraft() {
    var d = bannerState.drafts[0]
    if (!d) { notice('没有可打开的草稿', true); return }
    api.readDraft(d.relPath).then(function (res) {
      if (!res || !res.ok) { notice('读取草稿失败：' + ((res && res.error) || '未知错误'), true); return }
      var parts = d.relPath.split('/')
      state.current = { relPath: d.relPath, work: parts[0], name: parts[parts.length - 1], baseText: res.content }
      // 载进来的正是**未落正式盘**的内容 ⇒ 如实标脏：这样自动保存/关窗 flush/草稿兜底照旧管它
      state.dirty = true
      state.saveState = 'dirty'
      Editor.setValue(res.content)
      renderSidebar()
      renderSaveState()
      renderStatusBar()
      scheduleAutosave()
      notice('已把草稿载入编辑器：' + d.relPath + '（内容来自草稿）')
    })
  }

  /** 横幅「知道了」/「✕」：只关掉这条提示；草稿**不动**（下次启动还会提示） */
  function dismissBanner() {
    hideBanner()
  }

  /** 逐篇把草稿写回正式盘（走 writeDoc，仍过守卫）；成功才清草稿，失败则保留 */
  function restoreDrafts(list) {
    var done = 0
    var fail = 0
    var chain = Promise.resolve()
    list.forEach(function (d) {
      chain = chain.then(function () {
        return api.readDraft(d.relPath).then(
          function (r) {
            if (!r || !r.ok) { fail += 1; return }
            return api.writeDoc(d.relPath, r.content).then(function (w) {
              if (w && w.ok) {
                done += 1
                return api.clearDraft(d.relPath)
              }
              fail += 1
            })
          },
          function () { fail += 1 },
        )
      })
    })
    chain
      .then(function () {
        notice('已从草稿恢复 ' + done + ' 篇' + (fail ? '；失败 ' + fail + ' 篇（草稿保留）' : ''), fail > 0)
        if (fail) return checkStartupNotices() // 还有没恢复的 ⇒ 让横幅显示剩下的
        // 全部恢复成功 ⇒ 内容已落正式盘，横幅收掉（下次退出会重写 last-session，届时不再提示）
        bannerState.failed = []
        bannerState.drafts = []
        hideBanner()
        return null
      })
      .then(function () {
        return refreshTree()
      })
      .then(function () {
        if (done && list.length) selectDoc({ relPath: list[0].relPath })
      })
  }

  // ════════════════════════════════════════════════════════════════════════
  // 初始化
  // ════════════════════════════════════════════════════════════════════════
  function init() {
    if (!api) {
      notice('preload 未注入（window.wcStorage 缺失）—— 本地读写不可用', true)
      if (els.saveBtn) els.saveBtn.disabled = true
      return
    }
    wire()
    wireFind() // ③ 查找/替换条（按钮与输入框事件；条本身默认 hidden）
    // ⑪ C11：同步的按钮接线与基线装载（**与写作主流程解耦**：模块缺失只会让状态栏说一句实话）
    wireSync()
    initSync()

    api.getState().then(function (st) {
      if (st && st.ok) {
        state.root = st.root || null
        if (st.pomodoro) {
          state.pomodoro.focusMin = clampInt(st.pomodoro.focusMin, 1, 180, 25)
          state.pomodoro.breakMin = clampInt(st.pomodoro.breakMin, 1, 60, 5)
          state.pomodoro.autoNext = st.pomodoro.autoNext !== false
        }
        // ⑤ 「设置」：主进程回的是**已 clamp 归一化**的值 ⇒ 直接采信（并立即作用到运行时，见下）
        if (st.settings) state.settings = st.settings
        state.remoteEffective = st.remoteEffective || null
        // ①-b 空态：默认名字 / 建议路径（候选父目录已由主进程避开 OneDrive）
        if (st.defaultName) state.defaultRootName = st.defaultName
        state.suggestedRoot = st.suggestedRoot || ''
        state.draftsDir = st.draftsDir || '' // 草稿落点（横幅里如实告诉用户"内容在哪"）
        if (els.newRootName && !els.newRootName.value) els.newRootName.value = state.defaultRootName
        if (els.wsName && !els.wsName.value) els.wsName.value = state.defaultRootName
        if (els.importNewWork && !els.importNewWork.value) els.importNewWork.value = ''

        // ⑥ CR-6 分栏：开关与比例（从配置回填；非法值当场夹紧，不信任磁盘上的值）
        if (st.ui && st.ui.split && typeof st.ui.split === 'object') {
          state.split.on = st.ui.split.on === true
          state.split.ratio = clampRatio(st.ui.split.ratio)
        }
        // ⑥ B5：校对专用会话 id（主进程已按 `session-…` 形状归一 ⇒ 这里直接采信）
        if (st.proofread && typeof st.proofread.sessionId === 'string') {
          state.proofreadSessionId = st.proofread.sessionId
        }
        if (st.root && st.rootExists === false) {
          notice('配置的工作区目录已不存在：' + st.root, true)
        }
      }
      syncPomodoroInputs() // 工具栏 + 设置弹层两处输入框（同一份配置）
      pomoReset()
      applySettings() // ⑤ 把配置作用到运行时：去抖时长 / 编辑器字号 / 主题（默认值 = 原行为）
      renderSplit() // ⑥ CR-6：分栏开关与比例（启动即恢复上次的状态）
      // 上次是分栏状态 ⇒ 右半屏也回到「AI 对话」（与点开关进分栏时同一口径）。
      // ⚠️ 这一步不会整页重载：只改 iframe 的 hash（控制台是 SPA）。
      if (state.split.on) frameGotoChat()
      renderRootLabel()
      renderWsBar()
      renderSaveState()
      renderStatusBar()
      renderDraftsUsage() // `#37` 之后：启动即把草稿占用摆到状态栏

      // 导入进度（主进程逐文件 send）——只更新模态里的结果区，不打扰其他 UI
      if (api.onImportProgress) {
        api.onImportProgress(function (p) {
          if (!els.importBox || els.importBox.hidden || !state.importBusy) return
          renderImportResult('导入中… ' + p.done + '/' + p.total + (p.name ? '（' + p.name + '）' : ''))
        })
      }

      // ③ 左栏三层：有工作区 ⇒ 先看**作品卡片墙**（§18 ❓1 的默认 = 卡片墙为默认页）
      state.view = state.root ? 'works' : 'empty'
      renderSidebar()

      if (!state.root) {
        // 首次启动：弹出目录选择；用户取消（或选到不可写的目录）就留在空态 ——
        // 空态里既有「选择已有目录…」也有壳层自己的「新建工作区」（不依赖原生对话框的"新建文件夹"）。
        if (!state.pickAttempted) {
          state.pickAttempted = true
          pickRoot()
        }
      } else {
        refreshTree()
      }
      // 启动时给一次「上次有没有没保存成功的东西」的通知 ⇒ **非阻塞**横幅（本轮；
      // 原来是这里的 window.confirm —— 那是模态、会挡住启动，已并进横幅）。
      checkStartupNotices()
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
