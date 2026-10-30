import Foundation

enum S1ProbePage {
    /// Phase 5 五探针（全部以 localhost 反代为基准）。
    /// 页面由反代本地下发（`/__s1__/probe`）并走真实 HTTP 导航，`loopbackOrigin` 可留空，
    /// 此时以 `document.location.origin` 作为期望值。
    static func html(loopbackOrigin: String = "") -> String {
        let expect = String(
            data: (try? JSONSerialization.data(withJSONObject: loopbackOrigin,
                                               options: [.fragmentsAllowed])) ?? Data(),
            encoding: .utf8) ?? "\"\""
        // 未注入 origin 时（本地下发场景）以文档自身 origin 为期望值。
        let expectExpr = loopbackOrigin.isEmpty ? "document.location.origin" : expect
        let slash = "/"
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
        <title>S1</title>
        <style>
          body{font:-apple-system,Sans-serif;margin:0;padding:16px;background:#f6f7f9;color:#111}
          h2{font-size:18px;margin:0 0 12px}
          .r{display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:10px;margin:8px 0;background:#fff}
          .b{width:14px;height:14px;border-radius:50%;margin-top:3px;flex:none}
          .g{background:#1c9b47}.x{background:#d33}.z{background:#8a93a6}
          .t{font-weight:600}.d{font-size:13px;color:#444;white-space:pre-wrap;word-break:break-all}
          code{background:#eee;padding:1px 4px;border-radius:4px}
        </style></head><body>
        <h2>S1 五探针报告（localhost 主线）</h2>
        <div class="d" style="margin:0 0 10px;color:#888">Phase 5 五探针 — 页面由反代本地下发，走真实 HTTP 导航（与产品壳同一路径）</div>
        <div id="out"></div>
        <script>
        const EXPECT = \(expectExpr);
        const results = [];
        function record(name, pass, detail){ results.push({name, pass, detail}); }

        // ① origin 必须是 http://127.0.0.1:<port>（Phase 5 起壳固定 localhost，不再借网关 https origin）
        try {
          const origin = document.location.origin;
          record('① origin localhost', /^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(origin) && origin === EXPECT,
                 'document.location.origin=' + origin + '\\n期望=' + EXPECT);
        } catch (e) { record('① origin localhost', false, String(e)); }

        // ② /auth/login 经反代（tailscale_dial → 100.99.84.35:8080）可达且同源
        async function probeLogin(){
          try {
            const r = await fetch('/auth/login', {credentials:'include', cache:'no-store'});
            record('② /auth/login 经反代', r.status === 200, 'GET /auth/login status=' + r.status);
          } catch (e) { record('② /auth/login 经反代', false, String(e)); }
        }

        // ③ iframe /app#/ 同源可读（frame-ancestors 'self' 在同源成立；内核页可被壳读取 location）
        function probeIframe(){
          return new Promise(resolve => {
            const f = document.createElement('iframe');
            f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0';
            f.src = '/app#/';
            let done = false;
            const finish = (pass, detail) => { if(done) return; done=true; f.remove();
              record('③ iframe 同源', pass, detail); resolve(); };
            f.onload = () => {
              setTimeout(() => {
                try {
                  const href = f.contentWindow.location.href;
                  finish(href.indexOf(EXPECT) === 0 && href.indexOf('/app') !== -1,
                         '可读 contentWindow.location.href=' + href);
                } catch (e) { finish(false, '读 contentWindow.location 抛跨源/被拒: ' + e); }
              }, 400);
            };
            f.onerror = () => finish(false, 'iframe onerror');
            setTimeout(() => finish(false, '8s 超时（可能被 X-Frame-Options/frame-ancestors 拒）'), 8000);
            document.body.appendChild(f);
          });
        }

        // ④ 壳资产本地可达：/__shell__/* 由反代 ShellAssetRoutes 本地应答（不拨上游）。
        //    真机证据：真实导航文档里该路由 100% 可靠（产品壳 18 件资产 <script>/<link>
        //    全部命中）；旧的 loadHTMLString 文档会随机合成空 404，故探针页已改为本地下发。
        //    - ping 用 fetch 校验本地路由应答；
        //    - ipad.js 用 <script> 标签注入（产品壳真实子资源机制）；
        //    - 原 B/D 同步 XHR 已由探针⑤ dsh-bridge:// 单独验证，不再重复。
        async function probeShellAsset(){
          const lines = [];
          let pass = true;

          // A：fetch 本地壳路由 /__shell__/ping（应回 JSON pong，且绝不该拨上游）
          try {
            const r = await fetch('/__shell__/ping?m=A&t=' + Date.now(), {cache:'no-store'});
            const b = await r.text();
            const ok = r.status === 200 && b.indexOf('pong') !== -1;
            if (!ok) pass = false;
            lines.push('A fetch ping: status=' + r.status + ' bytes=' + b.length
                       + (ok ? ' (pong)' : ' body=' + b.slice(0, 120)));
          } catch (e) { pass = false; lines.push('A fetch ping: EXC ' + e); }

          // C：<script> 标签注入 /__shell__/ipad.js（产品壳真实子资源机制）
          try {
            const script = new Promise((resolve) => {
              let done = false;
              const s = document.createElement('script');
              const finish = (ok, detail) => {
                if (done) return; done = true;
                if (s.parentNode) s.parentNode.removeChild(s);
                resolve({ok, detail});
              };
              s.onload = () => setTimeout(() => {
                // ipad.js 的 IIFE 只把 window.__wciPadShell = true 暴露在全局
                // （gatewayConfigured 等是内部函数，不挂 window）。
                const ok = window.__wciPadShell === true;
                finish(ok, ok
                  ? 'ipad.js 加载成功（__wciPadShell=true）'
                  : 'ipad.js onload 但 __wciPadShell 未设');
              }, 100);
              s.onerror = () => finish(false, 'ipad.js script.onerror');
              setTimeout(() => finish(false, 'ipad.js 8s 超时'), 8000);
              s.src = '/__shell__/ipad.js?m=C&t=' + Date.now();
              document.head.appendChild(s);
            });
            const res = await script;
            if (!res.ok) pass = false;
            lines.push('C <script> ipad.js: ' + res.detail);
          } catch (e) { pass = false; lines.push('C <script> ipad.js: EXC ' + e); }

          record('④ 本地壳路由（fetch ping/diag + script 注入 ipad.js）', pass, lines.join('\\n'));
        }

        // ⑤ dsh-bridge 同步写盘通道：在 http loopback origin 下实测自定义 scheme 同步 XHR。
        //    注册的是真实 BridgeSyncSchemeHandler（__ping__ 回 {ok:true,echo:"pong"}）。
        //    Task 5.6 以此探针真机结论决定保留自定义 scheme 还是改 loopback POST 端点。
        function probeSyncBridge(){
          try {
            const x = new XMLHttpRequest();
            x.open('POST', 'dsh-bridge://sync?m=__ping__', false);
            x.send(JSON.stringify({method:'__ping__', args:[]}));
            const o = JSON.parse(x.responseText);
            record('⑤ dsh-bridge 同步 XHR',
                   x.status === 200 && o.ok === true && o.echo === 'pong',
                   'status=' + x.status + ' body=' + x.responseText);
          } catch (e) { record('⑤ dsh-bridge 同步 XHR', false, String(e)); }
        }

        function render(){
          const el = document.getElementById('out');
          el.innerHTML = results.map(r =>
            '<div class="r"><div class="b ' + (r.pass?'g':'x') + '"></div><div>' +
            '<div class="t">' + r.name + '</div><div class="d">' + r.detail + '</div></div></div>'
          ).join('') + '<div class="d">①–⑤全绿即 Phase 5 主线通过。</div>';
          const allGreen = results.length === 5 && results.every(r => r.pass);
          if (window.webkit && window.webkit.messageHandlers.s1Report) {
            window.webkit.messageHandlers.s1Report.postMessage(
              JSON.stringify({allGreen: allGreen, results: results}));
          }
        }

        (async () => {
          await probeLogin();
          await probeIframe();
          await probeShellAsset();
          probeSyncBridge();
          render();
        })();
        <\(slash)script></body></html>
        """
    }
}
