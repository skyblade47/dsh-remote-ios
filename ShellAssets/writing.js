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
      // ⑬ 横幅决策前去重：键 syncDismissedKey(rel,kind)，值=决策时该文档的远端版本（'' 表示无版本/删除/硬删）。
      //   用户对「同一篇、同一结论、远端没再变」点过保留本地等处置后，自动保存/重开不得反复弹；远端版本一变就重弹。
      dismissed: {},
      // ⑭ §8 离线待办队列：`{op:'archive'|'restore'|'purge', rel, at}[]`（落 userData/sync/pending-ops.json，主进程只 IO）
      //   pendingDrain —— 重放在跑保护（联网恢复与同步成功可能并发触发，只许一轮在跑）
      pendingOps: [], pendingDrain: false,
      // ⑯ §7 后台自动对齐：alignPending 在跑保护；alignSig 已对齐过的清单签名（清单没变不重扫）
      alignPending: false, alignSig: '',
      // ⑪ C11 补（2026-09-29 用户报「保存不推线上」）：
      //   pushWanted —— 待推的那一份 `{rel, text}`（自动保存会反复覆盖它，只推最后一份）
      //   pushTimer  —— 去抖/补推定时器（**保证最终一定推**，不会因为节流把最后一段改动丢掉）
      //   lastPushAt —— 上次**成功**推送的时刻（算最小间隔用）
      pushWanted: null, pushTimer: null, lastPushAt: 0 },
    // ⑥ CR-6 分栏：on = 写作页与对话页并排；ratio = 写作页占的宽度比例（0.2–0.8）；
    //   docs / board = 左栏 / 右栏浮层**当前是否展开**（只在分栏时有意义，是瞬时 UI 态、不落盘）
    split: { on: false, ratio: 0.5, docs: false, board: false },
    // ⑰ 左右栏独立收起偏好（落盘 ui.collapseLeft/Right；分栏时两栏是浮层，本偏好只管常驻模式）
    ui: { collapseLeft: false, collapseRight: false },
    // 记录板（设计 docs/board-and-noveldb-design.md §1）：notes/todos 按 relPath 分文档；
    //   seq = 切文档令牌（防过期响应回填）；dirty = {relPath:true} 待推远端；
    //   previewCache = 预览清单缓存 {lastRelPath,lastListAt}；各类 timer 挂这里好清理。
    board: {
      activeTab: 'notes',
      activeProofView: 'proof', // proof pane 三态子分段当前态（UI 瞬时态，不落盘）
      notes: {},
      todos: {},
      previewCache: {},
      seq: 0,
      dirty: {},
      noteTimer: null,
      flushTimer: null,
      warnOnce: false,
      listLoading: false,
    },
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
    syncTakeRemote: document.getElementById('w-sync-take-remote'),
    syncKeepLocal: document.getElementById('w-sync-keep-local'),
    syncTrashLocal: document.getElementById('w-sync-trash-local'),
    // ⑤ 并发写入 409：冲突横幅「本地这份另存为…」（只在 conflict 出现）
    syncSaveAs: document.getElementById('w-sync-save-as'),
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
    collapseLeft: document.getElementById('w-collapse-left'),
    collapseRight: document.getElementById('w-collapse-right'),
    identityName: document.getElementById('w-identity-name'),
    identityPath: document.getElementById('w-identity-path'),
    identityDot: document.getElementById('w-identity-dot'),
    sidebar: document.getElementById('w-sidebar'),
    right: document.getElementById('w-right'),
    pomoTime: document.getElementById('w-pomo-time'),
    pomoMode: document.getElementById('w-pomo-mode'),
    pomoToggle: document.getElementById('w-pomo-toggle'),
    pomoReset: document.getElementById('w-pomo-reset'),
    pomoNote: document.getElementById('w-pomo-note'),
    coachOpen: document.getElementById('w-coach-open'),
    viewWrite: document.querySelector('[data-view-seg="write"]'),
    viewPreview: document.querySelector('[data-view-seg="preview"]'),
    sendCaret: document.getElementById('w-send-caret'),
    intentMenu: document.getElementById('w-intent-menu'),
    pomoCaret: document.getElementById('w-pomo-caret'),
    pomoPop: document.getElementById('w-pomo-pop'),
    pomoSettings: document.getElementById('w-pomo-settings'),
    // ⑤ 「设置」弹层（壳层级；DOM 在 body 下，不在 #page-writing 里）
    setBtn: document.getElementById('shell-settings'),
    setBox: document.getElementById('s-modal'),
    setClose: document.getElementById('s-close'),
    setDone: document.getElementById('s-done'),
    setRestore: document.getElementById('s-restore-preset'),
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
    setSendWaitResult: document.getElementById('s-send-wait-result'), // relay 回程（方案 C）：发送后等不等创作教练建议
    setGateway: document.getElementById('s-gateway'),
    setPort: document.getElementById('s-port'),
    setRemoteMode: document.getElementById('s-remote-mode'), // ⑨ C9：入口 自动 / 手动
    // ④ mTLS 三件套：路径输入 + 各自的「选取…」按钮
    setCertPath: document.getElementById('s-cert-path'),
    setKeyPath: document.getElementById('s-key-path'),
    setCaPath: document.getElementById('s-ca-path'),
    setCertPick: document.getElementById('s-cert-pick'),
    setKeyPick: document.getElementById('s-key-pick'),
    setCaPick: document.getElementById('s-ca-pick'),
    setProofSession: document.getElementById('s-proof-session'),
    setRemoteNote: document.getElementById('s-remote-note'), // 静态规则（不覆盖）
    setRemoteEff: document.getElementById('s-remote-eff'), // ⑨ C9：入口实况（本次生效 + 顺位 + 逐条结果）
    setRestart: document.getElementById('s-restart'), // ⑩ U-20 #40④：一键重启客户端
    // ⑧ T-10：启动与托盘
    setAutoStart: document.getElementById('s-autostart'),
    setTray: document.getElementById('s-tray'),
    setTrayNote: document.getElementById('s-tray-note'),
    // 记录板（§1）：tabs 是 NodeList（事件委托到容器即可），其余按 id 抓
    boardTabs: document.querySelectorAll('.w-board-tab'),
    boardPanes: document.querySelectorAll('.w-board-pane'),
    boardPanel: document.getElementById('w-board-panel'),
    boardNotes: document.getElementById('w-board-notes'),
    boardTodoInput: document.getElementById('w-board-todo-input'),
    boardTodoList: document.getElementById('w-board-todo-list'),
    boardPreviewPicker: document.getElementById('w-board-preview-picker'),
    boardPreviewRefresh: document.getElementById('w-board-preview-refresh'),
    boardPreviewBody: document.getElementById('w-board-preview-body'),
    proofBadge: document.getElementById('w-proof-badge'),
    proofCount: document.getElementById('w-proof-count'),
    proofSubsegItems: document.querySelectorAll('[data-proof-view]'),
    boardNotePhrases: document.querySelector('.w-note-phrases'),
    // §3 敏感词：工具栏按钮 + 右栏敏感词面板（与 .w-proof 同 pane 互斥）
    sensitiveBtn: document.getElementById('w-sensitive'),
    sensitivePanel: document.getElementById('w-sensitive-panel'),
    sensitiveCount: document.getElementById('w-sensitive-count'),
    sensitiveChips: document.getElementById('w-sensitive-chips'),
    sensitiveStatus: document.getElementById('w-sensitive-status'),
    sensitiveList: document.getElementById('w-sensitive-list'),
    // relay 回程（方案 C）：coach 面板五件套（与 .w-proof / .w-sensitive 同 pane 三态）
    coachPanel: document.getElementById('w-coach-panel'),
    coachCount: document.getElementById('w-coach-count'),
    coachStatus: document.getElementById('w-coach-status'),
    coachList: document.getElementById('w-coach-list'),
    coachCancel: document.getElementById('w-coach-cancel'),
    setSensitive: {
      politics: document.getElementById('s-sensitive-politics'),
      violence: document.getElementById('s-sensitive-violence'),
      porn: document.getElementById('s-sensitive-porn'),
      gamble: document.getElementById('s-sensitive-gamble'),
      drugs: document.getElementById('s-sensitive-drugs'),
      fraud: document.getElementById('s-sensitive-fraud'),
      ads: document.getElementById('s-sensitive-ads'),
      abuse: document.getElementById('s-sensitive-abuse'),
      custom: document.getElementById('s-sensitive-custom'),
      customWords: document.getElementById('s-sensitive-custom-words'),
      ignoreWords: document.getElementById('s-sensitive-ignore-words'),
    },
    // §4 全站内容搜索：工具栏按钮 + 写作区浮层（.w-remote-view 同构）
    searchOpenBtn: document.getElementById('w-search-open'),
    searchView: document.getElementById('w-search-view'),
    searchInput: document.getElementById('w-search-input'),
    searchCase: document.getElementById('w-search-case'),
    searchScope: document.querySelectorAll('input[name="w-search-where"]'),
    searchClose: document.getElementById('w-search-close'),
    searchProgress: document.getElementById('w-search-progress'),
    searchResults: document.getElementById('w-search-results'),
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
    renderIdentity()
  }

  /** 文档身份行：与底部 #w-path 同源（state.current.relPath / state.root），只换两行排版 */
  function renderIdentity() {
    var cur = state.current
    var name = cur ? (cur.name || String(cur.relPath || '').split('/').pop() || '未命名') : '未命名'
    var sub = cur ? cur.relPath : (state.root ? '未选择文档' : '未选择工作区')
    if (els.identityName) els.identityName.textContent = name
    if (els.identityPath) {
      els.identityPath.textContent = sub
      els.identityPath.title = state.root
        ? (state.root + '\\' + (cur ? cur.relPath.replace(/\//g, '\\') : ''))
        : ''
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
    coachReset() // relay 回程：换工作区 ⇒ 创作教练等待/建议一并作废
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
    coachReset() // relay 回程：当前文档没了 ⇒ 创作教练等待/建议立刻作废
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
    // 两栏 hidden 交 renderPanels 统一裁决：退出分栏时回到用户持久化的收起偏好（旧代码强制 false 会冲掉它）
    renderPanels()
  }

  /** ⑰ 两栏显隐的**唯一裁决入口**（renderSplit 与收起开关都走它）：
        · 分栏中 → 两栏是浮层，显隐看 state.split.docs/board 瞬时态，收起钮禁用；
        · 常驻模式 → 看 state.ui.collapseLeft/Right 持久化偏好；中栏靠 flex:1 自动占满。 */
  function renderPanels() {
    var on = !!(state.split && state.split.on)
    if (els.sidebar) els.sidebar.hidden = on ? !state.split.docs : !!state.ui.collapseLeft
    if (els.right) els.right.hidden = on ? !state.split.board : !!state.ui.collapseRight
    if (els.collapseLeft) {
      els.collapseLeft.disabled = on
      els.collapseLeft.classList.toggle('active', !!state.ui.collapseLeft)
      els.collapseLeft.setAttribute('aria-pressed', state.ui.collapseLeft ? 'true' : 'false')
    }
    if (els.collapseRight) {
      els.collapseRight.disabled = on
      els.collapseRight.classList.toggle('active', !!state.ui.collapseRight)
      els.collapseRight.setAttribute('aria-pressed', state.ui.collapseRight ? 'true' : 'false')
    }
  }

  /** ⑰ 左右栏收起偏好落盘（只写 collapseLeft/Right，不碰 split） */
  function saveCollapse() {
    if (!api || !api.saveConfig) return
    api.saveConfig({
      ui: { collapseLeft: !!state.ui.collapseLeft, collapseRight: !!state.ui.collapseRight },
    })
  }

  /** ⑰ 点收起/展开：翻转偏好 → 重渲染 → 落盘 */
  function toggleCollapse(which) {
    if (which === 'left') state.ui.collapseLeft = !state.ui.collapseLeft
    if (which === 'right') state.ui.collapseRight = !state.ui.collapseRight
    renderPanels()
    saveCollapse()
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
            syncEnqueueOp('archive', d.relPath) // ⑭ §8：失败/离线入队，启动/联网/同步成功后重放
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
          syncEnqueueOp('archive', d.relPath) // ⑭ §8：离线删除入队，联网后自动归档（不再要求用户重新删除）
          notice('已把《' + d.name + '》移入本地回收站（联网后将自动同步到云端回收站）')
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
            // ⑭ §8：离线整作品删除 ⇒ 按本地作品树逐件入队（此时作品尚未进本地回收站，w.docs 仍可读）
            ;(w.docs || []).forEach(function (d) { syncEnqueueOp('archive', d.relPath) })
            notice('已把作品《' + w.name + '》移入本地回收站（联网后将自动同步到云端回收站）')
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
          if (!r || !r.ok) {
            fail++; notice('删除失败：' + d.name + ' ' + ((r && r.error) || ''), true)
            syncEnqueueOp('archive', d.relPath) // ⑭ §8：失败留待联网后重放
          }
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
      // 先让本地还原可见，再联动云端（refreshTree 会重建 state.works，作品形态要靠它枚举章节）
      return refreshTree().then(function () { return loadTrash(true) }).then(function () {
        renderSidebar()
        if (!syncReady()) return 0
        // 云端联动还原**一篇**（spec §5.3）。🔴 rel 一律用正文原 rel，绝不传 `_回收/...`。返回 true=该篇失败。
        function restoreDoc(rel) {
          return window.WCSyncNet.restoreDraft(rel).then(function (r) {
            if (r && r.ok) {
              state.sync.list = null
              syncClearDismissed(rel) // ⑬ 云端已还原：旧决策作废
              return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, rel, r.version, Date.now())).then(function () { return false })
            }
            // 云端回收也没有（NO_ARCHIVE/404）⇒ 读本地正文、无 baseVersion 补传
            if (r && r.noArchive) {
              return api.readDoc(rel).then(function (rd) {
                return window.WCSyncNet.saveDraft(rel, rd && rd.content, null).then(function (sv) {
                  if (sv && sv.ok) {
                    state.sync.list = null
                    syncClearDismissed(rel) // ⑬ 补传成功：旧决策作废
                    return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, rel, sv.version, Date.now())).then(function () { return false })
                  }
                  // 补传撞 409（远端已被占）⇒ 绝不覆盖，弹 conflict 交用户（409 不入队）
                  if (sv && sv.conflict) { syncShowBanner(rel, 'conflict', { remoteVersion: '' }); return false }
                  syncEnqueueOp('restore', rel) // ⑭ §8：补传失败/离线入队
                  return true
                })
              }).catch(function () {
                syncEnqueueOp('restore', rel) // ⑭ §8：读本地/补传异常入队
                return true
              })
            }
            // 原位被占（VERSION_CONFLICT）⇒ 不动本地，弹 conflict 交用户（409 不入队）
            if (r && r.occupied) { syncShowBanner(rel, 'conflict', { remoteVersion: '' }); return false }
            syncEnqueueOp('restore', rel) // ⑭ §8：其它失败（网络/5xx）入队
            return true
          }).catch(function () {
            syncEnqueueOp('restore', rel) // ⑭ §8：restoreDraft 异常入队
            return true
          })
        }
        if (res.kind === 'work') {
          // 作品：本地还原后 state.works 即真相，枚举该作品全部章节，逐件 restoreDraft（任一失败计数，不阻断其余）
          var w = null
          for (var i = 0; i < state.works.length; i++) if (state.works[i].name === res.work) { w = state.works[i]; break }
          var docs = (w && w.docs) || []
          return docs.reduce(function (p, d) {
            return p.then(function (fails) { return restoreDoc(d.relPath).then(function (failed) { return fails + (failed ? 1 : 0) }) })
          }, Promise.resolve(0))
        }
        return restoreDoc(res.relPath).then(function (failed) { return failed ? 1 : 0 })
      }).then(function (failN) {
        if (failN) notice(what + '已在本地恢复；但有 ' + failN + ' 篇未能同步回云端（可再打开该篇由自动补传兜底）', true)
        else notice('已恢复 ' + what)
      })
    })
  }

  function doPurge(it) {
    // 硬删**不可恢复** ⇒ 这里用一次系统确认（与本仓"切换工作区"同款；只此一处）
    var ok = window.confirm('彻底删除「' + it.name + '」？\n\n这一步是真删，删除后无法恢复。')
    if (!ok) return
    api.purgeTrash(it.relPath).then(function (res) {
      if (!res || !res.ok) { opFail('彻底删除', res); return }
      notice('已彻底删除「' + it.name + '」')
      // spec §9：本地动作已完成即不回滚；云端清回收+硬删标记失败也不"恢复本地"，只提示
      return loadTrash(true).then(function () { renderSidebar() }).then(function () {
        // ⑭ §8：离线硬删——doc 形态 rel 已知，可入队；work 形态离线无法枚举章节，只能等在线时重删
        if (!syncReady()) {
          if (it.kind !== 'work') syncEnqueueOp('purge', it.work + '/' + it.name)
          return 0
        }
        // 云端硬删一篇（入参为正文原 rel）并清正文基线。返回 true=失败。
        function purgeDoc(rel) {
          return window.WCSyncNet.purgeRecycled(rel).then(function (r) {
            saveSyncBaseline(SYNC.dropBaseline(state.sync.baseline, rel))
            if (!(r && r.ok)) syncEnqueueOp('purge', rel) // ⑭ §8：硬删联动失败/离线入队（purged:0 回 ok 不入）
            return !(r && r.ok)
          }).catch(function () {
            saveSyncBaseline(SYNC.dropBaseline(state.sync.baseline, rel))
            syncEnqueueOp('purge', rel) // ⑭ §8：网络异常入队
            return true
          })
        }
        if (it.kind === 'work') {
          // 作品：preload 无枚举回收作品目录之面，故原 rel 清单以云端归档 idx.archived 为准，按「作品名/」前缀逐件 purge
          var prefix = it.name + '/'
          return syncRemoteIndex(true).then(function (ix) {
            var rels = Object.keys((ix && ix.archived) || {}).filter(function (rel) { return rel.indexOf(prefix) === 0 })
            return rels.reduce(function (p, rel) {
              return p.then(function (fails) { return purgeDoc(rel).then(function (failed) { return fails + (failed ? 1 : 0) }) })
            }, Promise.resolve(0))
          }).catch(function () { return 1 })
        }
        return purgeDoc(it.work + '/' + it.name).then(function (failed) { return failed ? 1 : 0 })
      }).then(function (failN) {
        state.sync.list = null
        if (failN) notice('本地已彻底删除；云端清理有 ' + failN + ' 项未完成（不影响本地，可稍后重试）', true)
      }).catch(function () { state.sync.list = null })
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
    searchLocalCache = Object.create(null) // §4 刷新/切工作区 ⇒ 本地正文缓存作废（mtime 重新校验）
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

  function selectDoc(d, afterOpen) {
    if (!d || !d.relPath) return
    var openDone = function () {
      if (typeof afterOpen === 'function') afterOpen()
    }
    if (state.current && state.current.relPath === d.relPath) { openDone(); return }
    // 切文档前先 flush 当前稿（此刻 state.current 还是旧文档 ⇒ board 收尾也在这之前）
    boardFlushCurrent()
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
      coachReset() // relay 回程：换文档 ⇒ 上一份的教练等待/建议必须清掉
      findHide(false) // ③ 换文档 ⇒ 旧文档的查找命中作废（不抢焦点）
      remoteViewHide() // ⑪ D-sync-1：「看远端内容」浮层不跨文档留
      // 分栏下：选中文档后自动收起左栏浮层 —— 否则它正好盖着刚打开的正文（"用完即收"）
      if (state.split.on && state.split.docs) state.split.docs = false
      renderSidebar()
      renderSaveState()
      renderStatusBar()
      notice('已打开 ' + d.relPath)
      // 记录板（§1.5-4）：本地即填 + 异步拉远端（不阻塞打开）
      boardLoadFor(d.relPath)
      // ⑪ C11：**打开之后**才做后台比对（不阻塞；理由见 syncAfterOpen 的注释）
      syncAfterOpen(d.relPath, res.content)
      openDone()
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

  /** 把 state.pomodoro 回填到**设置弹层**输入（工具栏时长输入已收纳进设置） */
  function syncPomodoroInputs() {
    var p = state.pomodoro
    if (els.setFocus) els.setFocus.value = p.focusMin
    if (els.setBreak) els.setBreak.value = p.breakMin
    if (els.setAutoNext) els.setAutoNext.checked = p.autoNext !== false
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
    settingsShowCat(settingsCat)
    els.setBox.hidden = false
    if (els.setClose) els.setClose.focus()
  }

  function settingsClose() {
    if (els.setBox) els.setBox.hidden = true
  }

  function settingsIsOpen() {
    return !!els.setBox && !els.setBox.hidden
  }

  var SETTINGS_CATS = [
    { name: 'workspace', title: '工作区', sub: '当前工作区与切换/新建流程', restore: '' },
    { name: 'editor', title: '编辑器与排版', sub: '自动保存去抖 + 写作区排版（字号/字体族/行高/字间距/行宽/配色）', restore: 'editor' },
    { name: 'pomodoro', title: '番茄钟', sub: '专注/休息时长与自动轮次（工具栏胶囊始终显示倒计时）', restore: 'pomodoro' },
    { name: 'send', title: '发送', sub: '诉求预设与创作教练回程建议', restore: '' },
    { name: 'appearance', title: '外观', sub: '亮 / 暗 / 跟随 [DSH]', restore: '' },
    { name: 'drafts', title: '草稿', sub: '份数、单份与总容量上限', restore: '' },
    { name: 'sensitive', title: '敏感词', sub: '纯本地扫描分类、自定义词与忽略词', restore: '' },
    { name: 'remote', title: '远程', sub: '入口顺位、网关地址与 mTLS 证书（重启生效）', restore: '' },
    { name: 'advanced', title: '启动与高级', sub: '开机自启、托盘与 AI 校对会话', restore: '' }
  ]
  var settingsCat = 'workspace'

  /** 左导航切类：只翻 .s-panel hidden 与导航高亮，不重新初始化任何控件（监听按 id 常驻） */
  function settingsShowCat(name) {
    var hit = null
    SETTINGS_CATS.forEach(function (c) { if (c.name === name) hit = c })
    if (!hit) return
    settingsCat = hit.name
    var navEls = document.querySelectorAll('.s-sidenav [data-set-cat]')
    for (var i = 0; i < navEls.length; i++) {
      navEls[i].classList.toggle('is-active', navEls[i].getAttribute('data-set-cat') === hit.name)
    }
    var panEls = document.querySelectorAll('.s-panel[data-set-panel]')
    for (var j = 0; j < panEls.length; j++) {
      panEls[j].hidden = panEls[j].getAttribute('data-set-panel') !== hit.name
    }
    var ct = document.getElementById('s-cat-title')
    var cs = document.getElementById('s-cat-sub')
    if (ct) ct.textContent = hit.title
    if (cs) cs.textContent = hit.sub
    if (els.setRestore) els.setRestore.hidden = !hit.restore
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
    // relay 回程（方案 C）：只有显式 false 才不勾（旧配置无此键 ⇒ 默认开，与桥 waitResult 判据同口径）
    if (els.setSendWaitResult) {
      els.setSendWaitResult.checked = (s.send && s.send.waitResult) !== false
    }
    if (els.setDraftsDir) {
      els.setDraftsDir.textContent = state.draftsDir || '（未知）'
      els.setDraftsDir.title = state.draftsDir || ''
    }
    if (els.setGateway) els.setGateway.value = r.gateway || ''
    if (els.setPort) els.setPort.value = r.port != null ? r.port : 18080
    // ⑨ C9：入口模式（自动 = 按顺位探测 + 降级；手动 = 只用上面的地址）
    if (els.setRemoteMode) els.setRemoteMode.value = r.mode === 'manual' ? 'manual' : 'auto'
    // ④ mTLS 三件套路径（主进程已 trim；空串 = 未配置）
    if (els.setCertPath) els.setCertPath.value = r.certPath || ''
    if (els.setKeyPath) els.setKeyPath.value = r.keyPath || ''
    if (els.setCaPath) els.setCaPath.value = r.caPath || ''
    // ⑥ B5：校对专用会话 id（主进程已把"配置为空 ⇒ 内置默认"解析好 ⇒ 这里显示的是**生效值**）
    if (els.setProofSession) els.setProofSession.value = state.proofreadSessionId || ''
    // §3 敏感词：9 个分类勾选 + 自定义词/忽略词（数组 ⇄ 每行一个）；值一律以主进程归一化结果为准
    var sn = (s.sensitive && typeof s.sensitive === 'object') ? s.sensitive : {}
    var snEn = sn.enabled || {}
    SENSITIVE_CATEGORY_IDS.forEach(function (id) {
      var input = els.setSensitive && els.setSensitive[id]
      if (input) input.checked = snEn[id] === true
    })
    if (els.setSensitive) {
      if (els.setSensitive.customWords) els.setSensitive.customWords.value = (sn.customWords || []).join('\n')
      if (els.setSensitive.ignoreWords) els.setSensitive.ignoreWords.value = (sn.ignoreWords || []).join('\n')
    }
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
        // ④ mTLS：证书实况（ready/expired/error 都要让用户看见；none = 没配，不吵）
        var cert = rp.cert
        if (cert && cert.status === 'ready') {
          parts.push('mTLS 证书就绪（' + (cert.source === 'env' ? '环境变量' : '设置') + '：' + (cert.detail || '') + '）')
        } else if (cert && cert.status === 'expired') {
          parts.push('⚠ mTLS 证书已过期（' + (cert.detail || '') + '）⇒ ② 握手大概率被拒')
        } else if (cert && cert.status === 'error') {
          parts.push('⚠ mTLS 证书不可用 ⇒ ② 跳过：' + (cert.error || ''))
        }
      }
    }
    els.setRemoteEff.textContent = parts.join('　｜　')
  }

  // ④ mTLS：手输证书路径 ⇒ 失焦(change)保存（允许清空 = 不配置；只写配置，重启才生效）
  function bindCertPath(input, field, label) {
    if (!input) return
    input.addEventListener('change', function () {
      var patch = {}
      patch[field] = input.value
      saveSettings({ remote: patch }).then(function (res) {
        if (res && res.ok) notice(label + '已保存 —— 重启客户端后生效')
      })
    })
  }

  // ④ mTLS：「选取…」按钮 ⇒ 主进程弹文件框 ⇒ 写回输入框 + 立即按 change 同口径保存
  function bindCertPick(btn, kind, input, field) {
    if (!btn || !input) return
    btn.addEventListener('click', function () {
      api.pickCertFile(kind).then(function (res) {
        if (!res || res.canceled) return
        if (!res.ok) { notice('选取失败：' + (res.error || ''), true); return }
        input.value = res.path
        var patch = {}
        patch[field] = res.path
        return saveSettings({ remote: patch }).then(function (r) {
          if (r && r.ok) notice('证书路径已保存 —— 重启客户端后生效')
        })
      }).catch(function (e) {
        notice('选取证书失败：' + ((e && e.message) || e), true)
      })
    })
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
    var sidenav = document.querySelector('.s-sidenav')
    if (sidenav) sidenav.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-set-cat]') : null
      if (btn) settingsShowCat(btn.getAttribute('data-set-cat'))
    })
    if (els.setDone) els.setDone.addEventListener('click', settingsClose)
    if (els.setRestore) els.setRestore.addEventListener('click', function () {
      var hit = null
      SETTINGS_CATS.forEach(function (c) { if (c.name === settingsCat) hit = c })
      if (!hit || !hit.restore) return
      if (hit.restore === 'editor') {
        applyTypoPreset('default')
        notice('排版已恢复默认预设')
      } else if (hit.restore === 'pomodoro') {
        applyPomodoro(25, 5, state.pomodoro.autoNext !== false)
        notice('番茄钟已恢复 25 / 5')
      }
    })

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
    // relay 回程（方案 C）：勾选态即时落盘；载荷只带 send.waitResult，intents 由主进程从现值补齐
    if (els.setSendWaitResult) {
      els.setSendWaitResult.addEventListener('change', function () {
        saveSettings({ send: { waitResult: !!els.setSendWaitResult.checked } })
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
    // ④ mTLS 三件套：手输路径 change 即存（允许清空）；「选取…」弹框后写回输入框并保存
    bindCertPath(els.setCertPath, 'certPath', '设备证书路径')
    bindCertPath(els.setKeyPath, 'keyPath', '私钥路径')
    bindCertPath(els.setCaPath, 'caPath', '服务器证书路径')
    bindCertPick(els.setCertPick, 'cert', els.setCertPath, 'certPath')
    bindCertPick(els.setKeyPick, 'key', els.setKeyPath, 'keyPath')
    bindCertPick(els.setCaPick, 'ca', els.setCaPath, 'caPath')
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
    // §3 敏感词：分类勾选逐项落盘（只带 enabled 这一字段，主进程与基线浅合并，不丢词表）
    SENSITIVE_CATEGORY_IDS.forEach(function (id) {
      var input = els.setSensitive && els.setSensitive[id]
      if (!input) return
      input.addEventListener('change', function () {
        var patch = {}
        patch[id] = input.checked
        saveSettings({ sensitive: { enabled: patch } })
      })
    })
    // §3 自定义词 / 忽略词：失焦保存（change），textarea 按换行拆词，主进程归一化（去重/截断/限长）并回填
    if (els.setSensitive && els.setSensitive.customWords) {
      els.setSensitive.customWords.addEventListener('change', function () {
        saveSettings({ sensitive: { customWords: els.setSensitive.customWords.value } })
      })
    }
    if (els.setSensitive && els.setSensitive.ignoreWords) {
      els.setSensitive.ignoreWords.addEventListener('change', function () {
        saveSettings({ sensitive: { ignoreWords: els.setSensitive.ignoreWords.value } })
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
    if (els.identityDot) {
      var online = !state.sync.note
      els.identityDot.classList.toggle('is-on', online)
      els.identityDot.classList.toggle('is-off', !online)
      els.identityDot.title = online ? '任务中心在线' : (state.sync.note || '任务中心未连接')
    }
  }

  /** 远端清单（带 TTL 缓存）。🔴 任何失败都回 `known:false` 的索引 —— 调用方按"远端未知"处理 */
  function syncRemoteIndex(force) {
    var now = Date.now()
    if (!force && state.sync.list && now - state.sync.list.at < SYNC_LIST_TTL_MS) {
      return Promise.resolve(state.sync.list.index)
    }
    if (!syncReady()) return Promise.resolve(SYNC ? SYNC.indexList(null) : { known: false, byRel: {}, archived: {}, purged: {}, tomb: {} })
    return window.WCSyncNet.listDrafts().then(function (r) {
      var idx = SYNC.indexList(r && r.ok ? r.data : null)
      state.sync.list = { at: Date.now(), index: idx }
      return idx
    })
  }

  function initSync() {
    // ⑭ 离线待办即使在同步模块缺失时也要载入（只是不重放），避免内存态与磁盘脱节
    var loadOps = api.syncPendingOps
      ? api.syncPendingOps().then(function (r) {
          state.sync.pendingOps = (r && Array.isArray(r.ops)) ? r.ops : []
        }).catch(function () { state.sync.pendingOps = [] })
      : Promise.resolve()
    if (!syncReady()) {
      // 模块缺失**不能**让写作功能受影响：只在状态栏如实说一句
      syncNotice(SYNC ? '未同步（链路未加载）' : '未同步（同步模块未加载）')
      return loadOps
    }
    if (!api.syncBaseline) { syncNotice('未同步（接口不可用）'); return loadOps }
    return api.syncBaseline().then(function (r) {
      state.sync.baseline = SYNC.normalizeBaseline(r && r.baseline)
      syncNotice('')
    }).then(function () { return loadOps }).then(function () {
      // ⑭ §8：启动重放一次（懒拉取，不主动拉正文清单；drain 内部各自按需取数）
      return syncDrainPendingOps()
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

  // ── ⑭ §8 离线待办队列 ────────────────────────────────────────────────────
  // 软删/还原/硬删的云端联动失败或离线时入队；启动 / 联网恢复 / 每次同步成功后重放。
  // 归并规则：同一 rel 只留**最后一条** op（archive 后又 restore ⇒ 只留 restore）。

  /** 入队一条待办并按 rel 归并，然后整体写回主进程（同步改内存；写盘失败只提示，内存仍为准，下次入队再写） */
  function syncEnqueueOp(op, rel) {
    if (!rel || (op !== 'archive' && op !== 'restore' && op !== 'purge')) return
    var ops = state.sync.pendingOps || []
    for (var i = 0; i < ops.length; i++) {
      if (ops[i] && ops[i].rel === rel) { ops.splice(i, 1); break } // 同 rel：旧 op 被后 op 顶掉
    }
    ops.push({ op: op, rel: rel, at: Date.now() })
    state.sync.pendingOps = ops
    if (api.syncPendingOpsSet) {
      api.syncPendingOpsSet(ops).then(function (r) {
        if (!r || !r.ok) notice('离线待办写入失败：' + ((r && r.error) || '未知错误'), true)
      }).catch(function () {})
    }
  }

  /** 顺序重放全部待办；成功的出队，失败的留队，**全部成功才整体清空**。未就绪/已在跑则跳过本轮 */
  function syncDrainPendingOps() {
    if (!syncReady() || state.sync.pendingDrain) return Promise.resolve()
    var ops = state.sync.pendingOps || []
    if (!ops.length) return Promise.resolve()

    /**
     * 重放**一条**待办（drain 的内嵌闭包）。🔴 幂等（spec §8）：
     *  · archive 重复 ⇒ 云端回收里多一个时间戳副本，不报错；
     *  · restore 遇 404 NO_ARCHIVE ⇒ 读本地正文、无 baseVersion 补传，补传成功即完成；
     *  · purge 认 ok（`purged:0` 也算成功）。
     * 409（原位占用 / 补传被拒）是**用户决策态**，不当离线失败：弹横幅并视为该 op 终结（出队，不重试）。
     * 返回 true=成功（出队）；false=仍失败（留队稍后重试）。
     */
    function replayOp(item) {
      var rel = item.rel
      switch (item.op) {
        case 'archive':
          return window.WCSyncNet.deleteDraft(rel).then(function (r) {
            if (r && r.ok) {
              state.sync.list = null
              return saveSyncBaseline(SYNC.dropBaseline(state.sync.baseline, rel)).then(function () { return true })
            }
            return false
          }).catch(function () { return false })
        case 'restore':
          return window.WCSyncNet.restoreDraft(rel).then(function (r) {
            if (r && r.ok) {
              state.sync.list = null
              syncClearDismissed(rel)
              return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, rel, r.version, Date.now())).then(function () { return true })
            }
            if (r && r.occupied) { syncShowBanner(rel, 'conflict', { remoteVersion: '' }); return true }
            if (r && r.noArchive) {
              // 云端回收已被独立清掉 ⇒ 读本地正文走首推口径补传
              return api.readDoc(rel).then(function (rd) {
                return window.WCSyncNet.saveDraft(rel, rd && rd.content, null).then(function (sv) {
                  if (sv && sv.ok) {
                    state.sync.list = null
                    syncClearDismissed(rel)
                    return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, rel, sv.version, Date.now())).then(function () { return true })
                  }
                  if (sv && sv.conflict) { syncShowBanner(rel, 'conflict', { remoteVersion: '' }); return true }
                  return false
                })
              }).catch(function () { return false })
            }
            return false
          }).catch(function () { return false })
        case 'purge':
          return window.WCSyncNet.purgeRecycled(rel).then(function (r) {
            if (r && r.ok) { // purged:0 也回 ok:true ⇒ 幂等成功
              state.sync.list = null
              return saveSyncBaseline(SYNC.dropBaseline(state.sync.baseline, rel)).then(function () { return true })
            }
            return false
          }).catch(function () { return false })
        default:
          return Promise.resolve(true) // 未知 op（坏数据）⇒ 不当毒药留队
      }
    }

    state.sync.pendingDrain = true
    var kept = []
    return ops.reduce(function (p, item) {
      return p.then(function () {
        return replayOp(item).then(function (done) { if (!done) kept.push(item) })
      })
    }, Promise.resolve()).then(function () {
      state.sync.pendingOps = kept
      state.sync.pendingDrain = false
      if (!kept.length && api.syncPendingOpsSet) return api.syncPendingOpsSet([])
      return null
    }).catch(function () { state.sync.pendingDrain = false })
  }

  function syncHideBanner() {
    state.sync.pending = null
    if (els.syncBanner) els.syncBanner.hidden = true
    remoteViewHide() // 「看远端内容」浮层跟着横幅一起收
  }

  /** ⑬ 去重键：同一篇文档 + 同一类结论才算同一个待决策（不同文档/不同结论互不干扰） */
  function syncDismissedKey(relPath, kind) {
    return String(relPath) + '\u0000' + String(kind)
  }

  /** 清掉某篇文档的**全部**已决策记录（远端已变/文档换了内容时，旧结论作废） */
  function syncClearDismissed(relPath) {
    var prefix = String(relPath) + '\u0000'
    Object.keys(state.sync.dismissed).forEach(function (k) {
      if (k.indexOf(prefix) === 0) delete state.sync.dismissed[k]
    })
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
    // ⑬ 同篇 + 同结论 + 远端版本没变 ⇒ 用户已处置过（如点过「保留本地」），不再反复弹
    var dk = syncDismissedKey(relPath, kind)
    var prev = state.sync.dismissed[dk]
    if (prev !== undefined && prev === ((detail && detail.remoteVersion) || '')) return
    state.sync.pending = { relPath: relPath, kind: kind, detail: detail || {} }
    var d = detail || {}
    if (kind === 'remote-purged') {
      els.syncTitle.textContent = '《' + relPath + '》在远端已被彻底删除'
      els.syncNote.textContent = '服务器正文与云端回收都已清空这份（硬删，无法从云端恢复）。' +
        '🔴 本地这份**不会被自动删，也不会重新上传** —— 保留还是移入本地回收站，由你决定。'
    } else if (kind === 'remote-deleted') {
      if (d.tomb) {
        els.syncTitle.textContent = '远端已删除《' + relPath + '》'
        els.syncNote.textContent = '服务器上这份已被删除' +
          (d.tomb.deletedBy ? '（由 ' + d.tomb.deletedBy + '）' : '') +
          '。🔴 本地这份**不会被自动删** —— 保留还是清掉，由你决定。'
      } else {
        els.syncTitle.textContent = '服务器上缺这份《' + relPath + '》'
        els.syncNote.textContent = '上次同步之后，服务器正文与云端回收里都查不到这份' +
          '（常见于服务端改了存储位置、或数据被挪动）。🔴 本地这份**不会被自动删**；' +
          '下次保存时会自动补传回服务器，也可先「保留本地」稍后再传。'
      }
    } else if (kind === 'remote-newer') {
      els.syncTitle.textContent = '《' + relPath + '》远端有更新'
      els.syncNote.textContent = '本地这份相对上次同步没动过，服务器上是更新的版本。' +
        '选「用远端覆盖本地」会先把你本地那份**移入回收站**（可恢复），再写入远端版本。'
    } else {
      els.syncTitle.textContent = '《' + relPath + '》本地与远端都改过'
      els.syncNote.textContent = '**不会自动合并**，也不替你选。' +
        '「用远端覆盖本地」会先把本地那份移入回收站（可恢复）；' +
        '「本地这份另存为…」会把你本地的内容用带时间戳的新名字另存一篇（本地和服务器各多一篇新文件，原来的两边都不动）；' +
        '「保留本地」则不动任何一侧，等你下次保存/发送时再决定。'
    }
    // §10 手动「重新上传」按钮已移除：缺件（有基线、回收无、硬删无）由 decidePush 判 push/reupload 自动补传
    syncBtn(els.syncTakeRemote, kind !== 'remote-deleted' && kind !== 'remote-purged')
    // ⑤ 「另存为」只给两边都改过的真冲突：remote-newer 本地没动、覆盖即可，没有需要另存的内容
    syncBtn(els.syncSaveAs, kind === 'conflict')
    syncBtn(els.syncKeepLocal, true)
    syncBtn(els.syncTrashLocal, kind === 'remote-deleted' || kind === 'remote-purged')
    // ⑪ D-sync-1（b）：远端**有内容可看**的两种横幅才给「看远端内容」（已删除/缺件/硬删没得看）
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
        purged: !!idx.purged[relPath],
        baselineVersion: SYNC.baselineVersionOf(state.sync.baseline, relPath),
      })
      state.sync.last = { relPath: relPath, action: r.action, at: Date.now() }
      syncNotice(SYNC.actionText(r.action))
      if (!idx.known) return // 远端未知：只显示状态，**不做任何判断**
      if (r.action === 'in-sync') {
        // 记下共同祖先 —— 下次才能区分"谁动过"（没有它就只能一律判冲突）
        syncDrainPendingOps() // ⑭ §8：链路已验证可用，顺手重放离线待办
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
      if (r.action === 'remote-purged') return syncShowBanner(relPath, 'remote-purged', {})
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
        archived: !!idx.archived[rel],
        purged: !!idx.purged[rel],
      })
      syncNotice(SYNC.pushText(d.action))
      state.sync.last = { relPath: rel, action: d.action, at: Date.now(), dir: 'push' }
      if (d.action !== 'push') {
        // 远端动过 / 远端已删 / 无从比较 ⇒ **不推**，把决定权交回用户（复用打开时那套横幅）
        if (seq !== state.sync.seq) return null // 🔴 D-sync-1：结论已过期（刚完成过重新上传等）⇒ 不弹横幅
        if (d.action === 'remote-newer') syncShowBanner(rel, 'remote-newer', { remoteVersion: hit ? hit.version : '' })
        else if (d.action === 'remote-deleted') syncShowBanner(rel, 'remote-deleted', { tomb: idx.tomb[rel] || null })
        else if (d.action === 'remote-purged') syncShowBanner(rel, 'remote-purged', {})
        else if (d.action === 'conflict') syncShowBanner(rel, 'conflict', { remoteVersion: hit ? hit.version : '' })
        return null
      }
      return window.WCSyncNet.saveDraft(rel, text, d.baseVersion ? { baseVersion: d.baseVersion } : null).then(function (r) {
        if (r && r.ok) {
          state.sync.lastPushAt = Date.now()
          state.sync.list = null // 远端内容变了 ⇒ 清单缓存作废
          syncClearDismissed(rel) // ⑬ 成功上行：旧决策作废
          syncNotice('已同步')
          notice('已同步到服务器：' + rel)
          syncDrainPendingOps() // ⑭ §8：每次同步成功后重放离线待办（在跑保护防并发）
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
      coachReset()
      renderSidebar()
      renderSaveState()
      renderStatusBar()
      // 记录板（§1.5-4）：远端覆盖本地后同样重新装载该文档的笔记/待办
      boardLoadFor(relPath)
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
            syncClearDismissed(rel) // ⑬ 已用远端覆盖：旧决策作废
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
    // ⑬ 记住「这一篇 + 这个结论 + 这个远端版本」已决策：自动保存/重开不再反复弹；远端版本一变仍会重弹
    if (p && p.relPath) state.sync.dismissed[syncDismissedKey(p.relPath, p.kind)] = (p.detail && p.detail.remoteVersion) || ''
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
    syncClearDismissed(p.relPath) // ⑬ 本地已移入回收站：旧决策作废
    syncNotice('已把本地这份移入回收站')
  }

  // ── ⑤ 并发写入 409「另存为」──────────────────────────────────────────────
  //
  // 场景：本地与远端**两边都改过**（409/conflict），用户哪份都不想丢。
  // 做法：把**本地这份**内容用带时间戳的新名字另存一篇 —— 本地多一篇新文件、
  // 服务器客户端区也多一篇新文件；**原来的两边一律不动**（不覆盖、不删除、不 force）。
  // 命名与 send-net 的 409 另存为同一口径（WCSend.altDraftName = `<doc>-YYYYMMDD-HHmm.md`），
  // 撞名（本地侧栏缓存 / 远端索引里已有）则追加 -2/-3 避让。
  function pad2Num(n) { return (n < 10 ? '0' : '') + n }
  function syncAltStamp(d) {
    return String(d.getFullYear()) + pad2Num(d.getMonth() + 1) + pad2Num(d.getDate()) +
      '-' + pad2Num(d.getHours()) + pad2Num(d.getMinutes())
  }

  /**
   * 生成不撞名的另存文件名。`taken` 为已占用 relPath 集合。
   * 首选 `<doc>-YYYYMMDD-HHmm.md`（WCSend 在场时直接复用，保证与发送链路同口径）；
   * 撞名 ⇒ `<doc>-...-2.md`、`-3.md`…… 避让；文档名为空 ⇒ null。
   */
  function syncAltRelName(work, name, taken) {
    var base = String(name || '').replace(/\.md$/i, '')
    if (!base) return null
    var first
    try {
      first = (window.WCSend && typeof window.WCSend.altDraftName === 'function')
        ? window.WCSend.altDraftName(name, new Date())
        : base + '-' + syncAltStamp(new Date()) + '.md'
    } catch (e) {
      first = base + '-' + syncAltStamp(new Date()) + '.md'
    }
    var candidate = first
    for (var i = 2; i <= 99; i++) {
      var rel = work ? work + '/' + candidate : candidate
      if (!taken[rel]) return candidate
      candidate = first.replace(/\.md$/i, '-' + i + '.md')
    }
    return null
  }

  /**
   * ⑤ 冲突横幅「本地这份另存为…」：
   *   ① 冲突稿是当前打开文档 ⇒ 先 flush 落盘（与自动补传同一 D-sync-1 口径，不丢未保存输入）；
   *   ② 先写本地新文件，再无 baseVersion 推服务器（全新文件，正常不会 409；若 409 ⇒ 不 force，交回用户）；
   *   ③ 成功后记基线、作废清单、刷新侧栏并打开新文档；原文档两边一律不动。
   * 🔴 fail-closed：本地写失败就中止；服务器没上去也**不删本地新文件**（打开新文档会走 local-only 自动补传）。
   */
  function syncSaveAs() {
    var p = state.sync.pending
    if (!p || !p.relPath || !syncReady()) return
    var rel = p.relPath
    if (p.kind !== 'conflict') return
    var parts = rel.split('/')
    var work = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    var name = parts[parts.length - 1]

    // 已占用名：本地侧栏缓存 + 远端索引（两边都避让，宁可贵一点也不覆盖任何一篇）
    var taken = {}
    ;(state.works || []).forEach(function (w) {
      ;(w.docs || []).forEach(function (d) { if (d.relPath) taken[d.relPath] = 1 })
    })
    var ix = syncIndex()
    if (ix.known) Object.keys(ix.byRel || {}).forEach(function (r) { taken[r] = 1 })

    var altName = syncAltRelName(work, name, taken)
    if (!altName) {
      notice('另存为已中止：文档名为空或可用新名已用尽（原文档未动）', true)
      return
    }
    var altRel = work ? work + '/' + altName : altName

    var isCurrent = !!(state.current && state.current.relPath === rel)
    syncNotice('另存为中…')
    var step = isCurrent ? flush({ force: true, reason: 'sync-save-as' }) : Promise.resolve({ ok: true })
    Promise.resolve(step).then(function (fl) {
      if (isCurrent && fl && fl.ok === false) {
        notice('另存为已中止：本地这份保存失败（' + (fl.error || '未知错误') + '）—— 原文档未动', true)
        return null
      }
      var read = isCurrent
        ? Promise.resolve({ ok: true, content: Editor.getText() })
        : api.readDoc(rel)
      return read.then(function (rd) {
        if (!rd || !rd.ok) {
          notice('另存为已中止：读不到本地这份（' + ((rd && rd.error) || '未知错误') + '）', true)
          return null
        }
        // 落盘前再判一次"本地是否已存在"（侧栏是缓存，可能已被别的窗口建出来）
        return api.readDoc(altRel).then(function (ex) {
          if (ex && ex.ok) {
            notice('另存为已中止：《' + altRel + '》本地已存在（原文档未动）—— 请重新点一次另存为', true)
            return null
          }
          return api.writeDoc(altRel, rd.content).then(function (w) {
            if (!w || !w.ok) {
              notice('另存为已中止：写入本地失败（' + ((w && w.error) || '未知错误') + '）—— 原文档未动', true)
              return null
            }
            // 全新文件 ⇒ 不带 baseVersion（服务端不存在同路径时直接创建）
            return window.WCSyncNet.saveDraft(altRel, rd.content, null).then(function (r) {
              if (r && r.ok) {
                state.sync.lastPushAt = Date.now()
                state.sync.list = null
                state.sync.seq++ // 旧文档那条冲突结论作废（用户已选择另存出口）
                syncHideBanner()
                syncClearDismissed(rel) // ⑬ 原文档已走另存出口：旧决策作废
                syncNotice('已另存为：' + altRel)
                notice('本地这份已另存为《' + altName + '》并上传到服务器；原来的两边都没动')
                return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, altRel, r.version, Date.now()))
                  .then(function () { return refreshTree() })
                  .then(function () { return selectDoc({ relPath: altRel }) })
              }
              if (r && r.conflict) {
                // 全新名仍 409 ⇒ 远端在这期间被别人抢先建了同名件；**绝不 force**，本地新文件保留
                notice('服务器上已存在《' + altName + '》，未覆盖。本地新文件保留 —— 打开它可再次另存/补传', true)
                syncNotice('另存为：服务器同名冲突（本地新文件已保留）')
                return refreshTree()
              }
              // 离线/超时/其它：本地新文件保留；打开它会走 local-only 自动补传，不丢
              notice('已在本地另存为《' + altName + '》，但服务器没上去（' + ((r && r.error) || '未知错误') +
                '）—— 打开新文档后会自动补传', true)
              syncHideBanner()
              return refreshTree().then(function () { return selectDoc({ relPath: altRel }) })
            })
          })
        })
      })
    }).catch(function (e) {
      notice('另存为失败：' + ((e && e.message) || String(e)) + '（原文档未动）', true)
    })
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
    return (state.sync.list && state.sync.list.index) || { known: false, byRel: {}, archived: {}, purged: {}, tomb: {} }
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
  function pullAndOpen(relPath, afterOpen) {
    if (!relPath || !syncReady()) return
    notice('正在从服务器拉取《' + relPath + '》…')
    window.WCSyncNet.readDraft(relPath).then(function (r) {
      if (!r || !r.ok) {
        notice('拉取失败：' + ((r && r.error) || '未知错误'), true)
        return null
      }
      return api.readDoc(relPath).then(function (ex) {
        if (ex && ex.ok) {
          // 本地其实已有（侧栏缓存过期）：**已存在就不覆盖**，中止拉取
          notice('本地已有《' + relPath + '》，未覆盖；如需云端版本请用同步操作', true)
          return null
        }
        return api.writeDoc(relPath, r.content).then(function (wr) {
          if (!wr || !wr.ok) { notice('写入本地失败：' + ((wr && wr.error) || '未知错误'), true); return null }
          return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, relPath, r.version, Date.now()))
        }).then(function () {
          state.sync.list = null // 本地多了一篇 ⇒ 远端清单缓存作废，重拉
          return refreshTree()
        }).then(function () {
          return selectDoc({ relPath: relPath }, afterOpen)
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
   * ⑯ §7：拿到清单后顺跑一次后台三态自动对齐（静默，不弹横幅、不阻断编辑）。
   */
  function syncEnsureListForSidebar() {
    if (!syncReady() || state.sync.listPending) return
    state.sync.listPending = true
    syncRemoteIndex(false).then(function (idx) {
      state.sync.listPending = false
      if (!idx || !idx.known) return
      var sig = Object.keys(idx.byRel).sort().join('|')
      if (sig !== state.sync.sig) {
        state.sync.sig = sig
        renderSidebar()
      }
      syncAutoAlign(idx)
    }).catch(function () { state.sync.listPending = false })
  }

  // ── ⑯ §7 多端后台自动对齐（软删 / 还原 / 硬删三态，静默、无轮询、不阻断编辑）────────
  //
  // 触发：只挂在侧栏懒拉清单这一条链上（syncEnsureListForSidebar），**不做任何定时轮询**。
  // 一切联动只看「正文在不在、回收有没有同原路径件」（spec §6），不认时间戳：
  //   · 软删对齐：云端正文无 + archived 有 + 本地正文在 ⇒ 静默把本地这份移入本机回收（可恢复），清基线。
  //     云端已经是删的（archived 即云端回收件），本地只对齐文件，**绝不重复发云端删除**。
  //   · 还原对齐：云端正文有 + 本地正文无 ⇒ 本机回收有同原路径件就本地还原；
  //     本机回收也没有 ⇒ 当云端新件静默拉回（readDraft→writeDoc→记基线）。
  //   · 硬删对齐：purged 有 ⇒ 本地回收保留不动（云端无权删本地回收）、不重传、不拉；
  //     本地正文还在的情形由打开文档时的 remote-purged 中性横幅兜底，这里一律跳过。
  // 保护：正在编辑的那一篇（state.current）绝不在后台移动/覆盖；清单签名没变不重扫。
  function syncAutoAlign(idx) {
    if (!idx || idx.known !== true || !syncReady()) return
    if (state.sync.alignPending) return
    // 签名同时纳入 archived / purged，回收状态变化也要重扫
    var sig = Object.keys(idx.byRel).sort().join('|') +
      '#A#' + Object.keys(idx.archived).sort().join('|') +
      '#P#' + Object.keys(idx.purged).sort().join('|')
    if (sig === state.sync.alignSig) return
    state.sync.alignPending = true

    // 本地正文：rel(work/doc.md) → {work, name}
    var localDocs = {}
    ;(state.works || []).forEach(function (w) {
      ;(w.docs || []).forEach(function (d) {
        if (d && d.relPath) localDocs[d.relPath] = { work: w.name, name: d.name || d.relPath.split('/').pop() }
      })
    })

    var openRel = state.current ? state.current.relPath : ''
    var changed = false
    var chain = Promise.resolve()

    function refreshOnce() {
      if (!changed) return Promise.resolve()
      changed = false
      state.sync.list = null
      return refreshTree().then(function () { return loadTrash(true) }).then(function () { renderSidebar() })
    }

    // ① 软删对齐：遍历云端回收归组（archived 键=去戳后的正文原 rel）
    Object.keys(idx.archived).forEach(function (rel) {
      if (idx.purged[rel]) return                 // 硬删优先：purge 信号在，交给中性横幅口径
      if (idx.byRel[rel]) return                  // 云端正文已回到原位 ⇒ 不是删除（残留回收件，decide 已处理）
      if (!localDocs[rel]) return                 // 本地正文本就不在 ⇒ 两边一致，无需动作
      if (rel === openRel) return                 // 正在编辑：绝不在后台移走未保存内容
      var work = localDocs[rel].work
      var name = localDocs[rel].name
      chain = chain.then(function () {
        return api.trashDoc(work, name).then(function (res) {
          if (!res || !res.ok) return
          changed = true
          syncClearDismissed(rel)
          return saveSyncBaseline(SYNC.dropBaseline(state.sync.baseline, rel))
        }).catch(function () { /* 静默：失败就等下一轮清单刷新再对齐 */ })
      })
    })

    // ② 还原对齐：云端正文有、本地正文无（purged 有则跳过——硬删后重传不由后台自动拉）
    Object.keys(idx.byRel).forEach(function (rel) {
      if (idx.purged[rel]) return
      if (localDocs[rel]) return
      if (rel === openRel) return
      chain = chain.then(function () { return syncAutoAlignRestore(rel, idx.byRel[rel]) })
        .then(function (did) { if (did) changed = true })
    })

    chain.then(function () {
      state.sync.alignPending = false
      state.sync.alignSig = sig
      return refreshOnce()
    }).catch(function () { state.sync.alignPending = false })
  }

  /**
   * ⑯ 还原对齐的单篇处理：本机回收有同原路径件 ⇒ 取最新一件本地还原（保留本机删除前那份）；
   * 本机回收也没有 ⇒ 静默拉云端正文写本地（当云端新件）。成功后记基线。🔴 不弹任何横幅。
   * @returns {Promise<boolean>} 是否真的发生了对齐动作
   */
  function syncAutoAlignRestore(rel, hit) {
    return api.listTrash().then(function (tr) {
      var pick = null
      var pickM = 0
      ;((tr && tr.items) || []).forEach(function (it) {
        if (!it || it.kind !== 'doc' || !it.relPath) return
        // 本地回收件 `_回收/<作品>/<文档>-14位戳.md` → 正文原 rel（本地口径，区别于云端 `回收/正文/...`）
        var segs = it.relPath.split('/')
        if (segs.length !== 3 || segs[0] !== '_回收') return
        var st = SYNC.stripRecycleStamp(segs[2])
        if (!st) return // 本地回收件必有 14 位戳；无戳件不参与自动还原
        var origin = segs[1] + '/' + st.base
        if (origin !== rel) return
        var m = Date.parse(it.mtime) || 0
        if (!pick || m > pickM) { pick = it; pickM = m }
      })
      if (pick) {
        // 本机回收有对应件：先本地还原（原位被占则 restoreTrash 拒绝 ⇒ fail-soft 等下轮）
        return api.restoreTrash(pick.relPath).then(function (rr) {
          if (!rr || !rr.ok) return false
          return syncAutoAlignRecord(rel, hit && hit.version).then(function () { return true })
        }).catch(function () { return false })
      }
      // 本机回收也没有：拉云端正文写本地（已存在不覆盖，与 pullAndOpen 同口径）
      return window.WCSyncNet.readDraft(rel).then(function (rd) {
        if (!rd || !rd.ok) return false
        return api.readDoc(rel).then(function (ex) {
          if (ex && ex.ok) return false // 本地其实已有（缓存过期）⇒ 不覆盖
          return api.writeDoc(rel, rd.content).then(function (wr) {
            if (!wr || !wr.ok) return false
            return syncAutoAlignRecord(rel, rd.version || (hit && hit.version)).then(function () { return true })
          })
        })
      }).catch(function () { return false })
    }).catch(function () { return false })
  }

  /** ⑯ 对齐成功后记共同祖先基线（version 为空则不改），并清该篇旧横幅去重 */
  function syncAutoAlignRecord(rel, version) {
    syncClearDismissed(rel)
    if (!version) return Promise.resolve()
    return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, rel, version, Date.now()))
  }

  function wireSync() {
    if (els.syncClose) els.syncClose.addEventListener('click', syncHideBanner)
    if (els.syncTakeRemote) els.syncTakeRemote.addEventListener('click', syncTakeRemote)
    if (els.syncKeepLocal) els.syncKeepLocal.addEventListener('click', syncKeepLocal)
    if (els.syncTrashLocal) els.syncTrashLocal.addEventListener('click', syncTrashLocal)
    if (els.syncSaveAs) els.syncSaveAs.addEventListener('click', syncSaveAs)
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
    /**
     * ⑮ 双通道版本对齐（读）：send-net 发送落盘前问持久 baseline 要 baseVersion。
     * 入参是**端点 rel**（带 `正文/` 前缀，send-net 的口径）；桥内转成本地 rel 再查。
     * 查不到 / 未就绪 ⇒ ''（调用方退回无 baseVersion 的创建式保存，安全）。
     */
    versionOf: function (remoteRel) {
      if (!SYNC || !syncReady()) return ''
      var localRel = SYNC.toLocalRel(remoteRel)
      if (!localRel) return ''
      return SYNC.baselineVersionOf(state.sync.baseline, localRel)
    },
    /**
     * ⑮ 双通道版本对齐（写）：send-net 任一路 clientZoneSave 成功（普通/force 覆盖/另存新 rel）
     * 后回填权威版本，避免另一通道拿着过期 baseVersion 下次保存撞 409 反复弹。
     * fire-and-forget：返回值调用方不等（落盘失败有 notice，内存 baseline 已先更新）。
     */
    noteSavedVersion: function (remoteRel, version) {
      if (!SYNC || !syncReady() || !version) return
      var localRel = SYNC.toLocalRel(remoteRel)
      if (!localRel) return
      syncClearDismissed(localRel) // 新落盘 ⇒ 旧横幅去重缓存作废（与 syncPush 成功同口径）
      return saveSyncBaseline(SYNC.updateBaseline(state.sync.baseline, localRel, version, Date.now()))
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
    /** relay 回程（方案 C）：是否在发送成功后等待创作教练建议；只有显式 false 才关（默认开，Task 9 落设置项） */
    waitResult: function () {
      var s = (state.settings && state.settings.send) || {}
      return s.waitResult !== false
    },
    /**
     * relay 回程（方案 C）：发送成功后启动创作教练建议轮询。
     * 只做三件事——切到右栏 proof tab、切到 coach 视图、把 requestId 交给 coach-net；
     * 🔴 不碰正文（改正文只能由 coach-net 的「应用」按钮经 __wcProofBridge.setText 走）。
     * 整段 try/catch：coach-net 没加载 / 切视图函数缺失都不能影响"已发送成功"这条主路径。
     */
    coachResult: function (requestId) {
      try {
        if (typeof boardSwitchTab === 'function') boardSwitchTab('proof')
        if (typeof coachShowView === 'function') coachShowView('coach')
        if (window.__wcCoachStart) window.__wcCoachStart({ requestId: requestId })
      } catch (e) {}
    },
    /** 状态条提示（成功/失败文案都走既有 notice ⇒ 沿用现有状态条机制） */
    notice: function (text, isError) { notice(text, isError) },
  }

  // ════════════════════════════════════════════════════════════════════════
  // §4 工具栏（2026-10-15 DSH 对齐）：🎯 教练手动入口 / ▾ 意图菜单 / 正文·预览分段 / 番茄 ⋯ 弹层
  // ════════════════════════════════════════════════════════════════════════

  // 🎯 手动入口：只做 coachResult 的前两个动作（切右板 proof tab + 切教练态），
  // 🔴 不调 __wcCoachStart —— 不发送、不启动轮询；面板内容由 coach-net 现状决定。
  function openCoachPanel() {
    if (typeof boardSwitchTab === 'function') boardSwitchTab('proof')
    if (typeof coachShowView === 'function') coachShowView('coach')
  }

  // 正文/预览分段高亮：预览段 ↔ 右板 preview tab（boardSwitchTab 切换时回调本函数）
  function syncViewSeg() {
    var onPreview = state.board && state.board.activeTab === 'preview'
    if (els.viewWrite) {
      els.viewWrite.classList.toggle('is-active', !onPreview)
      els.viewWrite.setAttribute('aria-pressed', onPreview ? 'false' : 'true')
    }
    if (els.viewPreview) {
      els.viewPreview.classList.toggle('is-active', onPreview)
      els.viewPreview.setAttribute('aria-pressed', onPreview ? 'true' : 'false')
    }
  }

  // ▾ 意图菜单（条目=设置 send.intents + 恒补「其他…」；不新增通道）
  function intentClose() {
    if (!els.intentMenu) return
    els.intentMenu.hidden = true
    if (els.sendCaret) els.sendCaret.setAttribute('aria-expanded', 'false')
  }
  function intentOpen() {
    if (!els.intentMenu || !els.sendCaret) return
    var list = (window.__wcSendBridge && window.__wcSendBridge.intents)
      ? window.__wcSendBridge.intents() : []
    var items = list.slice()
    items.push('__other__')
    els.intentMenu.textContent = ''
    items.forEach(function (label) {
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'w-intent-item'
      b.setAttribute('role', 'menuitem')
      b.textContent = label === '__other__' ? '其他…' : label
      b.dataset.intentValue = label
      b.addEventListener('click', function () { intentPick(label) })
      els.intentMenu.appendChild(b)
    })
    var r = els.sendCaret.getBoundingClientRect()
    els.intentMenu.style.top = Math.round(r.bottom + 4) + 'px'
    els.intentMenu.style.left = Math.round(r.left) + 'px'
    els.intentMenu.hidden = false
    els.sendCaret.setAttribute('aria-expanded', 'true')
  }
  function intentPick(value) {
    intentClose()
    // 复用 send-net 的唯一开窗路径：对 #w-send-full 派发 click（openSend('full')），
    // 再把弹窗内 #w-send-intent 预选为所选意图并派发 change（「其他…」由此露出手填行）。
    var full = document.getElementById('w-send-full')
    if (full) full.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    var sel = document.getElementById('w-send-intent')
    if (sel) {
      sel.value = value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  // 番茄 ⋯ 小弹层（R8：重置能力不丢，但不占胶囊常驻位）
  function pomoPopClose() {
    if (!els.pomoPop) return
    els.pomoPop.hidden = true
    if (els.pomoCaret) els.pomoCaret.setAttribute('aria-expanded', 'false')
  }
  function pomoPopOpen() {
    if (!els.pomoPop || !els.pomoCaret) return
    var r = els.pomoCaret.getBoundingClientRect()
    els.pomoPop.style.top = Math.round(r.bottom + 4) + 'px'
    els.pomoPop.style.left = Math.round(r.right - 168) + 'px' // 菜单宽 168，右缘对齐 caret
    els.pomoPop.hidden = false
    els.pomoCaret.setAttribute('aria-expanded', 'true')
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

  /** relay 回程（方案 C）：同口径让创作教练等待/建议作废——换上下文后绝不能对着错文档等结果或应用建议 */
  function coachReset() { if (window.__wcCoachReset) window.__wcCoachReset() }

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
  // 记录板（设计 docs/board-and-noveldb-design.md §1）
  //   笔记 / 待办：按 relPath 绑定文档，本地 config.json + 远端 进度/board/*.json
  //   预览：不绑文档，直接读客户端区正文。本段放在同步段之后（避开 sync-wiring 静态守卫区间）。
  // ════════════════════════════════════════════════════════════════════════
  var BOARD_NOTE_DEBOUNCE_MS = 1000 // 笔记本地落盘去抖（§1.5-5）
  var BOARD_FLUSH_DEBOUNCE_MS = 1500 // 待办变更后远端推送去抖
  var BOARD_LIST_TTL_MS = 20000 // 预览清单缓存 20s（§1.5-7）
  var BOARD_LIST_MAX = 200 // 预览清单最多 200 条

  function boardNet() { return window.WCSyncNet || null }

  /** 切 tab：pane hidden + is-active；瞬时态落盘（§1.4） */
  /** 子分段高亮跟随 state.board.activeProofView（只切 class，不碰面板 hidden——hidden 归 coachShowView 管） */
  function syncProofSubseg() {
    if (!els.proofSubsegItems || !els.proofSubsegItems.length) return
    Array.prototype.forEach.call(els.proofSubsegItems, function (b) {
      var on = b.getAttribute('data-proof-view') === state.board.activeProofView
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-pressed', on ? 'true' : 'false')
    })
  }

  /** 从「N 条…」/「敏感词 N 处」文本里读数；空文本=0（纯展示，不碰 net 内部状态） */
  function boardCountNum(el) {
    if (!el || !el.textContent) return 0
    var m = String(el.textContent).match(/\d+/)
    return m ? parseInt(m[0], 10) || 0 : 0
  }

  /** 校对 tab 角标：当前看不见的子态里有多少条结果（在该 tab 且该子态时不打扰） */
  function boardBadgeRefresh() {
    if (!els.proofBadge) return
    var nCoach = boardCountNum(els.coachCount)
    var nProof = boardCountNum(els.proofCount)
    var nSensitive = boardCountNum(els.sensitiveCount)
    var unseen
    if (state.board.activeTab === 'proof') {
      unseen = state.board.activeProofView === 'coach' ? nProof + nSensitive
        : state.board.activeProofView === 'sensitive' ? nCoach + nProof
        : nCoach + nSensitive
    } else {
      unseen = nCoach + nProof + nSensitive
    }
    els.proofBadge.hidden = unseen <= 0
    els.proofBadge.textContent = unseen > 99 ? '99+' : String(unseen)
  }

  /** 三个 count 文本任一变化 ⇒ 刷新角标（observer，无轮询；面板 hidden 时文本变化同样捕获） */
  function boardBadgeObserve() {
    if (typeof MutationObserver !== 'function') { boardBadgeRefresh(); return }
    var mo = new MutationObserver(function () { boardBadgeRefresh() })
    ;[els.proofCount, els.coachCount, els.sensitiveCount].forEach(function (el) {
      if (el) mo.observe(el, { childList: true, characterData: true, subtree: true })
    })
    boardBadgeRefresh()
  }

  /** 片语前缀（与按钮 data-note-phrase 对应；插入到笔记光标处，走既有 input 落盘链） */
  var BOARD_PHRASES = {
    inspire: '💡 灵感：',
    list: '□ ',
    outline: '# ',
  }
  function boardInsertNotePhrase(key) {
    var ta = els.boardNotes
    if (!ta || ta.disabled) return
    var prefix = BOARD_PHRASES[key]
    if (!prefix) return
    var start = ta.selectionStart != null ? ta.selectionStart : ta.value.length
    var end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length
    var before = ta.value.slice(0, start)
    var atLineStart = start === 0 || before.charAt(before.length - 1) === '\n'
    var insert = (atLineStart ? '' : '\n') + prefix
    ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end)
    var pos = start + insert.length
    ta.selectionStart = ta.selectionEnd = pos
    ta.focus()
    boardOnNoteInput() // 复用既有去抖落盘 + 标脏（不另造保存通道）
  }

  /** 待办时间标注：只用既有 createdAt，今天显 HH:MM、今年显 MM-DD、更早显 YYYY-MM-DD */
  function boardTodoTimeLabel(ts) {
    var n = Number(ts)
    if (!n) return ''
    var d = new Date(n)
    if (isNaN(d.getTime())) return ''
    function p2(x) { return (x < 10 ? '0' : '') + x }
    var now = new Date()
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
    if (sameDay) return p2(d.getHours()) + ':' + p2(d.getMinutes())
    if (d.getFullYear() === now.getFullYear()) return p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
  }

  function boardSwitchTab(name) {
    if (['notes', 'todos', 'proof', 'preview'].indexOf(name) < 0) return
    state.board.activeTab = name
    els.boardTabs.forEach(function (b) { b.setAttribute('aria-selected', b.classList.toggle('is-active', b.dataset.boardTab === name)) })
    Array.prototype.forEach.call(els.boardPanes, function (p) {
      p.hidden = p.getAttribute('data-board-pane') !== name
    })
    if (api && api.saveConfig) api.saveConfig({ board: { activeTab: name } })
    // 进预览 tab 才拉清单（TTL 内不重复请求）
    if (name === 'preview') boardPreviewList(false)
    syncViewSeg()
    if (name === 'proof') syncProofSubseg()
    boardBadgeRefresh()
  }

  /** 无当前文档 ⇒ 笔记/待办禁用（预览不绑文档，始终可用） */
  function boardRenderDisabled() {
    var noDoc = !state.current
    if (els.boardNotes) {
      els.boardNotes.disabled = noDoc
      if (noDoc) els.boardNotes.placeholder = '先打开一篇文档'
    }
    if (els.boardTodoInput) els.boardTodoInput.disabled = noDoc
  }

  /** 全量重画（init / 切文档后）：tab + 笔记 + 待办 + 禁用态 */
  function boardRenderAll() {
    boardSwitchTab(state.board.activeTab || 'notes')
    boardFillLocal(state.current ? state.current.relPath : null)
  }

  /** 本地数据即填（无远端往返；rel=null ⇒ 空白禁用态） */
  function boardFillLocal(rel) {
    var note = rel && state.board.notes[rel] ? state.board.notes[rel] : null
    var todos = rel && Array.isArray(state.board.todos[rel]) ? state.board.todos[rel] : []
    if (els.boardNotes && document.activeElement !== els.boardNotes) {
      els.boardNotes.value = note ? note.text : ''
    }
    boardRenderTodos(todos)
    boardRenderDisabled()
  }

  /** 待办列表渲染（条目少，整列重画最简单；复选框/删除按钮用 data 属性事件委托） */
  function boardRenderTodos(todos) {
    var ul = els.boardTodoList
    if (!ul) return
    ul.textContent = ''
    if (!state.current) {
      var empty = document.createElement('li')
      empty.className = 'w-board-empty'
      empty.textContent = '先打开一篇文档'
      ul.appendChild(empty)
      return
    }
    if (!todos.length) {
      var li = document.createElement('li')
      li.className = 'w-board-empty'
      li.textContent = '还没有待办，在上方输入框回车添加。'
      ul.appendChild(li)
      return
    }
    todos.forEach(function (t) {
      var li = document.createElement('li')
      li.className = 'w-board-todo-item' + (t.done ? ' is-done' : '')
      li.setAttribute('data-todo-id', t.id)

      var cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = t.done === true
      cb.setAttribute('data-todo-check', t.id)

      var span = document.createElement('span')
      span.className = 'w-board-todo-text'
      span.textContent = t.text

      var meta = document.createElement('span')
      meta.className = 'w-board-todo-meta'
      meta.textContent = boardTodoTimeLabel(t.createdAt)

      var del = document.createElement('button')
      del.type = 'button'
      del.className = 'w-board-todo-del'
      del.title = '删除'
      del.textContent = '✕'
      del.setAttribute('data-todo-del', t.id)

      li.appendChild(cb)
      li.appendChild(span)
      if (meta.textContent) li.appendChild(meta)
      li.appendChild(del)
      ul.appendChild(li)
    })
  }

  /** 笔记/待办本地落盘（只 patch 当前文档一条；main.js 按顶级键合并，不碰其它文档） */
  function boardSaveLocal(rel) {
    if (!rel || !api || !api.saveConfig) return Promise.resolve(null)
    var notes = {}
    if (state.board.notes[rel]) notes[rel] = state.board.notes[rel]
    var todos = {}
    todos[rel] = state.board.todos[rel] || []
    return api.saveConfig({ board: { notes: notes, todos: todos } }).catch(function (e) {
      console.warn('[board] saveConfig 失败：', e)
      return null
    })
  }

  /** 笔记 input：去抖 1s 落本地 + 标脏 + 去抖推远端 */
  function boardOnNoteInput() {
    if (!state.current) return
    var rel = state.current.relPath
    var now = Date.now()
    state.board.notes[rel] = { text: els.boardNotes.value, updatedAt: now }
    state.board.dirty[rel] = true
    if (state.board.noteTimer) clearTimeout(state.board.noteTimer)
    state.board.noteTimer = setTimeout(function () {
      state.board.noteTimer = null
      boardSaveLocal(rel)
      boardScheduleFlush()
    }, BOARD_NOTE_DEBOUNCE_MS)
  }

  /** 待办：回车新增（空串忽略；id 时戳 + 随机短串） */
  function boardOnTodoAdd() {
    if (!state.current) return
    var rel = state.current.relPath
    var text = (els.boardTodoInput.value || '').trim()
    if (!text) return
    var now = Date.now()
    var list = Array.isArray(state.board.todos[rel]) ? state.board.todos[rel] : []
    list.push({
      id: 't_' + now + '_' + Math.random().toString(36).slice(2, 7),
      text: text, done: false, createdAt: now, updatedAt: now,
    })
    state.board.todos[rel] = list
    els.boardTodoInput.value = ''
    boardRenderTodos(list)
    boardPersistTodos(rel)
  }

  /** 复选框切换完成态 */
  function boardOnTodoToggle(id, checked) {
    if (!state.current) return
    var rel = state.current.relPath
    var list = state.board.todos[rel]
    if (!list) return
    var item = null
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { item = list[i]; break }
    if (!item) return
    item.done = checked === true
    item.updatedAt = Date.now()
    boardRenderTodos(list)
    boardPersistTodos(rel)
  }

  /** 删除一条 */
  function boardOnTodoDelete(id) {
    if (!state.current) return
    var rel = state.current.relPath
    var list = state.board.todos[rel]
    if (!list) return
    state.board.todos[rel] = list.filter(function (t) { return t.id !== id })
    boardRenderTodos(state.board.todos[rel])
    boardPersistTodos(rel)
  }

  /** 待办即时落盘（不去抖）+ 标脏 + 远端去抖推 */
  function boardPersistTodos(rel) {
    state.board.dirty[rel] = true
    boardSaveLocal(rel)
    boardScheduleFlush()
  }

  /** 远端推送去抖（1.5s；笔记/待办的连续改动只发最后一份） */
  function boardScheduleFlush() {
    if (state.board.flushTimer) clearTimeout(state.board.flushTimer)
    state.board.flushTimer = setTimeout(function () {
      state.board.flushTimer = null
      if (state.current) boardFlushRemote(state.current.relPath)
    }, BOARD_FLUSH_DEBOUNCE_MS)
  }

  /**
   * 推一篇文档的记录板到远端（§1.3 payload）。409 ⇒ 状态栏轻提示、保留本地、本轮不自动合并。
   * @param {boolean} [immediate] 内部参数；调用方一般不直接用
   */
  function boardFlushRemote(rel) {
    var net = boardNet()
    if (!rel || !net || typeof net.saveBoard !== 'function') return Promise.resolve(null)
    var payload = {
      version: 1,
      relPath: rel,
      notes: state.board.notes[rel] || null,
      todos: Array.isArray(state.board.todos[rel]) ? state.board.todos[rel] : [],
    }
    return net.saveBoard(rel, payload).then(function (r) {
      if (r && r.ok) {
        state.board.dirty[rel] = false
        return r
      }
      if (r && r.conflict) {
        // 设计 §1.8：复用 baseVersion 闸；本轮不自动合并 ⇒ 只轻提示一次，本地原样保留
        syncNotice('记录板远端有冲突（本轮不自动合并）')
        return r
      }
      // 网络/其它失败：下次变更会再排队，不打断用户
      return r
    })
  }

  /** 切文档/关窗前给当前文档做一次收尾：清去抖、本地落盘、尽力推远端（不 await） */
  function boardFlushCurrent() {
    var rel = state.current ? state.current.relPath : null
    if (!rel) return
    if (state.board.noteTimer) {
      clearTimeout(state.board.noteTimer)
      state.board.noteTimer = null
      // 输入框里可能还有未落盘的文字 ⇒ 先收进 state
      if (els.boardNotes && state.board.notes[rel] && els.boardNotes.value !== state.board.notes[rel].text) {
        state.board.notes[rel] = { text: els.boardNotes.value, updatedAt: Date.now() }
        state.board.dirty[rel] = true
      }
    }
    if (state.board.dirty[rel]) {
      boardSaveLocal(rel)
      boardFlushRemote(rel)
    }
  }

  /**
   * 打开文档后：本地即填 + 异步拉远端。seq 令牌防切文档后旧响应回填；
   * 远端 updatedAt 更新 ⇒ 覆盖本地并回存 config（本地有未推脏数据时不覆盖）。
   */
  function boardLoadFor(rel) {
    var net = boardNet()
    boardFillLocal(rel)
    if (!rel || !net || typeof net.readBoard !== 'function') return
    var seq = ++state.board.seq
    net.readBoard(rel).then(function (r) {
      if (seq !== state.board.seq || !state.current || state.current.relPath !== rel) return // 已切走
      if (!r || !r.ok) {
        if (!state.board.warnOnce) {
          state.board.warnOnce = true
          console.warn('[board] 远端记录板读取失败：', r && r.error)
        }
        return
      }
      if (r.notFound || !r.json) return // 远端还没记过 ⇒ 保留本地
      var j = r.json
      var remoteNote = j.notes && typeof j.notes.text === 'string' ? j.notes : null
      var remoteTodos = Array.isArray(j.todos) ? j.todos : null
      var localNote = state.board.notes[rel]
      var localTodos = state.board.todos[rel]

      var noteChanged = false
      if (remoteNote && (!localNote || remoteNote.updatedAt > localNote.updatedAt) && !state.board.dirty[rel]) {
        state.board.notes[rel] = { text: remoteNote.text, updatedAt: Number(remoteNote.updatedAt) || Date.now() }
        noteChanged = true
      }
      var todoChanged = false
      if (remoteTodos && remoteTodos.length) {
        var remoteMax = remoteTodos.reduce(function (m, t) { return Math.max(m, Number(t.updatedAt) || 0) }, 0)
        var localMax = Array.isArray(localTodos)
          ? localTodos.reduce(function (m, t) { return Math.max(m, Number(t.updatedAt) || 0) }, 0)
          : 0
        if ((!localTodos || !localTodos.length || remoteMax > localMax) && !state.board.dirty[rel]) {
          state.board.todos[rel] = remoteTodos.filter(function (t) {
            return t && typeof t.id === 'string' && typeof t.text === 'string'
          }).map(function (t) {
            return { id: t.id, text: t.text, done: t.done === true, createdAt: Number(t.createdAt) || Date.now(), updatedAt: Number(t.updatedAt) || Date.now() }
          })
          todoChanged = true
        }
      }
      if (noteChanged || todoChanged) {
        boardSaveLocal(rel)
        boardFillLocal(rel)
      }
    }).catch(function (e) {
      console.warn('[board] 远端记录板读取异常：', e)
    })
  }

  /** 预览：列远端正文清单（20s TTL，mtime 倒序最多 200），筛得回本地 rel 的项 */
  function boardPreviewList(force) {
    var net = boardNet()
    var picker = els.boardPreviewPicker
    var body = els.boardPreviewBody
    if (!picker || !body) return
    if (!net || !window.WCSync) {
      body.textContent = '云端不可达，无法列出 AI 文档'
      return
    }
    var cache = state.board.previewCache
    var now = Date.now()
    if (!force && state.board.listLoading) return
    if (!force && cache.lastListAt && now - cache.lastListAt < BOARD_LIST_TTL_MS && picker.options.length) return

    state.board.listLoading = true
    body.textContent = '列表加载中…'
    net.listDrafts().then(function (r) {
      state.board.listLoading = false
      if (!r || !r.ok) {
        body.textContent = '云端不可达，无法列出 AI 文档'
        return
      }
      var entries = (r.data && (r.data.entries || r.data.items)) || []
      var rows = []
      entries.forEach(function (e) {
        if (!e || typeof e.relPath !== 'string') return
        var localRel = window.WCSync.toLocalRel(e.relPath) // 只有 正文/ 下的能换算回来
        if (!localRel) return
        rows.push({ relPath: e.relPath, localRel: localRel, mtime: e.mtime || 0 })
      })
      rows.sort(function (a, b) {
        // mtime 可能是 ISO 字符串也可能是数字时间戳，两种都兜住
        var ma = Date.parse(a.mtime) || Number(a.mtime) || 0
        var mb = Date.parse(b.mtime) || Number(b.mtime) || 0
        return mb - ma
      })
      rows = rows.slice(0, BOARD_LIST_MAX)

      picker.textContent = ''
      var ph = document.createElement('option')
      ph.value = ''
      ph.textContent = rows.length ? '选择一篇 AI 文档…' : '（暂无可预览的文档）'
      picker.appendChild(ph)
      rows.forEach(function (row) {
        var opt = document.createElement('option')
        opt.value = row.relPath
        opt.textContent = row.localRel
        picker.appendChild(opt)
      })
      state.board.previewCache = { lastRelPath: cache.lastRelPath || '', lastListAt: Date.now() }
      if (cache.lastRelPath) {
        // 回填上次选中（若仍在清单里）并加载
        Array.prototype.forEach.call(picker.options, function (o) { if (o.value === cache.lastRelPath) picker.value = cache.lastRelPath })
        if (picker.value === cache.lastRelPath) boardPreviewRead(cache.lastRelPath)
        else body.textContent = rows.length ? '请选择一篇文档预览。' : ''
      } else {
        body.textContent = rows.length ? '请选择一篇文档预览。' : ''
      }
    }).catch(function (e) {
      state.board.listLoading = false
      body.textContent = '云端不可达，无法列出 AI 文档'
      console.warn('[board] 预览清单异常：', e)
    })
  }

  /** 预览：读一篇远端正文（入参是远端 relPath，直接给 readDraft） */
  function boardPreviewRead(remoteRel) {
    var net = boardNet()
    var body = els.boardPreviewBody
    if (!body) return
    if (!remoteRel) { body.textContent = ''; return }
    state.board.previewCache.lastRelPath = remoteRel
    if (!net) { body.textContent = '云端不可达'; return }
    body.textContent = '读取中…'
    net.readDraft(window.WCSync.toLocalRel(remoteRel)).then(function (r) {
      if (!r || r.ok === false) {
        body.textContent = '读取失败：' + ((r && r.error) || '未知错误')
        return
      }
      body.textContent = r.content || '' // 纯文本，pre-wrap；不做 md 渲染（§1.5-7）
    }).catch(function (e) {
      body.textContent = '读取失败：' + String((e && e.message) || e)
    })
  }

  /** 记录板全部 DOM 事件（事件委托集中在 panel 容器） */
  function wireBoard() {
    if (!els.boardPanel) return
    els.boardPanel.addEventListener('click', function (e) {
      var sub = e.target.closest ? e.target.closest('[data-proof-view]') : null
      if (sub) { coachShowView(sub.getAttribute('data-proof-view')); return }
      var phrase = e.target.closest ? e.target.closest('[data-note-phrase]') : null
      if (phrase) { boardInsertNotePhrase(phrase.getAttribute('data-note-phrase')); return }
      var tab = e.target.closest ? e.target.closest('.w-board-tab') : null
      if (tab) { boardSwitchTab(tab.getAttribute('data-board-tab')); return }
      var delId = e.target.getAttribute && e.target.getAttribute('data-todo-del')
      if (delId) { boardOnTodoDelete(delId); return }
    })
    els.boardPanel.addEventListener('change', function (e) {
      var checkId = e.target.getAttribute && e.target.getAttribute('data-todo-check')
      if (checkId) { boardOnTodoToggle(checkId, e.target.checked); return }
      if (e.target === els.boardPreviewPicker) boardPreviewRead(e.target.value)
    })
    if (els.boardNotes) els.boardNotes.addEventListener('input', boardOnNoteInput)
    if (els.boardTodoInput) {
      els.boardTodoInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.keyCode === 13) {
          e.preventDefault()
          boardOnTodoAdd()
        }
      })
    }
    if (els.boardPreviewRefresh) els.boardPreviewRefresh.addEventListener('click', function () { boardPreviewList(true) })
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
    // ⑰ 左右栏独立收起 / 展开（分栏时按钮 disabled，点不到，这里也无需特判）
    if (els.collapseLeft) els.collapseLeft.addEventListener('click', function () { toggleCollapse('left') })
    if (els.collapseRight) els.collapseRight.addEventListener('click', function () { toggleCollapse('right') })
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
    if (els.coachOpen) els.coachOpen.addEventListener('click', openCoachPanel)
    if (els.viewWrite) els.viewWrite.addEventListener('click', function () {
      if (state.board && state.board.activeTab === 'preview') boardSwitchTab('notes')
      syncViewSeg(); Editor.focus()
    })
    if (els.viewPreview) els.viewPreview.addEventListener('click', function () { boardSwitchTab('preview') })
    if (els.sendCaret) els.sendCaret.addEventListener('click', function (e) {
      e.stopPropagation()
      if (els.intentMenu && !els.intentMenu.hidden) { intentClose(); return }
      intentOpen()
    })
    if (els.pomoCaret) els.pomoCaret.addEventListener('click', function (e) {
      e.stopPropagation()
      if (els.pomoPop && !els.pomoPop.hidden) { pomoPopClose(); return }
      pomoPopOpen()
    })
    // 时长设置…：打开设置弹窗并直达「番茄钟」类（settingsShowCat 为 Task 2 产出）
    if (els.pomoSettings) els.pomoSettings.addEventListener('click', function () {
      pomoPopClose()
      settingsOpen()
      settingsShowCat('pomodoro')
      if (els.setFocus) els.setFocus.focus()
    })
    // 点空白处收两个弹层（caret 自己已 stopPropagation，不会触发即关）
    document.addEventListener('click', function () { intentClose(); pomoPopClose() })
    if (els.intentMenu) els.intentMenu.addEventListener('click', function (e) { e.stopPropagation() })
    if (els.pomoPop) els.pomoPop.addEventListener('click', function (e) { e.stopPropagation() })

    // Ctrl/Cmd+S = 手动保存；Ctrl/Cmd+F = 查找条；Esc = 收查找条/设置弹层/「▾ 切换」菜单/导入模态
    window.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault()
        flush({ force: true, reason: 'manual' })
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && String(e.key).toLowerCase() === 'f') {
        e.preventDefault()
        searchOpen() // §4 搜全书（本机工作区 + 云端 正文/）
        return
      }
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'f') {
        e.preventDefault()
        findOpen() // ③ 查找/替换（写作页主导键；浏览器默认查找对长文写作不够用）
        return
      }
      if (e.key === 'Escape') {
        if (els.intentMenu && !els.intentMenu.hidden) { intentClose(); return }
        if (els.pomoPop && !els.pomoPop.hidden) { pomoPopClose(); return }
        // §4 搜全书浮层优先收（它盖在写作区上；同时 abort 在途云端请求）
        if (searchIsOpen()) { searchClose(); return }
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
    window.addEventListener('pagehide', function () { boardFlushCurrent(); flushSync('pagehide') })
    window.addEventListener('beforeunload', function () { boardFlushCurrent(); flushSync('beforeunload') })

    // 切到 [DSH] 页前 flush（切换本身由 shell.html 的 tab 逻辑负责，这里只补一个"离开前保存"）
    Array.prototype.forEach.call(document.querySelectorAll('.w-rail-item[data-page]'), function (t) {
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
      syncDrainPendingOps() // ⑭ §8：联网恢复后重放离线待办（不轮询，只接系统事件）
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
  // §3 敏感词扫描（设计 docs/board-and-noveldb-design.md §3）
  //   纯本地零网络：词库 window.WCSensitiveWords + AC 逻辑 window.WCSensitive（均渲染层资产）。
  //   结果与「✎ 校对」共用右栏「校对」tab，但 DOM 互斥（.w-proof / #w-sensitive-panel）：
  //   proofread-net.js 只认自己那几个 id，本模块只认 w-sensitive-*，两边都不用改对方。
  // ════════════════════════════════════════════════════════════════════════
  var SENSITIVE_CATEGORY_IDS = ['politics', 'violence', 'porn', 'gamble', 'drugs', 'fraud', 'ads', 'abuse', 'custom']
  // severity → 中文标签（色标 class 直接复用校对的 .w-proof-sev.is-*，CSS 零新增）
  var SENSITIVE_SEV_LABEL = { must: '必改', should: '建议', nice: '可选' }

  var sensitiveState = {
    hits: [],          // scanText 原始结果（已长词优先/忽略词剔除），按 start 升序
    activeCats: null,  // null = 全部分类；否则 Set（chips 当场筛选，不落盘）
    text: '',          // 本次扫描的正文快照（忽略词后增量重扫用同一份 ⇒ 与列表一致）
  }

  function sensitiveCore() { return window.WCSensitive || null }
  function sensitiveWordsData() { return window.WCSensitiveWords || null }

  /** @deprecated 兼容薄封装（coach-wiring 锁保留其形态）；新入口一律 coachShowView。 */
  /** 右栏「校对」tab 内的视图切换：proof（AI 校对）/ sensitive（敏感词）；切走只 hidden 不销毁。
   *  relay 回程（方案 C）加了第三态 coach：本函数只从敏感词链路调用，任何入口都把 coach 面板藏掉。 */
  function sensitiveShowView(name) {
    var pane = document.querySelector('.w-board-pane[data-board-pane="proof"]')
    var proofBox = pane ? pane.querySelector('.w-proof') : document.querySelector('.w-proof')
    if (proofBox) proofBox.hidden = (name === 'sensitive')
    if (els.sensitivePanel) els.sensitivePanel.hidden = (name !== 'sensitive')
    if (els.coachPanel) els.coachPanel.hidden = true
  }

  /** relay 回程（方案 C）：proof / sensitive / coach 三态互斥，切走只 hidden 不销毁（保留各面板状态） */
  function coachShowView(name) {
    var pane = document.querySelector('.w-board-pane[data-board-pane="proof"]')
    var proofBox = pane ? pane.querySelector('.w-proof') : document.querySelector('.w-proof')
    if (proofBox) proofBox.hidden = (name !== 'proof')
    if (els.sensitivePanel) els.sensitivePanel.hidden = (name !== 'sensitive')
    if (els.coachPanel) els.coachPanel.hidden = (name !== 'coach')
    if (['coach', 'proof', 'sensitive'].indexOf(name) >= 0) state.board.activeProofView = name
    syncProofSubseg()
    boardBadgeRefresh()
  }

  /** 当前生效的敏感词配置（state.settings 已在 getState / save-config 回填时更新） */
  function sensitiveConfig() {
    var s = (state.settings && state.settings.sensitive) || {}
    return {
      enabled: s.enabled || {},
      customWords: Array.isArray(s.customWords) ? s.customWords : [],
      ignoreWords: Array.isArray(s.ignoreWords) ? s.ignoreWords : [],
    }
  }

  /** 分类标签：优先词库数据包（label 与 UI 文案单一来源），兜底 id */
  function sensitiveCategoryLabel(id) {
    var data = sensitiveWordsData()
    var cats = data && data.categories
    if (Array.isArray(cats)) {
      for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i].label
    }
    return id === 'custom' ? '自定义词' : id
  }

  /** 跑一次本地扫描并渲染（#w-sensitive 点击 / 点「忽略此词」写回配置后调用） */
  function sensitiveRun() {
    var core = sensitiveCore()
    if (!core) {
      coachShowView('sensitive')
      boardSwitchTab('proof')
      if (els.sensitiveStatus) els.sensitiveStatus.textContent = '敏感词扫描不可用：sensitive.js 没加载（壳层白名单少了它？）'
      if (els.sensitiveList) els.sensitiveList.textContent = ''
      if (els.sensitiveCount) els.sensitiveCount.textContent = ''
      if (els.sensitiveChips) els.sensitiveChips.textContent = ''
      return
    }
    var cfg = sensitiveConfig()
    var text = Editor.getText() || ''
    var hits = core.scanText(text, {
      categories: sensitiveWordsData() ? sensitiveWordsData().categories : [],
      enabled: cfg.enabled,
      customWords: cfg.customWords,
      ignoreWords: cfg.ignoreWords,
    })
    sensitiveState.hits = hits
    sensitiveState.text = text
    sensitiveState.activeCats = null // 每次重跑 ⇒ chips 回到「全部」
    coachShowView('sensitive')
    boardSwitchTab('proof')
    sensitiveRenderChips()
    sensitiveRenderList()
  }

  /** 头部计数 + 分类 chips（chip 只筛本次结果；计数按**未筛选**口径，与标题一致） */
  function sensitiveRenderChips() {
    if (!els.sensitiveChips || !els.sensitiveCount) return
    var total = sensitiveState.hits.length
    els.sensitiveCount.textContent = total ? ('敏感词 ' + total + ' 处') : ''
    els.sensitiveChips.textContent = ''
    if (!total) {
      if (els.sensitiveStatus) {
        els.sensitiveStatus.textContent = '✓ 未发现敏感词（基于当前词库与开关）'
      }
      return
    }
    if (els.sensitiveStatus) els.sensitiveStatus.textContent = ''
    var counts = {}
    sensitiveState.hits.forEach(function (h) { counts[h.category] = (counts[h.category] || 0) + 1 })
    var ids = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] })
    // 「全部」chip
    els.sensitiveChips.appendChild(sensitiveBuildChip('__all__', '全部 ' + total, sensitiveState.activeCats === null))
    ids.forEach(function (id) {
      els.sensitiveChips.appendChild(
        sensitiveBuildChip(id, sensitiveCategoryLabel(id) + ' ' + counts[id],
          !!(sensitiveState.activeCats && sensitiveState.activeCats[id])),
      )
    })
  }

  function sensitiveBuildChip(id, label, active) {
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'w-sensitive-chip' + (active ? ' is-active' : '')
    b.textContent = label
    b.setAttribute('data-cat', id)
    b.addEventListener('click', function () {
      if (id === '__all__') sensitiveState.activeCats = null
      else {
        sensitiveState.activeCats = {}
        sensitiveState.activeCats[id] = true
      }
      sensitiveRenderChips()
      sensitiveRenderList()
    })
    return b
  }

  /** 结果列表：分类色标 + 命中词 + 句片段 + 〔定位〕〔忽略此词〕（无「应用修改」） */
  function sensitiveRenderList() {
    if (!els.sensitiveList) return
    els.sensitiveList.textContent = ''
    var core = sensitiveCore()
    var text = sensitiveState.text
    var hits = sensitiveState.hits.filter(function (h) {
      return !sensitiveState.activeCats || sensitiveState.activeCats[h.category]
    })
    hits.forEach(function (h) {
      var row = document.createElement('div')
      row.className = 'w-proof-item is-collapsed'

      var head = document.createElement('div')
      head.className = 'w-proof-item-head'
      var sev = document.createElement('span')
      sev.className = 'w-proof-sev is-' + h.severity
      sev.textContent = sensitiveCategoryLabel(h.category) + '（' + (SENSITIVE_SEV_LABEL[h.severity] || h.severity) + '）'
      head.appendChild(sev)
      var word = document.createElement('span')
      word.className = 'w-sensitive-word w-proof-card-title'
      word.textContent = h.word
      head.appendChild(word)
      var idx = document.createElement('span')
      idx.className = 'w-proof-card-idx'
      idx.textContent = (hits.indexOf(h) + 1) + '/' + hits.length
      head.appendChild(idx)
      var caret = document.createElement('span')
      caret.className = 'w-proof-card-caret'
      caret.textContent = '▶'
      head.appendChild(caret)
      row.appendChild(head)

      var frag = document.createElement('div')
      frag.className = 'w-proof-reason'
      // snippetAround 已按是否截到文首/文末自带省略号，不重复包
      frag.textContent = core.snippetAround(text, h.start, h.end)
      row.appendChild(frag)

      var acts = document.createElement('div')
      acts.className = 'w-proof-acts'
      var go = document.createElement('button')
      go.className = 'w-mini'
      go.type = 'button'
      go.textContent = '定位'
      go.title = '选中正文里这个词并滚到视野内（不改正文）'
      go.addEventListener('click', function (e) {
        e.stopPropagation()
        row.classList.remove('is-collapsed')
        Editor.focus()
        Editor.selectOffsets(h.start, h.end)
        Editor.scrollSelectionIntoView()
      })
      var skip = document.createElement('button')
      skip.className = 'w-mini'
      skip.type = 'button'
      skip.textContent = '忽略此词'
      skip.title = '加入忽略词表（落盘），以后扫描不再报这个词'
      skip.addEventListener('click', function (e) {
        e.stopPropagation()
        sensitiveIgnoreWord(h.word)
      })
      row.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.w-proof-acts')) return
        row.classList.toggle('is-collapsed')
        Editor.focus()
        Editor.selectOffsets(h.start, h.end)
        Editor.scrollSelectionIntoView()
      })
      acts.appendChild(go)
      acts.appendChild(skip)
      row.appendChild(acts)

      els.sensitiveList.appendChild(row)
    })
  }

  /** 点「忽略此词」：写回 config.sensitive.ignoreWords（主进程去重归一）⇒ 成功后用同一份正文增量重扫 */
  function sensitiveIgnoreWord(word) {
    var cfg = sensitiveConfig()
    if (cfg.ignoreWords.indexOf(word) >= 0) { sensitiveRun(); return }
    saveSettings({ sensitive: { ignoreWords: cfg.ignoreWords.concat([word]) } }).then(function (res) {
      if (res && res.ok) sensitiveRun()
    })
  }

  function wireSensitive() {
    if (els.sensitiveBtn) {
      els.sensitiveBtn.addEventListener('click', function () { sensitiveRun() })
    }
    // 用户点「✎ 校对」⇒ proofread-net 跑校对；这里把右栏视图切回 .w-proof（若停在敏感词/教练视图）。
    // capture 阶段先切视图，proofread-net 的监听照常运行，两边互不知道对方。
    var proofBtn = document.getElementById('w-proof')
    if (proofBtn) {
      proofBtn.addEventListener('click', function () { coachShowView('proof') }, true)
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // §4 全站内容搜索（设计 docs/board-and-noveldb-design.md §4）
  //   本机：listWorkspace → readDoc 遍历（mtime 内存缓存）；
  //   云端：WCSyncNet.listDrafts → 并发 6 readDraft（version 内存缓存，signal 可取消）；
  //   匹配全在渲染层跑 window.WCSearch 纯函数；同 relPath 本地优先；全局 500 命中硬上限。
  // ════════════════════════════════════════════════════════════════════════
  var SEARCH_DEBOUNCE_MS = 300
  var SEARCH_REMOTE_CONCURRENCY = 6
  var SEARCH_MIN_QUERY = 2 // ≤1 字符不发起搜索（§4.7）

  // 内存缓存：var 声明（refreshTree 里会清空 local 缓存，需在同一函数作用域可见）
  var searchLocalCache = Object.create(null)  // {relPath:{mtime, content}}
  var searchRemoteCache = Object.create(null) // {relPath:{version, content}}

  var searchState = {
    seq: 0,            // 每轮搜索自增；旧轮结果一律丢弃
    abort: null,       // 当前轮的 AbortController（云端 fetch 用）
    debounce: 0,       // setTimeout 句柄
    items: [],         // mergeResults 后的结果（点击定位取 hits[0]）
    scope: 'all',
  }

  function searchCore() { return window.WCSearch || null }

  function searchIsOpen() { return !!(els.searchView && !els.searchView.hidden) }

  function searchScopeVal() {
    var v = 'all'
    Array.prototype.forEach.call(els.searchScope, function (r) { if (r.checked) v = r.value })
    return v
  }

  function searchOptions() {
    return { caseSensitive: !!(els.searchCase && els.searchCase.checked) }
  }

  function searchOpen() {
    if (!els.searchView) return
    els.searchView.hidden = false
    if (els.searchInput) {
      els.searchInput.focus()
      els.searchInput.select()
    }
  }

  function searchClose() {
    if (!els.searchView) return
    clearTimeout(searchState.debounce)
    searchState.seq += 1 // 在途轮作废（本地遍历靠 seq 丢弃；云端 fetch 走 abort）
    if (searchState.abort) { try { searchState.abort.abort() } catch (e) { /* noop */ } }
    searchState.abort = null
    els.searchView.hidden = true
  }

  function searchSetProgress(text, visible) {
    if (!els.searchProgress) return
    els.searchProgress.hidden = !visible
    if (text != null) els.searchProgress.textContent = text
  }

  /** 收集本机工作区全部文档（{relPath, mtime}，平铺作品） */
  function searchListLocalDocs() {
    var docs = []
    ;(state.works || []).forEach(function (w) {
      ;(w.docs || []).forEach(function (d) {
        if (d && d.relPath) docs.push({ relPath: d.relPath, mtime: d.mtime })
      })
    })
    return docs
  }

  /** 读一篇本地正文（mtime 内存缓存，mtime 未变不重读） */
  function searchReadLocalCached(relPath, mtime) {
    var c = searchLocalCache[relPath]
    if (c && String(c.mtime) === String(mtime)) return Promise.resolve(c.content)
    return api.readDoc(relPath).then(function (r) {
      if (r && r.ok) {
        searchLocalCache[relPath] = { mtime: r.mtime != null ? r.mtime : mtime, content: r.content }
        return r.content
      }
      return null
    }, function () { return null })
  }

  /**
   * 扫本机工作区。
   * @returns {Promise<{results:Array, unknown:boolean}>}
   */
  function searchRunLocal(query, opts, seq, budgetRef) {
    var core = searchCore()
    var docs = searchListLocalDocs()
    var results = []
    var chain = Promise.resolve()
    docs.forEach(function (d) {
      chain = chain.then(function () {
        if (seq !== searchState.seq) return // 已被新查询/关闭取代
        return searchReadLocalCached(d.relPath, d.mtime).then(function (content) {
          if (content == null || seq !== searchState.seq) return
          if (budgetRef.left <= 0) return
          var r = core.matchDoc(d.relPath, content, query, {
            caseSensitive: opts.caseSensitive,
            budget: budgetRef.left,
          })
          if (r && !r.error && r.count) {
            results.push(r)
            budgetRef.left -= r.count
          }
        })
      })
    })
    return chain.then(function () { return { results: results, unknown: false, total: docs.length } })
  }

  /** 并发上限 concurrency 的任务队列；onProgress(done,total) 每完成一个任务回调一次 */
  function searchRunQueue(tasks, concurrency, onProgress) {
    var next = 0
    var done = 0
    var total = tasks.length
    var workers = []
    function run() {
      if (next >= tasks.length) return Promise.resolve()
      var idx = next++
      return tasks[idx]().then(function () {
        done += 1
        if (onProgress) onProgress(done, total)
        return run()
      })
    }
    for (var i = 0; i < Math.max(1, concurrency); i++) workers.push(run())
    return Promise.all(workers)
  }

  /** 读一篇云端正文（version 内存缓存；404/失败返回 null，不中断整搜） */
  function searchReadRemoteCached(relPath, version, signal) {
    var c = searchRemoteCache[relPath]
    if (c && c.version === version && version !== '') return Promise.resolve(c.content)
    return window.WCSyncNet.readDraft(relPath, { signal: signal }).then(function (r) {
      if (r && r.ok) {
        searchRemoteCache[relPath] = { version: r.version || '', content: r.content }
        return r.content
      }
      return null
    }, function () { return null })
  }

  /**
   * 扫云端 正文/。
   * @returns {Promise<{results:Array, unknown:boolean, failed:number, total:number}>}
   *   unknown=true 表示清单不可达（调用方降级为仅本机 + 提示）。
   */
  function searchRunRemote(query, opts, seq, budgetRef, abort) {
    var core = searchCore()
    var failed = 0
    return window.WCSyncNet.listDrafts({ signal: abort.signal }).then(function (lr) {
      if (seq !== searchState.seq) return { results: [], unknown: true, failed: 0, total: 0 }
      if (!lr || !lr.ok) return { results: [], unknown: true, failed: 0, total: 0 }
      var idx = SYNC.indexList(lr.data)
      if (!idx.known) return { results: [], unknown: true, failed: 0, total: 0 }
      var rels = Object.keys(idx.byRel)
      var results = []
      var signal = abort.signal

      function onProgress(done, total) {
        if (seq !== searchState.seq) return
        searchSetProgress('正在索引云端 ' + done + '/' + total +
          (failed ? '（' + failed + ' 篇读取失败）' : '') + ' …', true)
      }

      var tasks = rels.map(function (rel) {
        return function () {
          if (seq !== searchState.seq || signal.aborted || budgetRef.left <= 0) return
          var meta = idx.byRel[rel]
          return searchReadRemoteCached(rel, meta.version, signal).then(function (content) {
            if (content == null) { failed += 1; return }
            if (seq !== searchState.seq || budgetRef.left <= 0) return
            var r = core.matchDoc(rel, content, query, {
              caseSensitive: opts.caseSensitive,
              budget: budgetRef.left,
            })
            if (r && !r.error && r.count) {
              results.push(r)
              budgetRef.left -= r.count
            }
          }, function () { failed += 1 })
        }
      })

      return searchRunQueue(tasks, SEARCH_REMOTE_CONCURRENCY, onProgress).then(function () {
        return { results: results, unknown: false, failed: failed, total: rels.length }
      })
    }, function () { return { results: [], unknown: true, failed: 0, total: 0 } })
  }

  /**
   * §6.7 搜索度量埋点（仅本地日志、不上报）。
   * 走 console.error 是因为主进程 console-message 钩子只把 error 级落盘到
   * <userData>/logs/client.log；只记结构化数字（耗时/扫描数/命中数/作用域/可达性），
   * 绝不带检索词，避免 query 或正文片段进日志。异常一律吞掉，不影响搜索主路径。
   */
  function searchEmitMetric(m) {
    console.error('[wc][search-metric] ' +
      'ms=' + m.ms +
      ' scope=' + m.scope +
      ' localDocs=' + m.localDocs +
      ' remoteDocs=' + m.remoteDocs +
      ' remoteFailed=' + m.remoteFailed +
      ' remoteUnknown=' + m.remoteUnknown +
      ' items=' + m.items +
      ' hits=' + m.hits +
      ' capped=' + m.capped)
  }

  /** 一轮搜索的总入口（debounce 后调用） */
  function searchExecute() {
    var core = searchCore()
    if (!core) {
      searchSetProgress('搜索不可用：search-core.js 没加载（壳层白名单少了它？）', true)
      if (els.searchResults) els.searchResults.textContent = ''
      return
    }
    var query = (els.searchInput && els.searchInput.value || '').trim()
    if (query.length < SEARCH_MIN_QUERY) {
      searchSetProgress('', false)
      if (els.searchResults) els.searchResults.textContent = ''
      searchState.items = []
      return
    }
    var opts = searchOptions()
    // 非法正则（一期 UI 不暴露 regex，但 matchDoc 仍可能给 error）⇒ 友好提示
    var probe = core.buildRegex(query, opts)
    if (probe.error) { searchSetProgress(probe.error, true); return }

    var seq = ++searchState.seq
    if (searchState.abort) { try { searchState.abort.abort() } catch (e) { /* noop */ } }
    var abort = new AbortController()
    searchState.abort = abort
    var scope = searchScopeVal()
    searchState.scope = scope

    var budgetRef = { left: core.GLOBAL_HIT_CAP }
    var localP = (scope === 'remote') ? Promise.resolve({ results: [], unknown: false })
      : searchRunLocal(query, opts, seq, budgetRef)
    var remoteP = (scope === 'local')
      ? Promise.resolve({ results: [], unknown: false, failed: 0, total: 0 })
      : searchRunRemote(query, opts, seq, budgetRef, abort)

    searchSetProgress(scope === 'remote' ? '正在索引云端…' : '正在搜索本机…', true)

    // §6.7 度量起点：一轮墙钟耗时（本机+云端并发整体），用于 P95>800ms 门槛判定
    var searchT0 = performance.now()
    Promise.all([localP, remoteP]).then(function (rs) {
      if (seq !== searchState.seq) return // 旧轮结果丢弃
      var loc = rs[0]
      var rem = rs[1] || { results: [], unknown: false, failed: 0, total: 0 }
      var merged = core.mergeResults(loc.results, rem.results)
      searchState.items = merged.items
      searchRender(merged, rem, scope)
      // §6.7 本地埋点：只记数字不记 query；埋点失败绝不影响搜索结果
      try {
        searchEmitMetric({
          ms: Math.max(0, Math.round(performance.now() - searchT0)),
          scope: scope,
          localDocs: loc.total || 0,
          remoteDocs: rem.total || 0,
          remoteFailed: rem.failed || 0,
          remoteUnknown: !!rem.unknown,
          items: merged.items.length,
          hits: merged.totalHits,
          capped: !!merged.capped,
        })
      } catch (e) { /* 埋点不可影响主路径 */ }
    })
  }

  function searchSchedule() {
    clearTimeout(searchState.debounce)
    searchState.debounce = setTimeout(searchExecute, SEARCH_DEBOUNCE_MS)
  }

  /** 渲染进度行 + 结果列表 */
  function searchRender(merged, remote, scope) {
    var notes = []
    if (scope !== 'local' && remote.unknown) notes.push('云端列表不可达，已只搜本机')
    if (remote.failed > 0) notes.push(remote.failed + ' 篇云端读取失败')
    if (merged.capped) notes.push('结果过多，仅显示前 ' + searchCore().GLOBAL_HIT_CAP + ' 处，请细化关键词')

    var docCount = merged.items.length
    var head = docCount
      ? ('命中 ' + merged.totalHits + ' 处 / ' + docCount + ' 篇' +
         (scope === 'all' ? '（本机 ' + merged.items.filter(function (x) { return x.source === 'local' }).length +
           ' 篇，云端 ' + merged.items.filter(function (x) { return x.source === 'remote' }).length + ' 篇）' : ''))
      : '没有命中'
    searchSetProgress(head + (notes.length ? '　—　' + notes.join('；') : ''), true)

    if (!els.searchResults) return
    els.searchResults.textContent = ''
    merged.items.forEach(function (it) {
      els.searchResults.appendChild(searchBuildDoc(it))
    })
  }

  function searchEl(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  /** 一篇文档的结果卡：标题行（relPath + 命中数 + 来源）+ 前 3 片段（mark 高亮） */
  function searchBuildDoc(it) {
    var card = searchEl('div', 'w-search-doc')

    var head = searchEl('div', 'w-search-doc-head')
    var title = searchEl('span', 'w-search-doc-path', it.relPath)
    head.appendChild(title)
    head.appendChild(searchEl('span', 'w-search-doc-count', String(it.count)))
    head.appendChild(searchEl('span', 'w-search-doc-src is-' + it.source,
      it.source === 'local' ? '本机' : '云端'))
    card.appendChild(head)

    it.fragments.forEach(function (f) {
      var frag = searchEl('div', 'w-search-frag')
      frag.appendChild(searchEl('span', 'w-search-frag-ctx', f.before))
      frag.appendChild(searchEl('mark', 'w-search-mark', f.hit))
      frag.appendChild(searchEl('span', 'w-search-frag-ctx', f.after))
      card.appendChild(frag)
    })

    // 点卡片：本机有 → selectDoc 后定位首处；仅云端 → pullAndOpen（拉到本地再打开）后定位。
    // scope=remote 时同路径本地件不会参与 merge ⇒ 来源标可能是 remote 但树里已有，按树再判一次
    // （pullAndOpen 对"本地已存在"是 fail-closed 中止，不会替我们打开）。
    card.addEventListener('click', function () {
      var h = it.hits && it.hits[0]
      var locate = h ? function () {
        searchClose()
        Editor.focus()
        Editor.selectOffsets(h.start, h.end)
        Editor.scrollSelectionIntoView()
      } : function () { searchClose() }
      var existsLocal = searchListLocalDocs().some(function (d) { return d.relPath === it.relPath })
      if (it.source === 'local' || existsLocal) selectDoc({ relPath: it.relPath }, locate)
      else pullAndOpen(it.relPath, locate)
    })

    return card
  }

  function wireSearch() {
    if (els.searchOpenBtn) els.searchOpenBtn.addEventListener('click', searchOpen)
    if (els.searchClose) els.searchClose.addEventListener('click', searchClose)
    if (els.searchInput) {
      els.searchInput.addEventListener('input', searchSchedule)
      // 回车立即搜（不等 debounce）
      els.searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchState.debounce); searchExecute() }
      })
    }
    if (els.searchCase) els.searchCase.addEventListener('change', searchSchedule)
    Array.prototype.forEach.call(els.searchScope, function (r) {
      r.addEventListener('change', searchSchedule)
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
    wireBoard() // 记录板（§1）：tab / 笔记 / 待办 / 预览事件
    boardBadgeObserve() // Ⓓ 校对 tab 红色角标（observer，无轮询）
    wireSensitive() // §3 敏感词：工具栏按钮 + 右栏敏感词面板（纯本地）
    wireSearch() // §4 搜全书：浮层开关 / 输入 debounce / 范围切换（本机+云端遍历）

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

        // ⑰ 左右栏收起偏好（必须先于 renderSplit 回填：renderSplit 末尾的 renderPanels 读它）
        if (st.ui) {
          state.ui.collapseLeft = st.ui.collapseLeft === true
          state.ui.collapseRight = st.ui.collapseRight === true
        }
        // ⑥ CR-6 分栏：开关与比例（从配置回填；非法值当场夹紧，不信任磁盘上的值）
        if (st.ui && st.ui.split && typeof st.ui.split === 'object') {
          state.split.on = st.ui.split.on === true
          state.split.ratio = clampRatio(st.ui.split.ratio)
        }
        // ⑥ B5：校对专用会话 id（主进程已按 `session-…` 形状归一 ⇒ 这里直接采信）
        if (st.proofread && typeof st.proofread.sessionId === 'string') {
          state.proofreadSessionId = st.proofread.sessionId
        }
        // 记录板（§1）：主进程已归一化 ⇒ 直接采信；渲染当前 tab 与空态（不自动展开右栏）
        if (st.board) {
          state.board.activeTab = st.board.activeTab || 'notes'
          state.board.notes = st.board.notes || {}
          state.board.todos = st.board.todos || {}
          state.board.previewCache = st.board.previewCache || {}
        }
        boardRenderAll()
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
