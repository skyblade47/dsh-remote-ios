import Foundation

enum S1ProbePage {
    static func html(gatewayOrigin: String) -> String {
        let expect = String(
            data: (try? JSONSerialization.data(withJSONObject: gatewayOrigin,
                                               options: [.fragmentsAllowed])) ?? Data(),
            encoding: .utf8) ?? "\"\""
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
        <h2>S1 四探针报告</h2><div id="out"></div>
        <script>
        const EXPECT = \(expect);
        const results = [];
        function record(name, pass, detail){ results.push({name, pass, detail}); }

        try {
          const origin = document.location.origin;
          record('① origin', origin === EXPECT,
                 'document.location.origin=' + origin + '\\ndocument.URL=' + document.URL + '\\n期望=' + EXPECT);
        } catch (e) { record('① origin', false, String(e)); }

        async function probeCookie(){
          try {
            const r = await fetch('/auth/login', {credentials:'include', cache:'no-store'});
            record('② Cookie', r.status === 200, 'GET /auth/login status=' + r.status);
          } catch (e) { record('② Cookie', false, String(e)); }
        }

        function probeIframe(){
          return new Promise(resolve => {
            const f = document.createElement('iframe');
            f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0';
            f.src = '/app#/';
            let done = false;
            const finish = (pass, detail) => { if(done) return; done=true; f.remove();
              record('③ iframe 帧安全', pass, detail); resolve(); };
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

        function probeSyncXHR(){
          try {
            const x = new XMLHttpRequest();
            x.open('GET', 'dsh-asset://local/ping', false);
            x.send();
            const o = JSON.parse(x.responseText);
            record('④ 同步 XHR', x.status === 200 && o.echo === 'pong',
                   'status=' + x.status + ' body=' + x.responseText);
          } catch (e) { record('④ 同步 XHR', false, String(e)); }
        }

        function render(){
          const el = document.getElementById('out');
          el.innerHTML = results.map(r =>
            '<div class="r"><div class="b ' + (r.pass?'g':'x') + '"></div><div>' +
            '<div class="t">' + r.name + '</div><div class="d">' + r.detail + '</div></div></div>'
          ).join('') + '<div class="d">四项全绿才进入 M1。</div>';
          const allGreen = results.length === 4 && results.every(r => r.pass);
          if (window.webkit && window.webkit.messageHandlers.s1Report) {
            window.webkit.messageHandlers.s1Report.postMessage(
              JSON.stringify({allGreen: allGreen, results: results}));
          }
        }

        (async () => {
          await probeCookie();
          await probeIframe();
          probeSyncXHR();
          render();
        })();
        <\/script></body></html>
        """
    }
}
