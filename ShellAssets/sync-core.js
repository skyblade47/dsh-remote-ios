'use strict'

// ============================================================================
// ⑪ C11 · 多端文档同步的**纯逻辑**（零依赖 UMD，与渲染层/单测跑**同一份**）
//
// 设计权威：docs/superpowers/plans/2026-09-29-multidevice-doc-sync-design.md
//   传输面 = **客户端区**（远端路径相对 `客户端区/`：`正文/<作品>/<文档>.md`；agent 不自动看见）
//   拉取时机 = **懒拉取**（打开作品拉清单、打开文档按需拉正文）
//   删除语义 = 删除信号 = **云端回收目录**（方案 A）：`clientZoneList` 的 entries 覆盖整个客户端区，
//     `回收/正文/<原路径>` 有件 ⇒ 那头软删了，不补传、不复活；正文缺、回收也缺 ⇒ 自动补传。
//     旧端点的 `tombstones` 字段照旧只读解析（缺字段不判「未知」）。
//
// 🔴 三条铁律（本模块存在的理由）：
//   1. **永不自动覆盖**：远端比本地新 ⇒ 交给用户选，绝不直接盖。
//   2. **永不静默删**：见到墓碑只**提示**，删不删由用户定。
//   3. **「远端 = 无」与「远端 = 未知」必须分开**：离线/拉取失败**不是**"远端没有"；
//      把两者混起来会让离线端误判成"本地独有"甚至"远端已删" ⇒ 这是丢稿面的源头。
//
// 本模块**只做判断**：不碰 fs、不发网络、不碰 DOM。读写由 main.js / sync-net.js 负责。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  else root.WCSync = mod
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  /**
   * 远端草稿根（**相对 `客户端区/`** —— 2026-09-29 起从 agent 工作区分离出来）。
   * ⚠️ **两处必须一致**：本常量 · `send.js` 的 `DRAFT_ROOT`（都是 `正文/`）。
   * 本文件的自测里有一条**跨模块一致性锁**（拿 `send.draftRelPath` 对比）。
   * 🔴 端点参数**不带** `客户端区/` 前缀；要给人看时用 `send.displayPath()`。
   */
  var DRAFT_ROOT = '正文/'

  /** 与插件侧 `SIZE_LIMIT` 一致：单文件 2 MiB（读/写对称；S-5 已按"读也限"设计） */
  var SIZE_LIMIT = 2 * 1024 * 1024

  // ── 版本串：**逐字镜像** writing-studio/lib/draft-save-core.js 的 versionOf ──────
  // 🔴 必须逐字镜像（同种子、同 imul、同补零、**按 UTF-16 码元迭代**而不是按字节）——
  //    任何偏差都会让"同一份内容"算成两个版本 ⇒ 每篇文档都被判成"远端更新了"。
  function fnv1a32(str, seed) {
    var h = seed >>> 0
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h >>> 0
  }

  /**
   * 由内容算出稳定版本串。**与服务端 `versionOf` 必须逐字一致**。
   * @param {unknown} content
   * @returns {string} 形如 `v1-xxxxxxxxyyyyyyyy`
   */
  function versionOf(content) {
    var s = String(content === undefined || content === null ? '' : content)
    var a = fnv1a32(s, 0x811c9dc5)
    var b = fnv1a32(s, (0x9e3779b9 ^ s.length) >>> 0)
    return 'v1-' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
  }

  // ── 路径换算（本地 relPath ⇄ 远端 relPath）─────────────────────────────────

  /**
   * 远端 relPath（**相对 `客户端区/`**）→ 本地 relPath（剥掉 `正文/` 前缀）。
   * @param {unknown} remoteRel
   * @returns {string|null} 不在正文根下 ⇒ `null`（不抛）
   */
  function toLocalRel(remoteRel) {
    var s = typeof remoteRel === 'string' ? remoteRel : ''
    if (s.indexOf(DRAFT_ROOT) !== 0) return null
    var rest = s.slice(DRAFT_ROOT.length)
    return rest ? rest : null
  }

  /**
   * 本地 relPath → 远端 relPath。**不做清洗**（清洗由 `send.js::draftRelPath` 负责，
   * 本地 relPath 本就来自 `guard.listWorkspace`，已合法）。
   * @param {unknown} localRel
   * @returns {string|null}
   */
  function toRemoteRel(localRel) {
    var s = typeof localRel === 'string' ? localRel : ''
    if (!s || s.charAt(0) === '/') return null
    return DRAFT_ROOT + s
  }

  // ── 远端清单索引 ─────────────────────────────────────────────────────────

  /**
   * 回收件 relPath（服务端落点 `回收/正文/<作品>/<文档>.md`）→ 本地 relPath。
   * @param {unknown} recycleRel
   * @returns {string|null}
   */
  var RECYCLE_PREFIX = '回收/'
  function recycleToLocalRel(recycleRel) {
    var s = typeof recycleRel === 'string' ? recycleRel : ''
    if (s.indexOf(RECYCLE_PREFIX) !== 0) return null
    var inside = s.slice(RECYCLE_PREFIX.length)
    if (inside.indexOf(DRAFT_ROOT) !== 0) return null
    var rest = inside.slice(DRAFT_ROOT.length)
    return rest ? rest : null
  }

  /**
   * 硬删标记固定件（**相对 `客户端区/`** = `回收/_硬删标记.jsonl`）。
   * 服务端 walk 已显式跳过它；客户端解析清单时再兜底一次：既不进 archived 也不进 tomb。
   * 与服务端 `client-zone-core.js` 的 `CZ_PURGE_MARKER_REL` 逐字一致。
   */
  var PURGE_MARKER_REL = RECYCLE_PREFIX + '_硬删标记.jsonl'

  /**
   * 去 14 位时间戳（镜像服务端 `stripRecycleStamp`）：
   * 时间戳 = 扩展名前、最后一个 `-` 之后**恰 14 位数字**；剥离后得原文件名。
   * @param {unknown} fileName
   * @returns {{base:string, stamp:string}|null} 无合法戳 ⇒ `null`
   */
  function stripRecycleStamp(fileName) {
    var s = String(fileName === undefined || fileName === null ? '' : fileName)
    var i = s.lastIndexOf('.')
    var stem = i >= 0 ? s.slice(0, i) : s
    var ext = i >= 0 ? s.slice(i) : ''
    var h = stem.lastIndexOf('-')
    if (h < 0) return null
    var stamp = stem.slice(h + 1)
    if (!/^[0-9]{14}$/.test(stamp)) return null
    return { base: stem.slice(0, h) + ext, stamp: stamp }
  }

  /**
   * 回收件全路径（`回收/正文/<原路径>[-14位戳].md`）→ 正文原 rel。
   * 🔴 **与服务端 `client-zone-core.js::recycleOriginRel` 逐字镜像**：
   * · 有合法 14 位戳 ⇒ 剥戳还原；
   * · 无戳 / 戳非法（如 13 位）⇒ **原样映射**——它就是某份正文的归档件
   *   （首删无戳件最常见；名为 `怪-2026093015301.md` 的正文被删后也应产生删除信号）；
   * · 不在 `回收/正文/` 下（含空）⇒ `null`。
   * @param {unknown} recycleRel
   * @returns {string|null}
   */
  function recycleOriginRel(recycleRel) {
    var raw = recycleToLocalRel(recycleRel)
    if (!raw) return null
    var slash = raw.lastIndexOf('/')
    var fn = slash >= 0 ? raw.slice(slash + 1) : raw
    var st = stripRecycleStamp(fn)
    if (!st) return raw
    return (slash >= 0 ? raw.slice(0, slash + 1) : '') + st.base
  }

  /**
   * 同原路径的多件回收副本排序：文件名戳最新优先（有戳优先于无戳），再退 mtime 降序。
   * 与服务端 `matchRecycleEntries` 同口径。
   */
  function recycleRecNewer(a, b) {
    if (a.stamp && b.stamp) return a.stamp < b.stamp ? 1 : (a.stamp > b.stamp ? -1 : 0)
    if (a.stamp) return -1
    if (b.stamp) return 1
    var am = String(a.mtime || ''), bm = String(b.mtime || '')
    return am < bm ? 1 : (am > bm ? -1 : 0)
  }

  /**
   * 把 `clientZoneList` 的响应整理成**按本地 relPath 索引**的查表。
   * 🔴 **区分「已知」与「未知」**：响应不合法 / `ok:false` / 网络失败 ⇒ `known:false`。
   *    调用方**必须**先看 `known`，不要把 `known:false` 当成"远端什么都没有"。
   *
   * 列表字段**两种契约都收**：
   *   · 新（`clientZoneList`）：`{ok:true, entries:[{relPath,path,version,bytes,mtime}]}`，
   *     entries 覆盖整个客户端区 —— `正文/…` 是在世件、`回收/正文/…` 是**删除信号**（方案 A）；
   *   · 旧（`draft-list`）：`{ok:true, items:[…], tombstones:[…]}`。
   * 🔴 `tomb` 的两个来源都会解析：回收目录件（新，按去戳原 rel 归并）与旧契约 `tombstones`（只读兼容）。
   * 🔴 `archived`：回收件按去 14 位戳原 rel **归组**（多副本一组，spec §4.1），供 restore/§5.1 用。
   * 🔴 `purged`：响应顶层硬删表 `purged:[{relPath,at}]` 按正文原 rel 索引（spec §3.4）。
   *
   * @param {unknown} resp
   * @returns {{known:boolean, byRel:object, archived:object, purged:object, tomb:object, generatedAt:string|null}}
   */
  function indexList(resp) {
    var empty = { known: false, byRel: {}, archived: {}, purged: {}, tomb: {}, generatedAt: null }
    if (!resp || typeof resp !== 'object') return empty
    if (resp.ok !== true) return empty
    var items = Array.isArray(resp.entries) ? resp.entries : (Array.isArray(resp.items) ? resp.items : null)
    if (!items) return empty
    var tombs = Array.isArray(resp.tombstones) ? resp.tombstones : []
    var byRel = {}
    var tomb = {}
    var archived = {}
    for (var i = 0; i < items.length; i++) {
      var it = items[i]
      var rel = it && it.relPath
      if (typeof rel !== 'string') continue
      // 硬删标记固定件：服务端 walk 已剔，客户端再兜底（既不归档也不当墓碑）
      if (rel === PURGE_MARKER_REL) continue
      var lr = toLocalRel(rel)
      if (lr) {
        byRel[lr] = {
          version: typeof it.version === 'string' ? it.version : '',
          bytes: Number(it.bytes) || 0,
          mtime: it.mtime || null,
        }
        continue
      }
      // 回收件：按去戳原 rel 同时进 archived（归组）与 tomb（打开文档的删除信号）
      var origin = recycleOriginRel(rel)
      if (origin) {
        var slash2 = rel.lastIndexOf('/')
        var fn2 = slash2 >= 0 ? rel.slice(slash2 + 1) : rel
        var st2 = stripRecycleStamp(fn2)
        var rec = { relPath: rel, stamp: st2 ? st2.stamp : '', mtime: it.mtime || null,
          version: typeof it.version === 'string' ? it.version : '' }
        var g = archived[origin]
        if (!g) {
          archived[origin] = { latest: rel, version: rec.version, at: rec.mtime, count: 1, _top: rec }
        } else {
          g.count += 1
          if (recycleRecNewer(rec, g._top) < 0) {
            g.latest = rel
            g.version = rec.version
            g.at = rec.mtime
            g._top = rec
          }
        }
      }
    }
    // archived 定稿（剥内部 _top）并同步 tomb：tomb 按原 rel 取每组最新一件
    var akeys = Object.keys(archived)
    for (var ai = 0; ai < akeys.length; ai++) {
      var ak = akeys[ai]
      var ag = archived[ak]
      tomb[ak] = { deletedAt: ag.at, deletedBy: '', lastVersion: ag.version }
      delete ag._top
    }
    for (var j = 0; j < tombs.length; j++) {
      var tb = tombs[j]
      var tl = toLocalRel(tb && tb.relPath)
      if (!tl || tomb[tl]) continue
      tomb[tl] = {
        deletedAt: (tb && tb.deletedAt) || null,
        deletedBy: (tb && tb.deletedBy) || '',
        lastVersion: (tb && tb.lastVersion) || '',
      }
    }
    // 顶层硬删表：宽容解析（坏条目跳过）
    var purged = {}
    var plist = Array.isArray(resp.purged) ? resp.purged : []
    for (var p = 0; p < plist.length; p++) {
      var pe = plist[p]
      if (!pe || typeof pe !== 'object') continue
      if (typeof pe.relPath !== 'string' || !pe.relPath) continue
      if (!pe.at) continue
      purged[pe.relPath] = { at: pe.at }
    }
    return {
      known: true,
      byRel: byRel,
      archived: archived,
      purged: purged,
      tomb: tomb,
      generatedAt: typeof resp.generatedAt === 'string' ? resp.generatedAt : null,
    }
  }

  /**
   * 三态判定 —— 打开某篇文档时"该怎么办"。
   *
   * @param {object} input
   * @param {boolean} input.localExists
   * @param {string}  input.localContent   本地正文（`localExists` 为真时才有意义）
   * @param {boolean} input.remoteKnown    远端清单**是否**拿到了（离线 ⇒ false）
   * @param {boolean} input.remoteExists   远端**是否有**这份（`remoteKnown` 为真时才有意义）
   * @param {string}  input.remoteVersion  远端版本（`remoteExists` 为真时才有意义）
   * @param {number}  input.remoteBytes
   * @param {object}  input.tombstone      `{deletedAt,deletedBy,lastVersion}` 或 `null`
   * @param {boolean} input.purged         远端硬删表中有这份吗（spec §3.4；本地有正文 ⇒ 中性提示）
   * @param {string}  input.baselineVersion 上次成功同步时**远端**的版本（没有 ⇒ `''`）
   * @returns {{action:string, localVersion:string, remoteVersion:string, fromBaseline:boolean}}
   *
   * `action` 取值与处置（**全部只"建议"，副作用由调用方按用户选择执行**）：
   *   `unknown-remote`  远端未知（离线/拉取失败）⇒ **用本地**，状态栏标「未同步」
   *   `pull`            本地没有、远端有 ⇒ 拉正文落本地
   *   `in-sync`         两边版本一致（或 baseline 证明本就同源）⇒ 直接打开
   *   `local-only`      远端没有（**且无墓碑**）⇒ **什么都不做**（绝不因"远端没有"就删本地）
   *   `remote-newer`    本地相对 baseline **没改**、远端改了 ⇒ 弹两选【用远端】/【保留本地】
   *   `local-newer`     远端相对 baseline **没改**、本地改了 ⇒ 静默用本地（改动尚未推送，属正常）
   *   `conflict`        两边都动过（或无 baseline 可比）⇒ 走**三选**（覆盖/另存为/取消）
   *   `remote-deleted`  远端回收目录有这份（或旧契约墓碑）⇒ **提示**「远端已删除」+【保留本地】/【移入本地回收站】
   *   `remote-purged`   远端硬删表有这份（回收也已清空）⇒ 中性提示，**不重传、不自动删**
   *   `too-large`       远端正文超 2 MiB ⇒ 不拉，提示（本地仍有自己的那份）
   */
  function decide(input) {
    var o = input || {}
    var localExists = o.localExists === true
    var localVersion = localExists ? versionOf(o.localContent) : ''
    var base = typeof o.baselineVersion === 'string' ? o.baselineVersion : ''
    var remoteVersion = typeof o.remoteVersion === 'string' ? o.remoteVersion : ''
    var out = { localVersion: localVersion, remoteVersion: remoteVersion, fromBaseline: false }

    // ① 远端未知优先判（**绝不当成"远端没有"**）
    if (o.remoteKnown !== true) {
      out.action = localExists ? 'unknown-remote' : 'unknown-remote'
      return out
    }

    // ② 墓碑（远端已软删）—— **只提示，不自动删本地**
    //    例外：远端正文已回到原位（restore 后），回收里残留的更早时间戳副本
    //    仍会被 indexList 归组出 tomb，但删除信号已失效（spec §6/§7）——
    //    此时让出路，落到 ③ 起的正文存在判定 / 版本比对。
    if (o.tombstone && typeof o.tombstone === 'object' && o.remoteExists !== true) {
      if (!localExists) { out.action = 'in-sync'; return out }   // 两边都没有 ⇒ 无需动作
      out.action = 'remote-deleted'
      out.fromBaseline = !!base && localVersion === base
      return out
    }

    // ②b 硬删表（远端回收也已清空，只余有界标记，spec §5.1/§7）：
    //     本地正文没了 ⇒ 两边一致无需动作；本地正文还在 ⇒ 中性提示，**不重传、不自动删**
    if (o.purged === true) {
      if (!localExists) { out.action = 'in-sync'; return out }
      out.action = 'remote-purged'
      out.fromBaseline = !!base && localVersion === base
      return out
    }

    // ③ 远端没有这份（且无墓碑）
    if (o.remoteExists !== true) {
      out.action = localExists ? 'local-only' : 'in-sync'
      return out
    }

    // ④ 远端有：先看大小闸（读也限 2 MiB，与写对称）
    if (Number(o.remoteBytes) > SIZE_LIMIT) { out.action = 'too-large'; return out }

    // ⑤ 本地没有 ⇒ 直接拉
    if (!localExists) { out.action = 'pull'; return out }

    // ⑥ 两边都有：版本比对
    if (localVersion === remoteVersion) { out.action = 'in-sync'; return out }
    if (base && localVersion === base) { out.action = 'remote-newer'; out.fromBaseline = true; return out }
    if (base && remoteVersion === base) { out.action = 'local-newer'; out.fromBaseline = true; return out }
    // 无 baseline 或两边都动过 ⇒ 保守：走三选，绝不自动盖
    out.action = 'conflict'
    return out
  }

  // ── 「保存即推」的上行判据 ────────────────────────────────────────────────
  //
  // 背景（2026-09-29 用户报「本地保存的时候不推线上，导致客户端之间不能同步」）：
  // 原先推送只挂在「发送给任务中心」那条路上（`send-net.js`），而 `flush()`（自动保存 / Ctrl+S / 切文档）
  // **只写本地** ⇒ 多端看不到彼此的新稿。本函数把"该不该推"抽成纯判据，由 `writing.js` 在每次保存后调用。
  //
  // 🔴 六条闸（全在这一个函数里，不散落在渲染层）：
  //   ① **本地相对基线没动过 ⇒ 直接 skip，一个网络请求都不发**（自动保存很频繁，这一刀最省）
  //   ② 远端未知（离线/拉不到）⇒ 不推，也**不改任何状态**
  //   ③ 超过 2 MiB ⇒ 不推（与写端点同口径）
  //   ④ 远端没有这份（spec §5.1，基线 × archived × purged 全组合）：
  //      · purged 有 ⇒ **已硬删，不补传、不提供重传**（本地正文还在 ⇒ 中性横幅，不自动删）；
  //      · archived 有（含旧入参 remotelyDeleted）⇒ 已软删进回收，**不补传不复活**；
  //      · 两者都无 ⇒ 自动补传（无基线首次 create；有基线说明件被挪过/存储迁过，照样补，create）。
  //   ⑤ 其余 ⇒ 远端已被别人改过（或无基线可比）⇒ **永不自动覆盖**，交回用户决策
  //
  // @param {object} input
  // @param {string}  input.localVersion    本地当前内容的版本（`versionOf`）
  // @param {number}  input.localBytes
  // @param {string}  input.baselineVersion 上次成功同步时**远端**的版本（没有 ⇒ `''`）
  // @param {boolean} input.remoteKnown     远端清单拿到了吗（离线 ⇒ false）
  // @param {boolean} input.remoteExists
  // @param {string}  input.remoteVersion
  // @param {boolean} input.archived        远端回收目录里有这份的归档件吗（spec §4.1 archived）
  // @param {boolean} input.purged          远端硬删表里有这份吗（spec §3.4 purged）
  // @param {boolean} [input.remotelyDeleted] 旧入参，等价于 archived（平滑过渡）
  // @returns {{action:'push'|'skip'|'unknown'|'too-large'|'remote-deleted'|'remote-purged'|'remote-newer'|'conflict',
  //            reason:string, create?:boolean, baseVersion?:string}}
  function decidePush(input) {
    var o = input || {}
    var localVersion = typeof o.localVersion === 'string' ? o.localVersion : ''
    var base = typeof o.baselineVersion === 'string' ? o.baselineVersion : ''
    var remoteVersion = typeof o.remoteVersion === 'string' ? o.remoteVersion : ''
    var archived = o.archived === true || o.remotelyDeleted === true
    var purged = o.purged === true

    // ① 最省的一刀：本地相对基线没动过 ⇒ 不推（**自动保存的绝大多数触发都停在这里**）
    if (base && localVersion && localVersion === base) return { action: 'skip', reason: 'unchanged' }
    // ② 远端未知
    if (o.remoteKnown !== true) return { action: 'unknown', reason: 'remote-unknown' }
    // ③ 大小闸
    if (Number(o.localBytes) > SIZE_LIMIT) return { action: 'too-large', reason: 'over-limit' }
    // ④ 远端没有这份（spec §5.1）：硬删优先于软删；两删信号都无 ⇒ 自动补传
    if (o.remoteExists !== true) {
      if (purged) return { action: 'remote-purged', reason: 'purged' }
      if (archived) return { action: 'remote-deleted', reason: 'recycled' }
      return { action: 'push', reason: base ? 'reupload' : 'first-push', create: true, baseVersion: '' }
    }
    // ⑤ 远端没被别人改过 ⇒ 带上 baseVersion 推（服务端会再校一次，不符就 409）
    if (base && remoteVersion === base) {
      return { action: 'push', reason: 'push', create: false, baseVersion: base }
    }
    // ⑥ 已经同源（内容一模一样）⇒ 不必推
    if (localVersion && localVersion === remoteVersion) return { action: 'skip', reason: 'same-content' }
    // ⑦ 远端动过 / 无基线可比 ⇒ **不自动覆盖**
    if (base) return { action: 'remote-newer', reason: 'remote-changed' }
    return { action: 'conflict', reason: 'no-baseline' }
  }

  /** 上行 action → 人话 */
  var PUSH_TEXT = {
    push: '正在推送到服务器…',
    skip: '已是最新',
    unknown: '未同步（远端未知，改动留在本地）',
    'too-large': '正文超过 2 MiB —— 未推送（只在本地保存）',
    'remote-deleted': '远端已删除这份 —— 未推送（回收目录里有它，不复活）',
    'remote-purged': '这份在远端已被彻底删除 —— 未推送（不重传，本地副本由你决定去留）',
    'remote-newer': '远端有更新 —— 未推送，等你决定',
    conflict: '本地与远端无从比较 —— 未推送，等你决定',
  }

  /** 上行 action → 人话（未知 action 原样返回，不抛） */
  function pushText(action) {
    return PUSH_TEXT[action] || String(action == null ? '' : action)
  }

  // ── 同步基线（`userData/sync/baseline.json`，**不进工作区**）─────────────────

  /** 归一化基线文件（宽容解析：坏的/缺的 ⇒ 空基线；**丢了不影响正确性**，退化为按内容哈希比对） */
  function normalizeBaseline(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {}
    var items = (o.items && typeof o.items === 'object' && !Array.isArray(o.items)) ? o.items : {}
    var out = {}
    var keys = Object.keys(items)
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      var v = items[k]
      if (!k || !v || typeof v !== 'object') continue
      if (typeof v.remoteVersion !== 'string' || !v.remoteVersion) continue
      out[k] = { remoteVersion: v.remoteVersion, syncedAt: Number(v.syncedAt) || 0 }
    }
    return { version: 1, items: out }
  }

  /** 记下"这个本地 relPath 刚与远端的哪个版本对齐过"。**返回新对象**（不改入参）。 */
  function updateBaseline(base, localRel, remoteVersion, at) {
    var b = normalizeBaseline(base)
    if (!localRel || typeof remoteVersion !== 'string' || !remoteVersion) return b
    var items = {}
    var keys = Object.keys(b.items)
    for (var i = 0; i < keys.length; i++) items[keys[i]] = b.items[keys[i]]
    items[localRel] = { remoteVersion: remoteVersion, syncedAt: Number(at) || Date.now() }
    return { version: 1, items: items }
  }

  /** 移除某个 relPath 的基线（本地删除 / 远端删除 / 改名后都要清）。**返回新对象**。 */
  function dropBaseline(base, localRel) {
    var b = normalizeBaseline(base)
    var items = {}
    var keys = Object.keys(b.items)
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] === localRel) continue
      items[keys[i]] = b.items[keys[i]]
    }
    return { version: 1, items: items }
  }

  /** 取某 relPath 的基线版本（没有 ⇒ `''`） */
  function baselineVersionOf(base, localRel) {
    var b = normalizeBaseline(base)
    var hit = b.items[localRel]
    return hit ? hit.remoteVersion : ''
  }

  // ── 给人看的摘要（日志 / 状态栏 / 提示都用同一份口径）──────────────────────

  var ACTION_TEXT = {
    'unknown-remote': '远端未知（离线或拉取失败）—— 用的是本地副本',
    pull: '远端有这份、本地没有 —— 正在拉取',
    'in-sync': '已是最新',
    'local-only': '远端没有这份 —— 保持本地不动',
    'remote-newer': '远端有更新',
    'local-newer': '本地有未推送的改动',
    conflict: '本地与远端都改过 —— 需要你选',
    'remote-deleted': '远端已删除这份',
    'remote-purged': '这份在远端已被彻底删除（本地副本由你决定去留）',
    'too-large': '远端正文超过 2 MiB —— 未拉取',
  }

  /** `action` → 人话（未知 action 原样返回，不抛） */
  function actionText(action) {
    return ACTION_TEXT[action] || String(action == null ? '' : action)
  }

  return {
    DRAFT_ROOT: DRAFT_ROOT,
    SIZE_LIMIT: SIZE_LIMIT,
    PURGE_MARKER_REL: PURGE_MARKER_REL,
    versionOf: versionOf,
    toLocalRel: toLocalRel,
    toRemoteRel: toRemoteRel,
    recycleToLocalRel: recycleToLocalRel,
    stripRecycleStamp: stripRecycleStamp,
    recycleOriginRel: recycleOriginRel,
    indexList: indexList,
    decide: decide,
    decidePush: decidePush,
    pushText: pushText,
    normalizeBaseline: normalizeBaseline,
    updateBaseline: updateBaseline,
    dropBaseline: dropBaseline,
    baselineVersionOf: baselineVersionOf,
    actionText: actionText,
  }
})
