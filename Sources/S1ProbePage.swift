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
        <!-- ④ 声明式子资源（与产品壳 shell.html 完全相同的加载机制，parser-initiated）。
             真机实测：JS 动态发起的 fetch / 动态 <script> 打向 /__shell__/* 会被 WKWebView
             合成空 404（不进反代）；而文档里声明的 <link>/<script> 与导航则正常。 -->
        <link rel="stylesheet" href="/__shell__/ipad.css?m=L" onload="window.__s1Link=1" onerror="window.__s1LinkErr=1">
        <script src="/__shell__/writing-count-core.js?m=S" onload="window.__s1Script=1" onerror="window.__s1ScriptErr=1"></script>
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

        // ④ 本地壳路由可达：/__shell__/* 由反代 ShellAssetRoutes 本地应答（不拨上游）。
        //    真机证据链：产品壳 shell.html 的 18 件资产（文档里声明的 <link>/<script>）全部命中；
        //    而 JS 动态发起的 fetch / createElement('script') 打向 /__shell__/* 会被合成空 404。
        //    故本探针改用与产品壳完全相同的三种通道：
        //      A 页面自身就是本地路由下发的文档（location.pathname 在 /__shell__/ 下）；
        //      B 文档里声明的 <link>/<script>（parser-initiated，见 head 里的 onload 标志）；
        //      C iframe 导航到 /__shell__/ping 并读文档体。
        async function probeShellAsset(){
          const lines = [];
          let pass = true;

          // A：页面自身来自本地路由
          const p = document.location.pathname;
          const selfLocal = p.indexOf('/__shell__/') === 0;
          if (!selfLocal) pass = false;
          lines.push('A 页面自身本地下发: ' + (selfLocal ? '是' : '否') + ' (' + p + ')');

          // B：声明式子资源（onload 由 HTML 源里的属性置位）
          const link = window.__s1Link === 1 ? 'ok'
                     : (window.__s1LinkErr === 1 ? 'onerror' : '未触发');
          const scr = window.__s1Script === 1 ? 'ok'
                    : (window.__s1ScriptErr === 1 ? 'onerror' : '未触发');
          if (link !== 'ok' || scr !== 'ok') pass = false;
          lines.push('B 声明式 <link ipad.css: ' + link
                     + ' ／ <script writing-count-core.js: ' + scr);

          // C：iframe 导航到本地路由（导航通道）并读文档体
          const nav = await new Promise(resolve => {
            const f = document.createElement('iframe');
            f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0';
            let done = false;
            const finish = (ok, detail) => {
              if (done) return; done = true; f.remove(); resolve({ok, detail});
            };
            f.onload = () => {
              try {
                const t = (f.contentWindow.document.body.textContent || '').trim();
                finish(t.indexOf('pong') !== -1, 'body=' + t.slice(0, 60));
              } catch (e) { finish(false, '读 body EXC ' + e); }
            };
            setTimeout(() => finish(false, '8s 超时（导航未 onload）'), 8000);
            f.src = '/__shell__/ping?m=N&t=' + Date.now();
            document.body.appendChild(f);
          });
          if (!nav.ok) pass = false;
          lines.push('C iframe 导航 /__shell__/ping: ' + (nav.ok ? 'pong' : 'FAIL')
                     + ' ' + nav.detail);

          record('④ 本地壳路由（自体本地下发 + 声明式子资源 + 导航）', pass, lines.join('\\n'));
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
