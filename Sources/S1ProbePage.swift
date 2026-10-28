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
        <h2>S1 五探针报告（localhost 主线）</h2><div id="out"></div>
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
        function probeShellAsset(){
          try {
            const x = new XMLHttpRequest();
            x.open('GET', '/__shell__/ping', false);
            x.send();
            record('④ 壳资产本地可达', x.status === 200 && x.responseText.indexOf('pong') !== -1,
                   'GET /__shell__/ping status=' + x.status + ' body=' + x.responseText);
          } catch (e) { record('④ 壳资产本地可达', false, String(e)); }
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
          probeShellAsset();
          probeSyncBridge();
          render();
        })();
        <\(slash)script></body></html>
        """
    }
}
