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
 * 明确不做：online 回网补推（writing.js 核心已绑 online 钩子，不重复）、
 *           分栏 pointer 交互（核心已实现，CSS touch-action 即够）、横幅/主题/手机形态。
 */
(function () {
  'use strict'
  if (window.__wciPadShell) return
  window.__wciPadShell = true

  // ── 临时真机自检（诊断条，不依赖任何其它脚本/样式）────────────────────
  // 目的：真机上 ipad.js 是否执行、dsh-asset 资源能否加载、改写注入在不在。
  // 竖排红底白字固定在屏幕底部，z-index 顶格，确认根因后整块移除。
  window.__wciDiagLog = window.__wciDiagLog || []
  window.addEventListener('error', function (e) {
    try {
      window.__wciDiagLog.push('JSERR ' + (e && e.message ? e.message : e) +
        ' @' + (e && e.filename ? e.filename.split('/').pop() : '?') +
        ':' + (e && e.lineno ? e.lineno : '?'))
      window.__wciDiagRender && window.__wciDiagRender()
    } catch (_) {}
  })
  function diag(kind, text) {
    window.__wciDiagLog.push(kind + ' ' + text)
    if (window.__wciDiagRender) window.__wciDiagRender()
  }
  function diagBoot() {
    if (document.getElementById('__wci_diag')) return
    var box = document.createElement('div')
    box.id = '__wci_diag'
    box.setAttribute('style',
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
      'background:rgba(120,0,0,.92);color:#fff;font:12px/1.35 -apple-system,monospace;' +
      'padding:6px 8px;max-height:46vh;overflow:auto;white-space:pre-wrap;' +
      '-webkit-text-size-adjust:100%;pointer-events:auto')
    var close = document.createElement('div')
    close.textContent = '诊断（确认后由下一版移除）点此收起 ×'
    close.setAttribute('style', 'font-weight:bold;margin-bottom:3px;opacity:.9')
    close.onclick = function () { box.style.display = 'none' }
    box.appendChild(close)
    var pre = document.createElement('div')
    pre.id = '__wci_diag_body'
    box.appendChild(pre)
    document.body ? document.body.appendChild(box)
      : document.documentElement.appendChild(box)
    window.__wciDiagRender = function () {
      var scripts = Array.prototype.slice.call(
        document.querySelectorAll('script[src]')).map(function (s) {
          try { return s.src.split('/').pop() } catch (_) { return '?' }
        })
      var injected = scripts.indexOf('ipad.js') >= 0
      pre.textContent =
        'ipad.js EXECUTED ✓\n' +
        'readyState=' + document.readyState + '\n' +
        'injected ipad.js tag=' + (injected ? 'YES' : 'NO') + '\n' +
        'wcStorage=' + (typeof window.wcStorage) + ' wcTabs=' + (typeof window.__wcTabs) + '\n' +
        (window.__wciDiagLog || []).join('\n')
    }
    window.__wciDiagRender()
  }
  diagBoot()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { diagBoot(); window.__wciDiagRender && window.__wciDiagRender() })
  }
  diag('BOOT', 'ipad.js top-level ran; host=' + location.hostname)
  // 实测各 dsh-asset 资源能否取到（fetch 自定义 scheme）
  ;['ipad.js', 'writing.js', 'sync-net.js', 'ipad.css', 'writing.css'].forEach(function (n) {
    try {
      fetch('dsh-asset://local/' + n).then(function (r) {
        return r.text().then(function (t) { diag('FETCH', n + ' ' + r.status + ' ' + t.length + 'B') })
      }).catch(function (e) { diag('FETCH-FAIL', n + ' ' + e) })
    } catch (e) { diag('FETCH-THROW', n + ' ' + e) }
  })
  // 延迟再渲染一次，采集加载/切换结果
  setTimeout(function () { diagBoot(); window.__wciDiagRender && window.__wciDiagRender() }, 1500)
  setTimeout(function () { diagBoot(); window.__wciDiagRender && window.__wciDiagRender() }, 4000)

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

  // 未配网关：尽早撤掉 [DSH] iframe 的 /app#/ 请求（本脚本在解析到尾部外链时同步执行，
  // 即便 iframe 已发起一次占位请求，改成 about:blank 也会立即中止它）。
  neutralizeDshFrameWhenOffline()
  // 默认进[写作]页（__wcTabs 由其后的内联脚本定义，故内部轮询）。
  showWritingByDefault()
  // 入口文案适配（DOM 可能尚未解析，内部轮询）。
  relabelWhenReady()
})()
