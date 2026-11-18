'use strict'

// ============================================================================
// 创作教练 · 选中浮动 AI 工具条（2026-11-13，对话职责细分 P4，DOM/接线层）
//
// 定位：纯接线，不含判定 —— 判定与文案全在 coach-toolbar.js（window.WCCoachToolbar，可单测）。
//   本文件只做四件事：
//     1) 监听写作区（contentEditable #w-editor）选区，有非空选中段 ⇒ 在选区上方浮现工具条；
//     2) 按「读者提问 / 编辑改字句 / 讨论者动结构」三组渲染，**每个身份只渲染其可用动作**
//        （TB.allowedActions 过滤，越权项直接不出现，不置灰占位；服务端硬闸仍独立兜底）；
//     3) 顶栏身份牌 + 身份切换（reader/editor/discussor/instructor，缺省 reader，仅内存态）；
//     4) 点击动作 ⇒ 在工具条内嵌区直接经**同一条 relay 发送管道**（window.__wcSendDirectRelay，
//        与发送弹窗共用 deliver/轮询/回程）发出，**不弹独立发送确认窗**、不另起投递通道、
//        绝不自动带破例口令、绝不自动写回正文。
//
// 🔴 红线（设计件 §4/§5，2026-11-13 用户拍板校准）：
//   ① 越权动作不渲染（按角色分开，只暴露有权做的活），不提供"一键破例"（破例口令只能用户在别处显式给出）；
//   ② 扩写（discussor，高危）发送前强制弹「篇幅代价」确认（§5 + §7 篇幅偏离 ≤ +20%）；
//   ③ 提问无固定权限，先在工具条内嵌选单让用户选读者/讨论者/指导并就地填问题，**不默认身份**；
//      （Electron 渲染进程不支持 window.prompt，故提问输入用内嵌 textarea，不用原生 prompt）；
//   ④ 真正的铁律是「不自动修改文本内容」：结果只给候选/回显进 coach 面板，写回正文只能用户手动点「应用」；
//      发送动作本身由用户点工具条按钮显式触发，无需再经一道发送弹窗确认。
//
// 复用：选区文本走 window.__wcSendBridge.selection()（已保证选区两端落在写作区内）；
//   全文（扩写锚判定用）走 __wcSendBridge.text()；提示走 __wcSendBridge.notice()；
//   直发走 __wcSendDirectRelay(message, permission)（send-net.js 暴露，内部复用 deliver/relay 管道）。
//
// 🔑 会话路由演进（P3，2026-11-13 服务端打通后更新，取代 P4c 旧结论）：
//   本工具条的派发走既有 relay（/taskkit/api/relay）。P3 起 relay 已消费结构化
//   payload.permission（plugins/taskkit/lib/coach-identity-core.js 的 resolveCoachIdentity）：
//     · 工具条显式身份 → dispatch 把 role 经 __wcSendDirectRelay 透传 → send-net 写入 body.permission
//       → 服务端判 direct 直投、并把身份透到 writing-coach 硬闸（机器契约，不再只是提示词）；
//     · 消息**首行【身份】权限卡**仍保留（buildActionMessage 产出），给人/LLM 读，与结构化字段双通道；
//     · 普通自由文本发送不带 permission ⇒ 服务端判 triage，交任务中心澄清分诊。
//   会话 id 仍由服务端持有/懒建，客户端不发 sessionId；coach-role.resolveSession 留给未来直连通道。
// ============================================================================

;(function () {
  'use strict'

  var TB = window.WCCoachToolbar
  if (!TB) { console.error('[wc-toolbar] coach-toolbar.js 未加载（window.WCCoachToolbar 缺失）'); return }

  // 当前对话身份（仅内存态，缺省 reader；刷新回到 reader —— 不写配置、不改既有工作流）。
  var currentRole = TB.DEFAULT_ROLE
  var barEl = null
  // 提问选身份 / 扩写代价确认的小弹层元素（复用同一个轻量 popover 容器，二选一显示）。
  var popEl = null
  // 记住最近一次选中段，供弹层确认后派发（选区在弹层交互时可能已变化，这里锁定动作触发瞬间的文本）。
  var lockedSelection = ''

  function sendBridge() { return window.__wcSendBridge || null }

  function say(text, isError) {
    var b = sendBridge()
    if (b && b.notice) b.notice(text, isError)
    else if (isError) console.error('[wc-toolbar] ' + text)
  }

  // ── 工具条容器（懒创建，挂 body 末尾，position:fixed 跟随选区坐标）──────────────
  function ensureBar() {
    if (barEl) return barEl
    barEl = document.createElement('div')
    barEl.className = 'wc-ctb'
    barEl.hidden = true
    // mousedown 阻止默认：点工具条不能让写作区失焦/丢选区（selectionchange 也不会误判清空）。
    barEl.addEventListener('mousedown', function (e) { e.preventDefault() })
    document.body.appendChild(barEl)
    return barEl
  }

  function ensurePop() {
    if (popEl) return popEl
    popEl = document.createElement('div')
    popEl.className = 'wc-ctb-pop'
    popEl.hidden = true
    popEl.addEventListener('mousedown', function (e) { e.preventDefault() })
    document.body.appendChild(popEl)
    return popEl
  }

  function hidePop() {
    if (popEl) popEl.hidden = true
  }

  // ── 顶栏：身份牌 + 身份切换 ────────────────────────────────────────────────
  function renderRoleSwitch() {
    var wrap = document.createElement('div')
    wrap.className = 'wc-ctb-roles'
    var label = document.createElement('span')
    label.className = 'wc-ctb-role-label'
    label.textContent = '当前身份'
    wrap.appendChild(label)
    TB.ROLES.forEach(function (role) {
      var chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'wc-ctb-role' + (role === currentRole ? ' is-active' : '')
      chip.dataset.role = role
      chip.textContent = TB.ROLE_LABELS[role]
      chip.addEventListener('click', function () {
        currentRole = TB.normalizeRole(role)
        hideBar()
        hidePop()
        // 切换身份后若仍有选区，按新身份重画（置灰态随之变化）。
        if (currentSelectionText()) renderBar()
      })
      wrap.appendChild(chip)
    })
    return wrap
  }

  // ── 三组动作按钮（按当前身份只渲染可用项，越权动作不出现）────────────────────────
  function renderActionGroups() {
    var groupsWrap = document.createElement('div')
    groupsWrap.className = 'wc-ctb-groups'
    // 当前身份的可渲染动作清单（纯判定在 TB.allowedActions），按 group 归桶。
    var visible = TB.allowedActions(currentRole)
    TB.GROUPS.forEach(function (group) {
      var acts = visible.filter(function (a) { return a.group === group.id })
      if (!acts.length) return // 整组在当前身份下无可用动作 ⇒ 连分组标签一起不渲染
      var g = document.createElement('div')
      g.className = 'wc-ctb-group wc-ctb-group-' + group.id
      var gLabel = document.createElement('span')
      gLabel.className = 'wc-ctb-group-label'
      gLabel.textContent = group.label
      g.appendChild(gLabel)

      acts.forEach(function (act) {
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'wc-ctb-btn'
        btn.dataset.action = act.id
        var required = TB.requiredRoleOf(act.id)
        // 按钮上显示权限牌（§5）；提问无固定身份，显示"选身份"。
        var tagText = required ? TB.permissionTag(required) : '选身份'
        btn.innerHTML = ''
        var name = document.createElement('span')
        name.className = 'wc-ctb-btn-name'
        name.textContent = act.label
        var tag = document.createElement('span')
        tag.className = 'wc-ctb-btn-tag'
        tag.textContent = tagText
        btn.appendChild(name)
        btn.appendChild(tag)
        if (act.highRisk) btn.classList.add('is-risk')
        // 能渲染出来的都是当前身份可用项（越权项已在 allowedActions 被剔除），直接挂点击。
        btn.addEventListener('click', function () { onAction(act) })
        g.appendChild(btn)
      })
      groupsWrap.appendChild(g)
    })
    return groupsWrap
  }

  function renderBar() {
    var bar = ensureBar()
    while (bar.firstChild) bar.removeChild(bar.firstChild)
    bar.appendChild(renderRoleSwitch())
    bar.appendChild(renderActionGroups())
    positionBar()
    bar.hidden = false
  }

  // ── 定位：浮在选区上方，溢出视口则翻到下方 / 夹到视口内 ──────────────────────
  function positionBar() {
    var bar = ensureBar()
    var sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return
    var rect = sel.getRangeAt(0).getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) return
    bar.hidden = false
    // 先量尺寸（hidden 时取不到），再算坐标。
    var bh = bar.offsetHeight || 40
    var bw = bar.offsetWidth || 240
    var gap = 8
    var top = rect.top - bh - gap
    var placeBelow = top < gap
    if (placeBelow) top = rect.bottom + gap
    var left = rect.left + rect.width / 2 - bw / 2
    left = Math.max(gap, Math.min(left, window.innerWidth - bw - gap))
    if (top + bh > window.innerHeight - gap) top = Math.max(gap, window.innerHeight - bh - gap)
    bar.style.top = Math.round(top) + 'px'
    bar.style.left = Math.round(left) + 'px'
  }

  function hideBar() {
    if (barEl) barEl.hidden = true
  }

  // 当前写作区内的选中段（复用发送桥的同一份判定，保证两端落在写作区）。
  function currentSelectionText() {
    var b = sendBridge()
    return b && b.selection ? (b.selection() || '') : ''
  }

  // ── 动作分发 ───────────────────────────────────────────────────────────────
  function onAction(act) {
    var selected = currentSelectionText()
    if (!selected) { say('选中段为空（只有空白），无法派发', true); hideBar(); return }
    lockedSelection = selected

    if (act.id === 'ask') { openAskPop(act); return }
    if (act.highRisk) { openExpandConfirm(act); return }
    // 普通动作：能渲染出来说明当前身份有权（越权项已不渲染），身份即动作归属，点击即直发。
    dispatch(act, act.role, null)
  }

  // 提问：先选身份（reader/discussor/instructor，不默认），再就地填问题、点内嵌「发送」。
  // 不用 window.prompt —— Electron 渲染进程明确不支持 prompt（真机报 "prompt() is and will not be supported"）。
  function openAskPop(act) {
    var pop = ensurePop()
    while (pop.firstChild) pop.removeChild(pop.firstChild)
    var chosenRole = null // 用户先选身份，未选前发送按钮禁用

    var title = document.createElement('div')
    title.className = 'wc-ctb-pop-title'
    title.textContent = '「提问」以哪个身份发问？'
    pop.appendChild(title)

    var row = document.createElement('div')
    row.className = 'wc-ctb-pop-roles'
    var roleChips = {}
    TB.ASK_ROLES.forEach(function (role) {
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'wc-ctb-role'
      btn.dataset.role = role
      btn.textContent = TB.ROLE_LABELS[role]
      btn.addEventListener('click', function () {
        chosenRole = role
        Object.keys(roleChips).forEach(function (r) {
          roleChips[r].classList.toggle('is-active', r === role)
        })
        sendBtn.disabled = false
        textarea.focus()
      })
      roleChips[role] = btn
      row.appendChild(btn)
    })
    pop.appendChild(row)

    // 内嵌问题输入框（替代原生 prompt），Enter 发送、Shift+Enter 换行。
    var textarea = document.createElement('textarea')
    textarea.className = 'wc-ctb-pop-input'
    textarea.rows = 3
    textarea.placeholder = '请输入你的问题…（Enter 发送，Shift+Enter 换行）'
    pop.appendChild(textarea)

    var btns = document.createElement('div')
    btns.className = 'wc-ctb-pop-btns'
    var sendBtn = document.createElement('button')
    sendBtn.type = 'button'
    sendBtn.className = 'wc-ctb-pop-ok'
    sendBtn.textContent = '发送'
    sendBtn.disabled = true // 未选身份前不可发
    function submitAsk() {
      if (sendBtn.disabled) return
      var q = String(textarea.value || '').trim()
      if (!q) { say('问题为空，未发送', true); textarea.focus(); return }
      if (!chosenRole) { say('请先选择发问身份', true); return }
      hidePop()
      dispatch(act, chosenRole, q)
    }
    sendBtn.addEventListener('click', submitAsk)
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAsk() }
    })
    var cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'wc-ctb-pop-cancel'
    cancel.textContent = '取消'
    cancel.addEventListener('click', hidePop)
    btns.appendChild(cancel)
    btns.appendChild(sendBtn)
    pop.appendChild(btns)
    showPopNearBar()
    setTimeout(function () { textarea.focus() }, 0)
  }

  // 扩写：强制「篇幅代价」确认（§5 高危 + §7 +20% 锚）。
  function openExpandConfirm(act) {
    var b = sendBridge()
    var anchorText = b && b.text ? (b.text() || '') : ''
    var cost = TB.estimateExpandCost({ selectedText: lockedSelection, anchorText: anchorText })
    var pop = ensurePop()
    while (pop.firstChild) pop.removeChild(pop.firstChild)

    var title = document.createElement('div')
    title.className = 'wc-ctb-pop-title is-risk-title'
    title.textContent = '扩写 · 篇幅代价确认（讨论者）'
    pop.appendChild(title)

    var lines = [
      '选中段约 ' + cost.selectedChars + ' 字，按默认 +30% 预估新增约 ' + cost.estimatedAdd + ' 字。',
    ]
    if (cost.canJudgeAnchor) {
      lines.push('当前全文约 ' + cost.anchorChars + ' 字，+20% 阈值约 ' + cost.anchorThreshold +
        ' 字；扩写后预估约 ' + cost.projectedAnchorChars + ' 字' +
        (cost.breaksAnchor ? '（⚠️ 将突破 +20% 篇幅锚）' : '（未突破 +20% 锚）') + '。')
    } else {
      lines.push('未取到全文锚，无法自动判断是否突破 +20%，请结合自己的篇幅账核对。')
    }
    lines.push('扩写只给候选、不自动写回；仍需你核对是否削弱母题/伏笔。')
    lines.forEach(function (text) {
      var p = document.createElement('div')
      p.className = 'wc-ctb-pop-line' + (cost.breaksAnchor ? ' is-warn' : '')
      p.textContent = text
      pop.appendChild(p)
    })

    var btns = document.createElement('div')
    btns.className = 'wc-ctb-pop-btns'
    var ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'wc-ctb-pop-ok is-risk'
    ok.textContent = '确认扩写（仍需我手动写回）'
    ok.addEventListener('click', function () { hidePop(); dispatch(act, act.role, null) })
    var cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'wc-ctb-pop-cancel'
    cancel.textContent = '取消'
    cancel.addEventListener('click', hidePop)
    btns.appendChild(cancel)
    btns.appendChild(ok)
    pop.appendChild(btns)
    showPopNearBar()
  }

  function showPopNearBar() {
    var pop = ensurePop()
    var bar = ensureBar()
    pop.hidden = false
    var pw = pop.offsetWidth || 280
    var ph = pop.offsetHeight || 160
    var anchor = bar && !bar.hidden ? bar.getBoundingClientRect() : null
    var left, top
    if (anchor) {
      left = anchor.left + anchor.width / 2 - pw / 2
      top = anchor.bottom + 8
    } else {
      left = window.innerWidth / 2 - pw / 2
      top = window.innerHeight / 2 - ph / 2
    }
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8))
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8)
    pop.style.top = Math.round(top) + 'px'
    pop.style.left = Math.round(left) + 'px'
  }

  // ── 派发：组装权限卡诉求 ⇒ 经同一条 relay 管道在浮动条内直发（不弹独立发送窗）────────
  function dispatch(act, role, question) {
    var built = TB.buildActionMessage({
      actionId: act.id,
      role: role,
      selectedText: lockedSelection,
      question: question,
    })
    hideBar()
    hidePop()
    if (typeof window.__wcSendDirectRelay !== 'function') {
      say('发送模块未就绪，无法派发', true)
      return
    }
    // 直接走 relay 直发管道（send-net.js 暴露，内部与发送弹窗共用 deliver/轮询/回程）。
    // P3：身份走双通道——消息首行【身份】权限卡（给人/LLM 读）+ 结构化 permission（服务端硬闸机器契约）。
    //   服务端 relay 已消费 permission（见 plugins/taskkit/lib/coach-identity-core.js）。
    // 铁律：这里只负责「发」，结果只回显进 coach 面板，绝不自动写回/改正文。
    Promise.resolve(window.__wcSendDirectRelay(built.message, role)).catch(function (e) {
      say('派发失败：' + ((e && e.message) || e), true)
    })
  }

  // ── 选区监听：selectionchange（contentEditable 选中变化都会触发）──────────────
  function onSelectionChange() {
    // 弹层开着时不抢（用户正在选身份/确认代价）。
    if (popEl && !popEl.hidden) return
    var selected = currentSelectionText()
    if (!selected) { hideBar(); hidePop(); return }
    renderBar()
  }

  // 滚动/缩放时重新定位（不重画内容，避免抖动）。
  function reposition() {
    if (barEl && !barEl.hidden) positionBar()
  }

  function init() {
    if (!sendBridge()) { console.error('[wc-toolbar] __wcSendBridge 缺失'); return }
    ensureBar()
    ensurePop()
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    // 写作区失焦（点到别处且无选区）⇒ 收起。
    document.addEventListener('mousedown', function (e) {
      if (barEl && !barEl.hidden && barEl.contains(e.target)) return
      if (popEl && !popEl.hidden && popEl.contains(e.target)) return
      // 延迟一帧：让 selectionchange 先决定新选区状态，避免在写作区内点一下就闪没。
      setTimeout(function () {
        if (!currentSelectionText()) { hideBar(); hidePop() }
      }, 0)
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
