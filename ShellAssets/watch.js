'use strict'

// ============================================================================
// 写作客户端 · 「旧路径看门狗」纯逻辑（B3 兜底 · 2026-09-27 用户要求）
//
// 场景：改名 / 移动 / **删除**「正在编辑」的文档之后，旧路径不该再出现。
//   万一还有别处把它"复活"（漏改的定时器、草稿回写、将来新增的写入方），
//   或者新路径根本没落住（指向错误），我们希望能**当场看见**，而不是过几天发现多出一个文件。
//
// 分工（照 send.js / send-net.js 的先例）：
//   · watch.js      —— 本文件：**纯判据**（这一轮探到了什么异常 / 还在不在看护期内），零 DOM、零 IPC
//   · writing.js    —— 渲染层：开计时器、调 readDoc、把判据结果变成用户提示
//   · watch.test.js —— node 直接跑**同一份**判据
//
// 🔴 **只提示、只记日志，绝不自动改** —— 自动"修"会把真正的成因盖掉，反而难排查。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCWatch = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  /** 看护时长：改动当前文档后盯旧路径多久 */
  var WATCH_MS = 60000
  /** 探测间隔：多久核一次 */
  var WATCH_TICK = 3000

  /** 读回内容的字符数（拿不到按 0） */
  function chars(s) {
    return String(s == null ? '' : s).length
  }

  /**
   * 一轮探测的判据（纯函数）。
   * @param {{oldRel:string, newRel:(string|null), oldRead:object, newRead:object}} o
   *   oldRead / newRead 形如 `{ ok:boolean, error?:string, content?:string }`（= `readDoc` 的返回值）
   * @returns {Array<{kind:string, detail:string}>} 该报的异常（两条都命中就给两条，一条都不命中给 []）
   */
  function findings(o) {
    o = o || {}
    var out = []
    // ① 旧路径**又出现**了 —— 本该消失的东西回来了
    if (o.oldRead && o.oldRead.ok) {
      out.push({
        kind: '旧路径复活',
        detail: o.oldRel + ' 又出现了（读回 ' + chars(o.oldRead.content) + ' 字符）',
      })
    }
    // ② 新路径**读不到** —— 只有「改名 / 移动」才有新路径；「删除」没有 ⇒ 不查这条
    if (o.newRel && o.newRead && !o.newRead.ok) {
      out.push({
        kind: '指向错误',
        detail: o.newRel + ' 读不到：' + (o.newRead.error || '未知错误'),
      })
    }
    return out
  }

  /**
   * 是否还在看护期内。
   * ⚠️ 工作区换了 ⇒ 判据整体失效（相对路径的含义已变）⇒ 一律 false。
   */
  function inWindow(o) {
    o = o || {}
    if (o.root !== o.watchRoot) return false
    if (typeof o.now !== 'number' || typeof o.until !== 'number') return false
    return o.now <= o.until
  }

  return {
    WATCH_MS: WATCH_MS,
    WATCH_TICK: WATCH_TICK,
    chars: chars,
    findings: findings,
    inWindow: inWindow,
  }
})
