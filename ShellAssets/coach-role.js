'use strict'

// ============================================================================
// 创作教练 · 四权限 → 会话（sessionId）路由纯逻辑（2026-11-13，对话职责细分 P3）
//
// 定位：**零依赖、可被 node 直接 require、也可被壳页当 <script> 加载** 的 UMD 模块
//   （写法与 send.js / gateway.js 完全同口径）。main.js 只做装配，判定逻辑全在本文件，
//   这样不依赖 Electron 就能跑单测。
//
// 背景：服务端 writing-coach 已按 reader 读者 / editor 编辑 / discussor 讨论者 /
//   instructor 指导（+独立 proofread 校对）做硬闸（见 plugins/writing-coach/lib/permission.js）。
//   客户端要把「当前以哪个身份对话」映射到**对应会话**：每个身份可挂一个独立 sessionId，
//   实现"新对话建立/会话挂牌"；未配置的身份回落到默认会话（单会话挂牌），不破坏既有工作流。
//
// 🔴 硬约束：
//   ① 缺省身份 = reader（与服务端 F1 一致），非法/未知身份一律回落 reader；
//   ② 只做**路由解析**，绝不创建/归档/删除会话（红线：不建议归档会话、不破坏既有工作流）；
//   ③ 映射缺失或 sessionId 为空 ⇒ 回落 defaultSessionId；defaultSessionId 也空 ⇒ 返回 ''
//      （由调用方决定是新建会话还是报错，本模块不擅自建会话）；
//   ④ sessionId 只接受非空字符串，trim 后空白视为未配置。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCCoachRole = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  // 四个对话身份 + 独立校对（与服务端 permission.js 的 ROLE_IDS 对齐；proofread 沿用既有校对通道，
  // 不在本模块的四权限挂牌内，但保留常量以便调用方识别）。
  var ROLES = ['reader', 'editor', 'discussor', 'instructor']
  var DEFAULT_ROLE = 'reader'

  /** 身份归一：trim + 小写；非四权限身份一律回落 reader（proofread 不在对话挂牌内也回落） */
  function normalizeRole(role) {
    var r = String(role == null ? '' : role).trim().toLowerCase()
    return ROLES.indexOf(r) >= 0 ? r : DEFAULT_ROLE
  }

  /** 取一个干净的 sessionId：非字符串/空白 ⇒ '' */
  function cleanSessionId(v) {
    if (typeof v !== 'string') return ''
    var s = v.trim()
    return s
  }

  /**
   * 归一化整段配置。
   * @param {object} [cfg] 形如 { defaultSessionId, sessions: { reader, editor, discussor, instructor } }
   * @returns {{defaultSessionId:string, sessions:object}} 仅含合法身份键，值为干净字符串
   */
  function normalizeConfig(cfg) {
    var c = cfg && typeof cfg === 'object' ? cfg : {}
    var sessions = {}
    var rawSessions = c.sessions && typeof c.sessions === 'object' ? c.sessions : {}
    for (var i = 0; i < ROLES.length; i += 1) {
      var id = cleanSessionId(rawSessions[ROLES[i]])
      if (id) sessions[ROLES[i]] = id
    }
    return {
      defaultSessionId: cleanSessionId(c.defaultSessionId),
      sessions: sessions,
    }
  }

  /**
   * 核心路由：身份 → 该身份挂牌会话，缺失则回落默认会话。
   * @param {string} role 调用身份（任意输入，内部归一）
   * @param {object} [cfg] 会话映射配置
   * @returns {{role:string, sessionId:string, source:'role'|'default'|'none'}}
   *   source 标注会话来源，便于调用方留痕/测试断言：
   *     role    = 命中该身份专属会话
   *     default = 回落默认会话（单会话挂牌）
   *     none    = 两者都没配，sessionId=''（调用方自行决定新建/报错）
   */
  function resolveSession(role, cfg) {
    var r = normalizeRole(role)
    var norm = normalizeConfig(cfg)
    var specific = norm.sessions[r]
    if (specific) return { role: r, sessionId: specific, source: 'role' }
    if (norm.defaultSessionId) return { role: r, sessionId: norm.defaultSessionId, source: 'default' }
    return { role: r, sessionId: '', source: 'none' }
  }

  /**
   * 给某次工具调用/对话消息附带服务端硬闸需要的身份字段（additive，不改既有载荷）。
   * 只产出 { permission }，破例口令 overrideToken 由调用方在用户显式确认时另行加入，
   * 本函数**绝不自动带口令**（防止无意识越权）。
   */
  function withPermission(args, role) {
    var out = args && typeof args === 'object' ? Object.assign({}, args) : {}
    out.permission = normalizeRole(role)
    return out
  }

  return {
    ROLES: ROLES,
    DEFAULT_ROLE: DEFAULT_ROLE,
    normalizeRole: normalizeRole,
    cleanSessionId: cleanSessionId,
    normalizeConfig: normalizeConfig,
    resolveSession: resolveSession,
    withPermission: withPermission,
  }
})
