'use strict'
// relay 创作教练回程链路（2026-10-14，方案 C 闭环）
// 链路：send-net.js POST /taskkit/api/relay（带 requestId）→ 任务中心转派创作教练
//   → 服务端扫描创作教练会话产出 kind='coachSuggestions' 的 JSON 回写 relay-结果.json
//   → 本文件 GET /taskkit/api/relay-result?requestId=... 轮询 → 渲染建议列表 → 用户逐条点「应用」。
// 纯逻辑（校验/定位/替换/排序/汇总）全部复用 window.WCProofread（proofread.js），正文桥复用 __wcProofBridge。
// 🔴 硬约束：正文绝不被自动改写 —— 本文件里唯一会改正文的地方是「应用」按钮的点击回调（applyItem），
//    轮询与渲染全程只读。
// 可整段撤销：① 删本文件；② shell.html 去掉 .w-coach 面板与 coach-net.js 的 <script>；
//    ③ package.json build.files 去掉 coach-net.js；④ writing.js 去掉桥两方法/coachShowView/coachReset（Task 8）。
;(function () {
  'use strict'

  var Proof = window.WCProofread

  var RESULT_PATH = '/taskkit/api/relay-result'
  var POLL_MS = 2000
  var POLL_MS_SLOW = 5000
  var POLL_FAST_TIMES = 20
  var POLL_MAX_MS = 15 * 60 * 1000
  var POLL_IDLE_MS = 180 * 1000
  var SEV_LABEL = { must: '必改', should: '建议', nice: '可选' }

  var els = {}
  var st = { requestId: '', items: [], busy: false, run: null, startCtx: null }

  function bridge() { return window.__wcProofBridge || null }
  function say(text, isError) {
    var b = bridge()
    if (b && b.notice) b.notice(text, !!isError)
    else if (isError) console.error('[wc-coach] ' + text)
  }
  function msgText(e) { return (e && e.message) ? e.message : String(e) }
  function isAbort(e) {
    return !!(e && (e.name === 'AbortError' || e.code === 20 || /aborted|abort/i.test(msgText(e))))
  }
  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { resolve() }, ms)
      if (signal) signal.addEventListener('abort', function () {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
  }

  function cancelRun() {
    if (st.run) { try { st.run.abort() } catch (_) {} }
    st.run = null
  }

  function phaseText(status) {
    if (status === 'queued') return '已送达任务中心，排队中'
    if (status === 'dispatched') return '已转派创作教练，等待处理'
    if (status === 'running') return '创作教练处理中'
    if (status === 'done') return '已收到建议清单'
    if (status === 'timeout') return '等待超时：创作教练未在时限内产出'
    return '等待中'
  }

  function readResult(res) {
    return res.text().then(function (t) {
      var json = null
      if (t) { try { json = JSON.parse(t) } catch (_) { json = null } }
      return { status: res.status, ok: res.ok, text: t, json: json }
    })
  }

  async function pollResult(requestId, signal) {
    var t0 = Date.now()
    var lastProgressAt = t0
    var lastKey = ''
    var lastStatus = ''
    var fetchFails = 0
    var lastFetchErr = ''
    for (var n = 1; ; n++) {
      await sleep(n <= POLL_FAST_TIMES ? POLL_MS : POLL_MS_SLOW, signal)
      var waited = Date.now() - t0
      var idle = Date.now() - lastProgressAt
      var tail = fetchFails > 0 ? '（读取失败 ' + fetchFails + '/5：' + lastFetchErr + '）' : ''
      setStatus((lastStatus ? phaseText(lastStatus) : '已发送，等待任务中心接收') + '（已等 ' + Math.round(waited / 1000) + 's' + tail + '）')

      var r
      try {
        r = await fetch(RESULT_PATH + '?requestId=' + encodeURIComponent(requestId), { signal: signal })
          .then(readResult)
      } catch (e) {
        if (isAbort(e)) throw e
        fetchFails++
        lastFetchErr = msgText(e)
        if (fetchFails >= 5) throw new Error('连续 5 次读取创作教练结果均失败：' + lastFetchErr)
        continue
      }

      var key = ''
      if (r.status === 404) {
        fetchFails = 0
        key = '404'
      } else if (!r.ok) {
        fetchFails++
        lastFetchErr = 'HTTP ' + r.status
        if (fetchFails >= 5) throw new Error('连续 5 次读取创作教练结果均失败：' + lastFetchErr)
        continue
      } else {
        var item = r.json && r.json.item
        if (!item) {
          fetchFails++
          lastFetchErr = '响应缺少 item'
          if (fetchFails >= 5) throw new Error('连续 5 次读取创作教练结果均失败：' + lastFetchErr)
          continue
        }
        fetchFails = 0
        lastStatus = item.status
        key = item.status + '|' + (item.updatedAt || 0) + '|' + (item.lastSeq || 0) + '|' + (item.suggestions ? 1 : 0)
        if (item.status === 'done') return item
        if (item.status === 'timeout') throw new Error('等待超时（创作教练未在 15 分钟内产出建议清单）')
      }

      if (key !== lastKey) { lastKey = key; lastProgressAt = Date.now() }
      if (Date.now() - lastProgressAt > POLL_IDLE_MS) {
        throw new Error('等待空闲超时（3 分钟没有新进展），可稍后重新发送')
      }
      if (Date.now() - t0 > POLL_MAX_MS) {
        throw new Error('等待超时（已等 15 分钟）：创作教练结果未就绪')
      }
    }
  }

  async function start(opts) {
    if (st.busy) return
    var b = bridge()
    if (!Proof) { fail('校对纯逻辑模块没加载（proofread.js 版本不匹配？）'); return }
    if (!b) { fail('写作客户端桥没找到（shell 版本不匹配？）'); return }
    var requestId = opts && typeof opts.requestId === 'string' ? opts.requestId.trim() : ''
    if (!requestId) { fail('缺少 requestId，无法等待创作教练结果'); return }
    var ctx = b.context()
    var ctl = new AbortController()
    st.requestId = requestId
    st.items = []
    st.busy = true
    st.run = ctl
    st.startCtx = ctx
    paint()
    setStatus('已发送，等待任务中心转派…')
    try {
      var item = await pollResult(st.requestId, ctl.signal)
      var nowCtx = b.context()
      if (!nowCtx || (ctx && nowCtx.relPath !== ctx.relPath)) {
        setStatus('创作教练建议已返回，但期间已切换到别的文档 ⇒ 结果未应用')
        say('创作教练建议已返回，但期间已切换到别的文档 ⇒ 结果未应用（回到原文档需重新发送）')
        return
      }
      var rep = Proof.validateReport(item.suggestions)
      if (!rep.ok) throw new Error('创作教练返回的建议清单无法识别：' + (rep.errors[0] || '格式不符'))
      st.items = Proof.sortItems(rep.items)
      paint()
      setStatus(statusSummary())
      if (!st.items.length) say('创作教练本次没有给出修改建议')
    } catch (e) {
      if (isAbort(e)) setStatus('已取消等待')
      else { setStatus('等待失败：' + msgText(e)); say(msgText(e), true) }
    } finally {
      st.busy = false
      st.run = null
      setBusy(false)
    }
  }

  async function applyItem(id) {
    var it = st.items.find(function (x) { return x.id === id })
    if (!it) return
    var b = bridge()
    if (!b) { say('写作客户端桥没找到（shell 版本不匹配？）', true); return }
    if (b.editable && !b.editable()) { say('没有打开文档，无法应用', true); return }
    var r = Proof.applySuggestion(b.text() || '', it)
    if (!r.ok) {
      it.failed = r.error
      paint()
      say('没找到这条原文，未改动（' + r.error + '）', true)
      return
    }
    if (!r.changed) { dropItem(id); paint(); return }
    b.setText(r.text)
    dropItem(id)
    for (var k = 0; k < st.items.length; k++) {
      var lr = Proof.locateItem(b.text() || '', st.items[k])
      if (!lr.ok) st.items[k].failed = lr.error
    }
    paint()
    setStatus(statusSummary())
    var f = b.flush ? await b.flush() : null
    if (f && f.ok === false) { say('已改这一处，但保存失败：' + ((f && f.error) || '未知错误'), true); return }
    say('已应用 1 条修改（其余内容未动）')
  }

  function dropItem(id) {
    st.items = st.items.filter(function (x) { return x.id !== id })
  }

  function renderList() {
    if (!els.list) return
    els.list.textContent = ''
    st.items.forEach(function (it) {
      ;(function (it) {
        var row = document.createElement('div')
        row.className = 'w-proof-item' + (it.failed ? ' is-failed' : '') + ' is-collapsed'
        row.setAttribute('data-id', it.id)

        var head = document.createElement('div')
        head.className = 'w-proof-item-head'
        var sev = document.createElement('span')
        var sv = Proof.normSeverity(it.severity)
        sev.className = 'w-proof-sev is-' + sv
        sev.textContent = SEV_LABEL[sv] || '建议'
        head.appendChild(sev)
        var idx = document.createElement('span')
        idx.className = 'w-proof-card-idx'
        idx.textContent = (st.items.indexOf(it) + 1) + '/' + st.items.length
        head.appendChild(idx)
        var caret = document.createElement('span')
        caret.className = 'w-proof-card-caret'
        caret.textContent = '▶'
        head.appendChild(caret)
        row.appendChild(head)

        var body = document.createElement('div')
        body.className = 'w-proof-diff'
        var orig = document.createElement('div')
        orig.className = 'w-proof-orig'
        orig.textContent = it.original
        var arrow = document.createElement('span')
        arrow.className = 'w-proof-arrow'
        arrow.textContent = ' → '
        var sug = document.createElement('div')
        sug.className = 'w-proof-sug'
        sug.textContent = it.suggestion === '' ? '（删除）' : it.suggestion
        body.appendChild(orig)
        body.appendChild(arrow)
        body.appendChild(sug)
        row.appendChild(body)

        if (it.reason) {
          var reason = document.createElement('div')
          reason.className = 'w-proof-reason'
          reason.textContent = it.reason
          row.appendChild(reason)
        }
        if (it.failed) {
          var failLine = document.createElement('div')
          failLine.className = 'w-proof-fail'
          failLine.textContent = '⚠ ' + it.failed
          row.appendChild(failLine)
        }

        var acts = document.createElement('div')
        acts.className = 'w-proof-acts'
        var go = document.createElement('button')
        go.className = 'w-mini'
        go.setAttribute('data-act', 'apply')
        go.textContent = '应用'
        go.title = '只改这一处；正文其余内容不动'
        var skip = document.createElement('button')
        skip.className = 'w-mini'
        skip.setAttribute('data-act', 'skip')
        skip.textContent = '忽略'
        skip.title = '从列表里去掉这条（不改正文）'
        acts.appendChild(go)
        acts.appendChild(skip)
        row.appendChild(acts)

        row.addEventListener('click', function (e) {
          var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act')
          if (act === 'apply') { e.stopPropagation(); applyItem(it.id); return }
          if (act === 'skip') { e.stopPropagation(); dropItem(it.id); paint(); return }
          row.classList.toggle('is-collapsed')
        })
        els.list.appendChild(row)
      })(it)
    })
  }

  function statusSummary() {
    var sum = Proof.summarize(st.items)
    return sum.total + ' 条（必改 ' + sum.must + ' · 建议 ' + sum.should + ' · 可选 ' + sum.nice + '）'
  }
  function setStatus(t) { if (els.status) els.status.textContent = t || '' }
  function setBusy(v) {
    st.busy = !!v
    if (els.cancel) els.cancel.hidden = !st.busy
  }
  function paint() {
    var sum = Proof.summarize(st.items)
    if (els.count) els.count.textContent = st.items.length ? (sum.total + ' 条（必改 ' + sum.must + ' · 建议 ' + sum.should + ' · 可选 ' + sum.nice + '）') : ''
    renderList()
    setBusy(st.busy)
  }

  function reset() {
    cancelRun()
    st.requestId = ''
    st.items = []
    st.startCtx = null
    if (els.list) els.list.textContent = ''
    if (els.count) els.count.textContent = ''
    setStatus('发送「今日成果」后，创作教练的修改建议会出现在这里（只给建议，不改正文）')
    setBusy(false)
  }

  function collectEls() {
    els.cancel = document.getElementById('w-coach-cancel')
    els.status = document.getElementById('w-coach-status')
    els.count = document.getElementById('w-coach-count')
    els.list = document.getElementById('w-coach-list')
  }
  function fail(msg) {
    var el = document.getElementById('w-coach-status')
    if (el) el.textContent = msg
    var b = bridge()
    if (b && b.notice) b.notice(msg, true)
    else console.error('[wc-coach] ' + msg)
  }

  function init() {
    if (!Proof) { fail('校对纯逻辑模块没加载（proofread.js 版本不匹配？）'); return }
    collectEls()
    if (!els.cancel || !els.list) { fail('右栏创作教练面板没找到（shell.html 版本不匹配？）'); return }
    els.cancel.addEventListener('click', function () { cancelRun() })
    reset()
  }

  window.__wcCoachStart = start
  window.__wcCoachReset = reset

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
