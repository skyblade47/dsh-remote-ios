/* ipad.js —— iOS 壳侧附加脚本（rewriter 在 sync-net.js 之后、内联 tab 脚本之前注入）
 * 本地优先壳的 iPad 适配，做四件事：
 *   0. 默认落在[写作]页（本地程序与工作区）；未配网关时让 [DSH] iframe 不发无效请求，
 *      配了网关则恢复同源 /app#/（对话=网关虚拟同源）；
 *   1. visualViewport resize 时让光标行保持可见（interactive-widget=resizes-content
 *      已由 rewriter 写进 viewport meta，此为 WebKit 支持不全时的兜底）；
 *   2. 点编辑区/输入框之外的空白主动 blur 收键盘，并暴露 window.__wciPadDismissKeyboard；
 *   3. 沙盒多工作区：覆盖 pickRoot/pickDir —— iOS 无系统选目录能力，改为枚举
 *      Documents/workspace 容器内的子工作区（listRoots/switchRoot/createRoot），
 *      用壳层自带浮层完成「选择 / 新建」，writing.js 与 PC 契约一行不改。
 *   4. 云端会话：本 host 会话探针 + 登录提示条/浮层（cookie 按 host 隔离，Funnel 域没有
 *      dsh_session 时网关对 clientZoneList 回 302 登录页，写作端静默不显示云端作品），
 *      并在 WCSyncNet.listDrafts 外包一层闸门，登录成功后挂起的清单请求自然兑现、云端卡出现。
 * 明确不做：online 回网补推（writing.js 核心已绑 online 钩子，不重复）、
 *           分栏 pointer 交互（核心已实现，CSS touch-action 即够）、横幅/主题/手机形态、
 *           左右栏收起（栏位一字不动）。
 */
(function () {
  'use strict'
  if (window.__wciPadShell) return
  window.__wciPadShell = true

  // 未配网关时，壳文档 baseURL 是原生侧固定占位 origin（主机名 local.dsh-remote.invalid）。
  // 据此区分「离线/未配置」与「已配网关」，不必再让原生注入配置。
  var PLACEHOLDER_HOST = 'local.dsh-remote.invalid'
  function gatewayConfigured() {
    return location.hostname !== PLACEHOLDER_HOST && location.hostname !== ''
  }

  // shell.html 的 [DSH] iframe 默认写死 src="/app#/"。占位 origin 下它会解析成
  // 一个永不连通的 https://local.dsh-remote.invalid/app 请求；默认又停在[写作]页，
  // 故未配网关时把 src 撤成 about:blank（等设置页/网关就绪后再恢复）。
  function neutralizeDshFrameWhenOffline() {
    var frame = document.getElementById('dsh-frame')
    if (!frame) return
    if (gatewayConfigured()) {
      if (frame.getAttribute('src') !== '/app#/') frame.setAttribute('src', '/app#/')
    } else if (frame.getAttribute('src') !== 'about:blank') {
      frame.setAttribute('src', 'about:blank')
    }
  }

  // 默认进[写作]页。rewriter 把本脚本插在内联 tab 脚本**之前**，此时 __wcTabs 尚未定义；
  // 轮询到它出现即切（只切一次，之后显隐交还给 shell.html / writing.js 的既有逻辑）。
  function showWritingByDefault() {
    var tries = 0
    var timer = setInterval(function () {
      tries += 1
      if (window.__wcTabs && typeof window.__wcTabs.show === 'function') {
        window.__wcTabs.show('writing')
        clearInterval(timer)
      } else if (tries > 50) { // ~5s 兜底，避免异常时永久轮询
        clearInterval(timer)
      }
    }, 100)
  }

  function activeEditable() {
    var el = document.activeElement
    if (!el) return null
    var tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'SELECT') return el
    if (tag === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t !== 'button' && t !== 'submit' && t !== 'reset' &&
          t !== 'checkbox' && t !== 'radio' && t !== 'range' && t !== 'color') {
        return el
      }
      return null
    }
    if (el.isContentEditable) return el
    return null
  }

  function dismissKeyboard() {
    var el = activeEditable()
    if (el && typeof el.blur === 'function') el.blur()
  }
  window.__wciPadDismissKeyboard = dismissKeyboard

  function keepCaretVisible() {
    var el = activeEditable()
    if (!el || typeof el.scrollIntoView === 'undefined') return
    // block:'nearest' 只在被键盘遮挡时最小滚动，不把页面顶飞
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  var vv = window.visualViewport
  if (vv) {
    var pending = false
    vv.addEventListener('resize', function () {
      if (pending) return
      pending = true
      // 一帧内合并：键盘动画过程中连续 resize 只滚一次
      requestAnimationFrame(function () {
        pending = false
        keepCaretVisible()
      })
    })
    vv.addEventListener('scroll', function () {
      if (pending) return
      pending = true
      requestAnimationFrame(function () {
        pending = false
        keepCaretVisible()
      })
    })
  }

  // 点空白收键盘：命中的不是可编辑元素本身，也不在其内部，且不是分割条拖拽，
  // 也不是任何按钮/链接/开关（那些点按有自己的语义，不该顺带收键盘）
  document.addEventListener('pointerdown', function (e) {
    if (activeEditable() === null) return
    var t = e.target
    if (!(t instanceof Element)) return
    if (t.closest('input, textarea, select, [contenteditable="true"], button, a, label, .w-split-handle')) return
    dismissKeyboard()
  }, true)

  // ───────────────────────── 3. 沙盒多工作区 ─────────────────────────
  //
  // PC 上 pickRoot/pickDir 弹的是系统目录选择器；iOS 沙盒里应用只能读写自己的容器，
  // 不存在「任选宿主目录」。原生侧因此对这两个方法回 NotSupported，改由这里在 JS 层
  // 覆盖（BridgeJS 的 wcStorage 是 Proxy，对同名属性赋函数即覆盖，见 testShellCanOverride…）：
  //   · pickRoot()：列出容器内已有子工作区，点选 ⇒ switchRoot；浮层里也能直接新建 ⇒ createRoot。
  //   · pickDir() ：「新建到指定位置」在 iPad 上唯一合法的父目录就是容器本身，
  //                 直接回容器路径（由 listRoots().container 取得），不再让用户选宿主路径。
  // 返回形状严格对齐 writing.js 的消费：
  //   pickRoot ⇒ {ok:true,root} | {ok:false,canceled:true} | {ok:false,error}
  //   pickDir  ⇒ {ok:true,dir}    | {ok:false,canceled:true} | {ok:false,error}

  var api = window.wcStorage

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  // 自建浮层（不依赖 writing.css 的模态类，壳层自治；样式见 ipad.css 的 .wci-*）。
  // 返回 {overlay, box, body, close}，body 由调用方填充，close 负责移除并还原滚动。
  // onClose 在用户点「取消」或点遮罩时触发一次（程序化 close 不触发），供调用方 resolve(canceled)。
  function openOverlay(titleText, onClose) {
    var overlay = el('div', 'wci-overlay')
    var box = el('div', 'wci-box')
    var head = el('div', 'wci-head')
    head.appendChild(el('span', 'wci-title', titleText))
    var closeBtn = el('button', 'wci-x', '取消')
    head.appendChild(closeBtn)
    var body = el('div', 'wci-body')
    box.appendChild(head)
    box.appendChild(body)
    overlay.appendChild(box)

    var prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    var removed = false
    function dismiss() {
      if (removed) return
      removed = true
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      document.body.style.overflow = prevOverflow
    }
    function close() {
      dismiss()
      if (typeof onClose === 'function') onClose()
    }
    closeBtn.addEventListener('click', close)
    overlay.addEventListener('pointerdown', function (e) {
      if (e.target === overlay) close()
    })
    document.body.appendChild(overlay)
    return { overlay: overlay, box: box, body: body, close: dismiss }
  }

  // 「新建工作区」小块：输入名 + 按钮，promise 成功回 root 路径，取消/关闭不 resolve。
  function mountCreateBlock(body, onCreated, defaultName) {
    var row = el('div', 'wci-create')
    var input = el('input')
    input.type = 'text'
    input.setAttribute('aria-label', '新工作区名')
    input.placeholder = '新工作区名'
    input.value = defaultName || ''
    var btn = el('button', 'wci-primary', '新建并进入')
    row.appendChild(input)
    row.appendChild(btn)
    body.appendChild(row)

    function submit() {
      var name = input.value.trim()
      if (!name) { input.focus(); return }
      btn.disabled = true
      // parentDir 传 null：iPad 一律落在容器内；createRoot 成功后原生已把它切为当前根。
      Promise.resolve(api.createRoot(name, null)).then(function (res) {
        if (res && res.ok) { onCreated(res.root); return }
        btn.disabled = false
        showError(res && res.error)
      }).catch(function (e) {
        btn.disabled = false
        showError(e && e.message ? e.message : String(e))
      })
    }
    btn.addEventListener('click', submit)
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit() }
    })
    setTimeout(function () { input.focus() }, 0)
    return input
  }

  function showError(message) {
    var existing = document.querySelector('.wci-box .wci-err')
    var node = existing || el('div', 'wci-err')
    node.textContent = message || '未知错误'
    if (!existing) {
      var box = document.querySelector('.wci-box')
      if (box) box.appendChild(node)
    }
  }

  // pickRoot 的浮层内容：已有工作区列表（点选切换）+ 底部新建块。
  function openRootPicker() {
    return new Promise(function (resolve) {
      var settled = false
      function done(val) {
        if (settled) return
        settled = true
        ui.close()
        resolve(val)
      }
      // 用户点「取消」/遮罩 ⇒ 对齐 PC 的 canceled，writing.js 静默收束。
      var ui = openOverlay('选择沙盒内工作区', function () {
        done({ ok: false, canceled: true })
      })
      ui.body.appendChild(el('p', 'wci-sub',
        '工作区都在本应用沙盒的 workspace 容器内；点一个进入，或在下面新建。'))

      Promise.resolve(api.listRoots()).then(function (res) {
        if (!res || !res.ok) { done({ ok: false, error: (res && res.error) || '读取工作区列表失败' }); return }
        var roots = Array.isArray(res.roots) ? res.roots : []
        if (roots.length) {
          var list = el('div', 'wci-list')
          roots.forEach(function (r) {
            var item = el('button', 'wci-item')
            item.appendChild(el('span', 'wci-item-name', r.name))
            if (r.current) item.appendChild(el('span', 'wci-badge', '当前'))
            item.addEventListener('click', function () {
              if (r.current) { done({ ok: true, root: r.root }); return }
              item.disabled = true
              Promise.resolve(api.switchRoot(r.name)).then(function (sr) {
                if (sr && sr.ok) { done({ ok: true, root: sr.root }); return }
                item.disabled = false
                showError(sr && sr.error)
              }).catch(function (e) {
                item.disabled = false
                showError(e && e.message ? e.message : String(e))
              })
            })
            list.appendChild(item)
          })
          ui.body.appendChild(list)
        } else {
          ui.body.appendChild(el('p', 'wci-empty', '容器内还没有工作区，请在下面新建第一个。'))
        }

        ui.body.appendChild(el('div', 'wci-sep'))
        mountCreateBlock(ui.body, function (root) { done({ ok: true, root: root }) },
          defaultRootName())
      }).catch(function (e) {
        done({ ok: false, error: e && e.message ? e.message : String(e) })
      })
    })
  }

  // 默认名与 writing.js 空态输入框保持一致（它在 getState 后回填 w-new-root-name）。
  function defaultRootName() {
    var n = document.getElementById('w-new-root-name')
    var v = n && n.value ? n.value.trim() : ''
    return v || '我的小说'
  }

  function installSandboxWorkspace() {
    if (!api || typeof api !== 'object') return false
    api.pickRoot = function () { return openRootPicker() }
    // 「新建到指定位置…」：iPad 唯一合法父目录是容器，直接回它，跳过目录选择。
    api.pickDir = function () {
      return Promise.resolve(api.listRoots()).then(function (res) {
        if (res && res.ok && res.container) return { ok: true, dir: res.container, canceled: false }
        return { ok: false, error: (res && res.error) || '无法取得沙盒容器路径' }
      })
    }
    return true
  }

  // 文案适配：放出的入口原指「系统目录」，沙盒语境下统一说「工作区」（只改文本，不改结构）。
  function relabelWorkspaceEntries() {
    var pick = document.getElementById('w-pick-root')
    if (pick) pick.textContent = '选择已有工作区…'
  }

  // ───────────────────── 4. 「重启客户端」假死修复 ─────────────────────
  //
  // iOS 应用不能自行退出重开：原生 relaunch 只回 ok（BridgeDispatcher 的 okMap 分支），
  // 不会真的重启。writing.js 的流程是 confirm → 按钮置灰改字「正在重启…」→ api.relaunch()
  // —— 它等的是「进程退出」这个永不到来的结果，按钮就此卡死（用户只能杀进程）。
  // 壳层对策：在 document 捕获阶段拦截该键点击 —— 捕获沿 DOM 树下行，先于目标上
  // writing.js 已注册的监听触发，stopPropagation 让它根本到不了目标 —— 改为弹浮层
  // 请用户手动关开 App；按钮全程不被置灰，confirm 也不会出现。
  function showRelaunchHint() {
    var ui = openOverlay('重启客户端', null)
    ui.body.appendChild(el('p', 'wci-sub',
      'iPad 上应用不能自行重启。刚保存的设置已经落盘：请手动关闭本 App' +
      '（上滑进多任务界面后把它划掉），再重新打开即生效。'))
    var ok = el('button', 'wci-primary', '知道了')
    ok.style.width = '100%'
    ok.addEventListener('click', ui.close)
    ui.body.appendChild(ok)
  }
  document.addEventListener('click', function (e) {
    var t = e.target
    if (!(t instanceof Element)) return
    if (!t.closest('#s-restart')) return
    e.preventDefault()
    e.stopPropagation()
    showRelaunchHint()
  }, true)

  // ───────────────────── 4b. 云端会话探针 / 登录（云端作品显示修复） ─────────────────────
  //
  // cookie 按 host 隔离（spec §6.26）：登录若发生在 tailnet/直连 host，cookie 不会带给
  // Funnel 域 dsh-cloud.…；网关 auth-middleware 对不以 /api/ 开头的 clientZoneList 在无
  // cookie 时回 302→/auth/login（不是 401 JSON），sync-net 的 fetch 默认 follow 拿到登录页
  // HTML，JSON.parse 失败 ⇒ {ok:false} ⇒ indexList known:false ⇒ 云端作品卡不渲染，且无
  // 任何提示。安卓早有探针+本 host 登录，iPad 此处补齐（蓝本：android-shell.js）。
  // 做法：① redirect:'manual' 探针，opaqueredirect/302/401/403 判本 host 无会话；
  //      ② 无会话显非模态提示条（可点出登录浮层，POST /api/auth/login 让 Set-Cookie 种在本 origin）；
  //      ③ 包一层 WCSyncNet.listDrafts 闸门：探针判定无会话期间，挂起 writing.js 的清单请求，
  //         登录成功后放行 —— 挂起的那次调用拿到 200，writing.js 据此重画侧栏，云端卡出现。
  //      探针失败（离线/超时）一律 fail-open 放行原调用，绝不挡本地写作。
  var hostSessionState = null // null=未判定；true=本 host 有会话；false=无会话
  var sessionWaiters = []
  var probeInFlight = false
  var PROBE_TIMEOUT_MS = 9000

  function listPath() {
    return (window.WCSyncNet && window.WCSyncNet.LIST_PATH) || '/writing-studio/api/clientZoneList'
  }

  // fail-open：放行所有挂起者（传 false 表示「未确认会话」，由调用方自行决定是否直接打网络）。
  function releaseSessionWaiters() {
    var ws = sessionWaiters
    sessionWaiters = []
    ws.forEach(function (w) { w() })
  }

  function probeHostSession() {
    if (!gatewayConfigured()) return Promise.resolve(hostSessionState)
    probeInFlight = true
    var ctl = new AbortController()
    var timer = setTimeout(function () { ctl.abort() }, PROBE_TIMEOUT_MS)
    return fetch(listPath(), {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'manual',
      signal: ctl.signal,
    }).then(function (res) {
      clearTimeout(timer)
      probeInFlight = false
      if (res.type === 'opaqueredirect' || res.status === 0 || res.status === 302 ||
          res.status === 401 || res.status === 403) {
        hostSessionState = false
      } else if (res.ok) {
        hostSessionState = true
      } // 其余状态（5xx 等）保持 null，按未知处理，不误报「需要登录」
      renderAuthBar()
      if (hostSessionState === true) releaseSessionWaiters()
      return hostSessionState
    }).catch(function () {
      clearTimeout(timer)
      probeInFlight = false
      // 离线/超时/中止：不臆断无会话，fail-open（离线时网关配置下浏览器本身也连不上）
      releaseSessionWaiters()
      renderAuthBar()
      return hostSessionState
    })
  }

  // 清单闸门：① 已**确认无会话** ⇒ 挂起至登录成功；② 会话未决（启动探针在途）⇒ 暂挂，
  // 探针一回 200 立即放行（不多绕一圈），回 302 则继续等登录；③ 探针失败/离线 ⇒ fail-open。
  // 返回 true = 已接管（此次调用延后）；false = 照常走原实现。
  function gateListDrafts(resume) {
    if (hostSessionState === false || (hostSessionState === null && probeInFlight)) {
      sessionWaiters.push(resume)
      return true
    }
    return false
  }

  function installListDraftsGate() {
    var net = window.WCSyncNet
    if (!net || typeof net.listDrafts !== 'function' || net.__wciListGate) return false
    var orig = net.listDrafts.bind(net)
    net.listDrafts = function () {
      var args = arguments
      var self = this
      return new Promise(function (resolve) {
        var resumed = false
        var resume = function () {
          if (resumed) return
          resumed = true
          resolve(orig.apply(self, args))
        }
        if (gateListDrafts(resume)) return // 无会话：等登录成功/离线后放行
        resume()
      })
    }
    net.__wciListGate = true
    return true
  }

  // ── 非模态提示条（固定在视口顶部，不属于任何栏位；登录成功即隐藏）──────────────
  var authBar = null
  function ensureAuthBar() {
    if (authBar) return authBar
    authBar = el('div', 'wci-authbar')
    var msg = el('span', 'wci-authbar-msg', '云端作品未显示：当前网关地址尚未登录')
    var btn = el('button', 'wci-authbar-btn', '登录以显示云端作品')
    btn.type = 'button'
    btn.addEventListener('click', openLoginOverlay)
    authBar.appendChild(msg)
    authBar.appendChild(btn)
    document.body.appendChild(authBar)
    return authBar
  }

  function renderAuthBar() {
    // 仅「已配网关且确认本 host 无会话」时显示；离线/未知不打扰本地写作。
    if (hostSessionState === false && gatewayConfigured()) {
      ensureAuthBar()
      authBar.hidden = false
    } else if (authBar) {
      authBar.hidden = true
    }
  }

  // ── 登录浮层（复用 wci-* 浮层；POST 成功后 Set-Cookie 自然种在当前 origin）──────
  function openLoginOverlay() {
    if (document.querySelector('.wci-login')) return
    var ui = openOverlay('登录云端', null)
    ui.box.classList.add('wci-login')
    ui.body.appendChild(el('p', 'wci-sub',
      '在本应用内登录一次（' + location.host + '），cookie 只保存在本机 WebKit 存储中；' +
      '登录后写作面板会自动列出云端作品。'))

    var form = el('div', 'wci-form')
    var nameInput = el('input')
    nameInput.type = 'text'
    nameInput.setAttribute('autocapitalize', 'none')
    nameInput.setAttribute('autocorrect', 'off')
    nameInput.placeholder = '账号'
    var passInput = el('input')
    passInput.type = 'password'
    passInput.placeholder = '密码'
    form.appendChild(nameInput)
    form.appendChild(passInput)
    var submitBtn = el('button', 'wci-primary', '登录')
    submitBtn.style.width = '100%'
    form.appendChild(submitBtn)
    ui.body.appendChild(form)

    function errBox() {
      var n = el('div', 'wci-err')
      n.style.display = 'none'
      ui.body.appendChild(n)
      return n
    }
    var err = errBox()
    function fail(msg) {
      err.textContent = msg
      err.style.display = 'block'
      submitBtn.disabled = false
    }

    function submit() {
      var name = nameInput.value.trim()
      var pass = passInput.value
      if (!name || !pass) { fail('请输入账号和密码'); return }
      err.style.display = 'none'
      submitBtn.disabled = true
      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: name, password: pass }),
      }).then(function (res) {
        return res.text().then(function (raw) {
          var json = null
          try { json = raw ? JSON.parse(raw) : null } catch (e) { json = null }
          return { status: res.status, json: json }
        })
      }).then(function (r) {
        var ok = r.status >= 200 && r.status < 300 && (!r.json || r.json.ok !== false)
        if (!ok) {
          var e = r.json && r.json.error
          fail((typeof e === 'string' && e) || (e && e.message) ||
               (r.json && r.json.message) || ('登录失败（HTTP ' + r.status + '）'))
          return
        }
        passInput.value = ''
        ui.close()
        hostSessionState = true
        renderAuthBar()
        releaseSessionWaiters() // 挂起的清单请求放行 → 200 → 写作端重画侧栏显云端卡
        // 回到联网态：writing.js 的 online 钩子会 refreshToday/drainWritingQueue（补推待发）。
        try { window.dispatchEvent(new Event('online')) } catch (e2) { /* 忽略 */ }
      }).catch(function () {
        fail('网络异常，请稍后再试')
      })
    }
    submitBtn.addEventListener('click', submit)
    passInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit() }
    })
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); passInput.focus() }
    })
    setTimeout(function () { nameInput.focus() }, 60)
  }

  var cloudSessionInstalled = false
  function installCloudSession() {
    if (cloudSessionInstalled) return true
    if (!gatewayConfigured()) { cloudSessionInstalled = true; return true } // 未配网关：不做云端会话逻辑
    if (!installListDraftsGate()) return false // WCSyncNet 尚未就绪，调用方轮询
    cloudSessionInstalled = true
    // 闸门必须在 writing.js init 的 getState 回调调 listDrafts 之前装好（脚本按序同步执行，
    // ipad.js 紧跟 sync-net.js，故这里同步安装即先于它）；探针随后异步跑。
    probeHostSession()
    window.addEventListener('online', function () {
      // 回网后重新判定（离线时 hostSessionState 可能停在 null/false）
      if (!probeInFlight) probeHostSession()
    })
    return true
  }

  // BridgeJS 在 document-start 注入，wcStorage 已存在；轮询仅为防御未来注入顺序变化。
  if (!installSandboxWorkspace()) {
    var pickTries = 0
    var pickTimer = setInterval(function () {
      pickTries += 1
      if (installSandboxWorkspace() || pickTries > 50) clearInterval(pickTimer)
    }, 100)
  }

  function relabelWhenReady() {
    var tries = 0
    var timer = setInterval(function () {
      tries += 1
      var pick = document.getElementById('w-pick-root')
      if (pick) {
        relabelWorkspaceEntries()
        clearInterval(timer)
      } else if (tries > 50) {
        clearInterval(timer)
      }
    }, 100)
  }

  // 云端会话闸门：rewriter 把本脚本紧跟 sync-net.js 注入，WCSyncNet 应已存在；
  // 轮询仅为防御注入顺序变化（必须赶在 writing.js init 异步拉清单之前装好）。
  if (!installCloudSession()) {
    var cloudTries = 0
    var cloudTimer = setInterval(function () {
      cloudTries += 1
      if (installCloudSession() || cloudTries > 50) clearInterval(cloudTimer)
    }, 100)
  }

  // 未配网关：尽早撤掉 [DSH] iframe 的 /app#/ 请求（本脚本在解析到尾部外链时同步执行，
  // 即便 iframe 已发起一次占位请求，改成 about:blank 也会立即中止它）。
  neutralizeDshFrameWhenOffline()
  // 默认进[写作]页（__wcTabs 由其后的内联脚本定义，故内部轮询）。
  showWritingByDefault()
  // 入口文案适配（DOM 可能尚未解析，内部轮询）。
  relabelWhenReady()
})()
