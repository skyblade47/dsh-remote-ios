import Foundation

enum S1ProbePage {
    /// Phase 5 五探针（全部以 localhost 反代为基准；`loopbackOrigin` 形如 http://127.0.0.1:<port>）。
    static func html(loopbackOrigin: String) -> String {
        let expect = String(
            data: (try? JSONSerialization.data(withJSONObject: loopbackOrigin,
                                               options: [.fragmentsAllowed])) ?? Data(),
            encoding: .utf8) ?? "\"\""
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
          .g{background:#1c9b47}.x{background:#d33}
          .t{font-weight:600}.d{font-size:13px;color:#444;white-space:pre-wrap;word-break:break-all}
          code{background:#eee;padding:1px 4px;border-radius:4px}
        </style></head><body>
        <h2>S1 五探针报告（localhost 主线）</h2>
        <div class="d" style="margin:0 0 10px;color:#888">构建 DIAG-B ／ 探针④=异步/同步 × diag/ipad.js 矩阵</div>
        <div id="out"></div>
        <script>
        const EXPECT = \(expect);
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

        // ④ 壳资产本地可达：/__shell__/ping 由反代本地应答（18 件资产走同一本地路由）
        // ④ 诊断矩阵（DIAG-B，临时）：区分「异步 fetch vs 同步 XHR」×「diag 回显 vs 真实资产」。
        //    假设：loadHTMLString 文档内同步 XHR 走 http loopback 被 WebKit 拦（空 404），
        //    而产品壳 18 资产走 <script>/<link> 异步子资源（主壳正常即已证明），与同步 XHR 无关。
        async function probeShellAsset(){
          const lines = [];
          let pass = true;
          // A：异步 fetch diag
          try {
            const r = await fetch('/__shell__/diag?m=A&t=' + Date.now(), {cache:'no-store'});
            const b = await r.text();
            const ok = r.status === 200 && b.indexOf('"diag":true') !== -1;
            if (!ok) pass = false;
            lines.push('A async fetch diag: status=' + r.status + ' body=' + b.slice(0, 120));
          } catch (e) { pass = false; lines.push('A async fetch diag: EXC ' + e); }
          // B：同步 XHR diag
          try {
            const x = new XMLHttpRequest();
            x.open('GET', '/__shell__/diag?m=B&t=' + Date.now(), false);
            x.send();
            const ok = x.status === 200 && x.responseText.indexOf('"diag":true') !== -1;
            if (!ok) pass = false;
            lines.push('B sync  XHR  diag: status=' + x.status + ' body=' + x.responseText.slice(0, 120));
          } catch (e) { pass = false; lines.push('B sync  XHR  diag: EXC ' + e); }
          // C：异步 fetch 真实资产 ipad.js（产品壳子资源同源路径）
          try {
            const r = await fetch('/__shell__/ipad.js?m=C&t=' + Date.now(), {cache:'no-store'});
            const b = await r.text();
            const ok = r.status === 200 && b.indexOf('gatewayConfigured') !== -1;
            if (!ok) pass = false;
            lines.push('C async fetch ipad.js: status=' + r.status + ' bytes=' + b.length
                       + (ok ? ' (含 gatewayConfigured)' : ' (内容不符)'));
          } catch (e) { pass = false; lines.push('C async fetch ipad.js: EXC ' + e); }
          // D：同步 XHR 真实资产 ipad.js
          try {
            const x = new XMLHttpRequest();
            x.open('GET', '/__shell__/ipad.js?m=D&t=' + Date.now(), false);
            x.send();
            const ok = x.status === 200 && x.responseText.indexOf('gatewayConfigured') !== -1;
            if (!ok) pass = false;
            lines.push('D sync  XHR  ipad.js: status=' + x.status + ' bytes=' + x.responseText.length
                       + (ok ? ' (含 gatewayConfigured)' : ' (内容不符)'));
          } catch (e) { pass = false; lines.push('D sync  XHR  ipad.js: EXC ' + e); }
          record('④ 本地壳路由矩阵（A/B=diag，C/D=ipad.js）', pass, lines.join('\\n'));
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
          ).join('') + '<div class="d">五项全绿才算 Phase 5 主线通过。</div>';
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
