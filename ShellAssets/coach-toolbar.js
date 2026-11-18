'use strict'

// ============================================================================
// 创作教练 · 选中浮动 AI 工具条「按权限挂载」纯逻辑（2026-11-13，对话职责细分 P4）
//
// 定位：**零依赖、可被 node 直接 require、也可被壳页当 <script> 加载** 的 UMD 模块
//   （写法与 coach-role.js / send.js 完全同口径）。只放判定与文案拼装，不碰 DOM、
//   不触网、不读盘 ⇒ node 直跑单测；DOM/接线在 coach-toolbar-net.js。
//
// 设计依据：《设计_创作教练对话职责细分架构_2026-11-13》§5「未来 AI 功能按权限挂载」。
//   选中浮动工具条（润色/改写/扩写/缩写/提问）原本是**无权限身份的自由文本通道**，
//   且与校对共用 sessionId，最易绕过四权限成为新漂移口。本模块把五个动作逐一钉到权限上：
//     · 润色 polish / 改写 rewrite / 缩写 condense → 编辑 editor
//     · 扩写 expand → 讨论者 discussor（高危：强制「篇幅代价」确认）
//     · 提问 ask    → 无固定权限，入口先选身份（reader/discussor/instructor，不默认）
//   UI 纪律（§5，2026-11-13 用户拍板调整）：按「读者提问 / 编辑改字句 / 讨论者动结构」三组排列，
//   **每个身份只渲染其可用动作**——越权动作直接不出现（不再置灰占位），切换身份即换一套按钮；
//   服务端 writing-coach permission.js 硬闸始终兜底，客户端隐藏只是 UX，不是安全边界。
//
// 🔴 硬约束（与服务端 permission.js / 设计硬规则对齐）：
//   ① 缺省身份 = reader，非法/未知身份一律回落 reader；proofread 不在对话工具条内，亦回落 reader；
//   ② 越权动作**不渲染**（只暴露当前身份有权做的活，按角色分开），服务端硬闸仍独立兜底；
//   ③ 所有派发消息**必须带【身份】权限卡**，把自由文本通道重新挂回四权限；
//   ④ 本模块**绝不自动携带破例口令** overrideToken（红线：口令只能由用户显式确认）；
//   ⑤ 只产出消息文案与判定结果，**绝不自动改正文**（这是真正的铁律：结果只给候选/回显进面板，
//      写回正文只能由用户手动点「应用」；发送本身可由用户在浮动条内点按钮直接发出，无需弹窗确认）；
//   ⑥ 字数口径 = 去所有空白字符数（设计 F1），并标注单位，杜绝「字节当字数」。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCCoachToolbar = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  // 四个对话身份（与 coach-role.js / 服务端 permission.js 对齐；proofread 走独立校对通道，不在此列）。
  var ROLES = ['reader', 'editor', 'discussor', 'instructor']
  var DEFAULT_ROLE = 'reader'

  // 身份 → 中文权限牌文案（与服务端 ROLES.label 同源口径）。
  var ROLE_LABELS = {
    reader: '读者',
    editor: '编辑',
    discussor: '讨论者',
    instructor: '指导',
  }

  /** 身份归一：trim + 小写；非四权限身份（含 proofread/非法值/空）一律回落 reader。 */
  function normalizeRole(role) {
    var r = String(role == null ? '' : role).trim().toLowerCase()
    return ROLES.indexOf(r) >= 0 ? r : DEFAULT_ROLE
  }

  /** 权限牌：【读者】/【编辑】/【讨论者】/【指导】。 */
  function permissionTag(role) {
    return '【' + ROLE_LABELS[normalizeRole(role)] + '】'
  }

  // ── 五个工具条动作（§5 表）────────────────────────────────────────────────
  // role：固定归属权限；ask 为 null（无固定权限，运行时先选身份）。
  // group：UI 三组排列口径；highRisk：是否强制前置确认（目前仅扩写）。
  var ACTIONS = [
    { id: 'ask', label: '提问', group: 'ask', role: null, highRisk: false,
      hint: '先选身份：读者会卡吗 / 讨论者值不值得加这条线 / 指导这一稿练什么' },
    { id: 'polish', label: '润色', group: 'edit', role: 'editor', highRisk: false,
      hint: '不改结构/篇幅；结果进面板、手动替换选中段，绝不自动写回' },
    { id: 'rewrite', label: '改写', group: 'edit', role: 'editor', highRisk: false,
      hint: '仅选中段；结果进面板、手动替换选中段，绝不自动写回' },
    { id: 'condense', label: '缩写', group: 'edit', role: 'editor', highRisk: false,
      hint: '减字数仍需核对是否削弱母题/伏笔' },
    { id: 'expand', label: '扩写', group: 'structure', role: 'discussor', highRisk: true,
      hint: '高危：直接增字数、最易冲锚，发送前强制确认「篇幅代价」' },
  ]

  // UI 三组（§5 纪律：读者提问 / 编辑改字句 / 讨论者动结构），顺序即渲染顺序。
  var GROUPS = [
    { id: 'ask', label: '读者提问' },
    { id: 'edit', label: '编辑改字句' },
    { id: 'structure', label: '讨论者动结构' },
  ]

  // 提问动作可选身份（§5：读者/讨论者/指导三类问法；不默认、不含编辑——编辑是动手改字不是提问）。
  var ASK_ROLES = ['reader', 'discussor', 'instructor']

  var ACTION_IDS = ACTIONS.map(function (a) { return a.id })

  function getAction(actionId) {
    var id = String(actionId == null ? '' : actionId)
    for (var i = 0; i < ACTIONS.length; i += 1) {
      if (ACTIONS[i].id === id) return ACTIONS[i]
    }
    return null
  }

  /**
   * 单个动作在当前身份下的可用态。
   * @returns {'pick-role'|'allowed'|'denied'}
   *   pick-role = 提问：无固定权限，需先选身份（选完即 allowed）；
   *   allowed   = 当前身份与动作归属一致；
   *   denied    = 身份不符，该动作在当前身份下不渲染（allowedActions 直接剔除，不置灰占位）；
   *               denyMessage 仍保留为判定 API，供需要显式说明的调用方取用（服务端硬闸独立兜底）。
   */
  function actionState(actionId, role) {
    var act = getAction(actionId)
    if (!act) return 'denied'
    if (!act.role) return 'pick-role'
    return normalizeRole(role) === act.role ? 'allowed' : 'denied'
  }

  /**
   * 某身份下「实际要渲染」的动作清单（2026-11-13 用户拍板：按角色只显示可用项）。
   * 保持 ACTIONS 原顺序，剔除 actionState==='denied' 的越权项（不置灰占位，直接不渲染）；
   * 'allowed' 与 'pick-role'（提问）都保留。纯函数，接线层渲染与单测共用。
   * 注意：这只决定客户端可见面，服务端 writing-coach permission.js 硬闸独立兜底。
   */
  function allowedActions(role) {
    var r = normalizeRole(role)
    return ACTIONS.filter(function (act) { return actionState(act.id, r) !== 'denied' })
  }

  /** 某分组在某身份下是否还有可渲染动作（整组被剔光 ⇒ 连分组标签一起不渲染）。 */
  function groupHasAllowed(groupId, role) {
    return allowedActions(role).some(function (act) { return act.group === groupId })
  }

  /** 动作是否需要当前身份（denied 时用于置灰 + 提示）。未知动作返回 ''。 */
  function requiredRoleOf(actionId) {
    var act = getAction(actionId)
    return act && act.role ? act.role : ''
  }

  /**
   * 越权提示（§4「显式派发」口径，与服务端 guardToolCall.denyMessage 同风格但不带口令）。
   * 工具条是 UI 层闸门，不在这里提供破例入口（破例口令只能由用户在别处显式给出）。
   */
  function denyMessage(actionId, role) {
    var act = getAction(actionId)
    if (!act || !act.role) return ''
    var required = ROLE_LABELS[act.role]
    var current = ROLE_LABELS[normalizeRole(role)]
    return '「' + act.label + '」属于【' + required + '】权限，请先把身份切换到【' + required +
      '】再派发（当前身份：【' + current + '】）。'
  }

  /** 字数（F1）：去所有空白字符后的字符数，单位「字」。 */
  function countChars(text) {
    return String(text == null ? '' : text).replace(/\s/g, '').length
  }

  /**
   * 扩写「篇幅代价」预估（§5 扩写强制确认 + §7 篇幅偏离 ≤ +20%）。
   * @param {object} p
   * @param {string} p.selectedText 选中段（要扩写的那段）
   * @param {string} [p.anchorText] 锚定全篇（用于判断是否突破 +20%）；缺省则只给预估增量、无法判锚
   * @param {number} [p.ratio] 预估扩写比例（相对选中段字数），默认 0.3（+30%）
   * @returns {{selectedChars:number, estimatedAdd:number, anchorChars:number,
   *            projectedAnchorChars:number, anchorThreshold:number, breaksAnchor:boolean,
   *            canJudgeAnchor:boolean, unit:string}}
   *   全部用 F1 字数口径；canJudgeAnchor=false 时 breaksAnchor 恒 false（没有锚不能瞎报）。
   */
  function estimateExpandCost(p) {
    var input = p && typeof p === 'object' ? p : {}
    var ratio = typeof input.ratio === 'number' && isFinite(input.ratio) && input.ratio > 0 ? input.ratio : 0.3
    var selectedChars = countChars(input.selectedText)
    var estimatedAdd = Math.round(selectedChars * ratio)
    var anchorChars = countChars(input.anchorText)
    var canJudgeAnchor = anchorChars > 0
    var anchorThreshold = canJudgeAnchor ? Math.round(anchorChars * 1.2) : 0
    var projectedAnchorChars = canJudgeAnchor ? anchorChars + estimatedAdd : 0
    return {
      selectedChars: selectedChars,
      estimatedAdd: estimatedAdd,
      anchorChars: anchorChars,
      projectedAnchorChars: projectedAnchorChars,
      anchorThreshold: anchorThreshold,
      // 仅在有锚可判时才可能 true；无锚不报「突破」，交给用户结合自己的篇幅账判断。
      breaksAnchor: canJudgeAnchor && projectedAnchorChars > anchorThreshold,
      canJudgeAnchor: canJudgeAnchor,
      unit: '字',
    }
  }

  /**
   * 组装带【身份】权限卡的派发消息（把自由文本通道重新挂回四权限）。
   * 统一结构：第一行权限卡 + 动作指令；空行后用三引号内联选中段（与 send.js 同惯例）；
   * 提问动作再前置用户的问题。
   * 🔑 首行【身份】权限卡同时是本通道的**身份路由载体**：relay 不消费 sessionId（见
   *   coach-toolbar-net.js 文件头 P4c 说明），服务端据这张卡把请求挂回对应权限并做硬闸校验。
   * @param {object} p
   * @param {string} p.actionId 动作 id
   * @param {string} p.role 派发身份（ask 为用户选定的身份；其余应与动作归属一致，调用方先过 actionState）
   * @param {string} [p.selectedText] 选中段
   * @param {string} [p.question] 提问动作的问题文本
   * @returns {{role:string, tag:string, message:string}}
   */
  function buildActionMessage(p) {
    var input = p && typeof p === 'object' ? p : {}
    var act = getAction(input.actionId)
    if (!act) throw new Error('未知工具条动作：' + String(input.actionId))
    var role = normalizeRole(input.role)
    var tag = permissionTag(role)
    var selected = String(input.selectedText == null ? '' : input.selectedText)
    var lines = []

    if (act.id === 'ask') {
      var q = String(input.question == null ? '' : input.question).trim()
      lines.push(tag + '提问：' + (q || '（请补充你的问题）'))
    } else {
      lines.push(tag + '请求执行「' + act.label + '」。' + act.hint)
    }
    if (selected) {
      lines.push('')
      lines.push('选中段如下：')
      lines.push('"""' + selected + '"""')
    }
    return { role: role, tag: tag, message: lines.join('\n') }
  }

  return {
    ROLES: ROLES,
    DEFAULT_ROLE: DEFAULT_ROLE,
    ROLE_LABELS: ROLE_LABELS,
    ACTIONS: ACTIONS,
    GROUPS: GROUPS,
    ASK_ROLES: ASK_ROLES.slice(),
    ACTION_IDS: ACTION_IDS.slice(),
    normalizeRole: normalizeRole,
    permissionTag: permissionTag,
    getAction: getAction,
    actionState: actionState,
    allowedActions: allowedActions,
    groupHasAllowed: groupHasAllowed,
    requiredRoleOf: requiredRoleOf,
    denyMessage: denyMessage,
    countChars: countChars,
    estimateExpandCost: estimateExpandCost,
    buildActionMessage: buildActionMessage,
  }
})
