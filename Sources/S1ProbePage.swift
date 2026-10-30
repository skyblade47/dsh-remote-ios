import Foundation

enum S1ProbePage {
    /// Phase 5 五探针（全部以 localhost 反代为基准；`loopbackOrigin` 形如 http://127.0.0.1:<port>）。
    static func html(loopbackOrigin: String, nativeDiag: String = "(未采集)") -> String {
        let expect = String(
            data: (try? JSONSerialization.data(withJSONObject: loopbackOrigin,
                                               options: [.fragmentsAllowed])) ?? Data(),
            encoding: .utf8) ?? "\"\""
        // 原生侧真值（App 进程 URLSession 直连 127.0.0.1:<port>），JSON 字符串字面量，安全注入。
        let native = String(
            data: (try? JSONSerialization.data(withJSONObject: nativeDiag,
                                               options: [.fragmentsAllowed])) ?? Data(),
            encoding: .utf8) ?? "\"(编码失败)\""
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
        <div class="d" style="margin:0 0 10px;color:#888">S1 主探针收敛版 — ④ warmup+script 注入；⑥⑦⑧⑨临时诊断保留待清理</div>
        <div id="out"></div>
        <script>
        const EXPECT = \(expect);
        const NATIVE = \(native);
        const results = [];
        function record(name, pass, detail, isDiag){ results.push({name, pass, detail, diag: !!isDiag}); }

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

        // ④ 壳资产本地可达：/__shell__/* 由反代 ShellAssetRoutes 本地应答。
        //    DIAG-G 证据：native URLSession 全通（⑨）；iframe <script>/<link> 加载 18 件资产
        //    全通（ring entries 1-19）；loadHTMLString 文档内 fetch/XHR 行为不稳定
        //    （P2/probe② fetch 成功但 probe④/⑥ 失败，与 timing/连接池状态相关）。
        //    收敛：
        //    - diag 用 fetch + 3 次重试（P2 已证明 fetch 在 warmup 后能通）；
        //    - ipad.js 用 <script> 标签注入（产品壳真实机制，ring entries 2-19 证明 100% 可靠）；
        //    - 原 B/D 同步 XHR 已由探针⑤ dsh-bridge:// 单独验证，不再重复。
        async function probeShellAsset(){
          const lines = [];
          let pass = true;

          // 先 warmup 一下：fetch /__shell__/ping 重试最多 3 次，等待 HTTP 连接池就绪
          const warmup = async () => {
            for (let i = 0; i < 3; i++) {
              try {
                const r = await fetch('/__shell__/ping?warmup=' + i + '&t=' + Date.now(),
                                      {cache:'no-store'});
                const b = await r.text();
                if (r.status === 200 && b.indexOf('pong') !== -1) {
                  return {ok:true, detail:'warmup#' + i + ' ping OK (status=' + r.status + ')'};
                }
              } catch (e) {}
              await new Promise(res => setTimeout(res, 300));
            }
            return {ok:false, detail:'warmup 3 次全部失败'};
          };
          const w = await warmup();
          lines.push('warmup: ' + w.detail);
          if (!w.ok) pass = false;

          // A：fetch /__shell__/diag（异步 fetch，probe⑧ P2 已证明能通）
          try {
            const r = await fetch('/__shell__/diag?m=A&t=' + Date.now(), {cache:'no-store'});
            const b = await r.text();
            const ok = r.status === 200 && b.indexOf('"diag":true') !== -1;
            if (!ok) pass = false;
            lines.push('A fetch diag: status=' + r.status + ' bytes=' + b.length
                       + (ok ? ' (diag:true)' : ' body=' + b.slice(0, 120)));
          } catch (e) { pass = false; lines.push('A fetch diag: EXC ' + e); }

          // C：<script> 标签注入 /__shell__/ipad.js（产品壳真实机制，ring 1-19 证明 100%）
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

          record('④ 本地壳路由（warmup+fetch diag + script 注入 ipad.js）', pass, lines.join('\\n'));
        }

        // ⑥ DIAG-D（临时，信息项不计五绿）：多路径形态矩阵 + 反代到达日志环。
        //    先发一组形态各异的路径（全部异步 fetch，8s 超时），再拉 /diag-log
        //    看哪些 raw target 真正到达了 listener——空 404 的路径若不在环里，
        //    即证明请求未进反代（被 WebKit 在网络栈外合成拦掉）。
        async function probeDiagPathMatrix(){
          const paths = [
            '/__shell__/diag?m=D0',
            '/__diag__/x?m=D1',
            '/shell/diag?m=D2',
            '/_shell_/diag?m=D3',
            '/abc__/x?m=D4',
            '/__abc/x?m=D5',
            '/shell__extra/diag?m=D6',
            '/zzz/plain?m=D7'
          ];
          const lines = [];
          // 清空到达环，只留本轮矩阵轨迹
          try {
            await fetch('/diag-log?clear=1&t=' + Date.now(), {cache:'no-store'});
          } catch (e) { lines.push('清环失败: ' + e); }
          await Promise.all(paths.map(async p => {
            try {
              const ctrl = new AbortController();
              const to = setTimeout(() => ctrl.abort(), 8000);
              const r = await fetch(p + '&t=' + Date.now(), {cache:'no-store', signal: ctrl.signal});
              clearTimeout(to);
              const b = await r.text();
              lines.push(p + ' -> status=' + r.status + ' bytes=' + b.length);
            } catch (e) {
              lines.push(p + ' -> EXC ' + e);
            }
          }));
          // 稍等一拍确保服务端落环，再取回环原文
          await new Promise(res => setTimeout(res, 300));
          let ring = '(取环失败)';
          try {
            const r = await fetch('/diag-log?t=' + Date.now(), {cache:'no-store'});
            ring = await r.text();
          } catch (e) { ring = '取环 EXC ' + e; }
          record('⑥ 路径矩阵 + 到达日志环（信息项）', true,
                 '客户端观察：\\n' + lines.join('\\n') + '\\n\\n服务端到达环：\\n' + ring, true);
        }

        // ⑦ DIAG-E（临时，信息项）：一锤定音验证「根 scope Service Worker 接管 loadHTMLString 文档，
        //    直通请求被 WKWebView 合成空 404、不进 listener」假设。
        //    取证 controller/registrations/caches → E0 注销前父页 fetch → 注销全部 SW+清缓存
        //    → E1 注销后父页 fetch → E2 全新 iframe（注销后新建，按 spec 不被任何 SW 控制）fetch。
        //    最后再用全新 iframe 读 /diag-log，看 E0/E1/E2 哪些 marker 真正到达 listener。
        async function probeServiceWorker(){
          const L = [];
          const has = ('serviceWorker' in navigator);
          L.push('navigator.serviceWorker=' + (has ? '存在' : '不存在'));
          if (!has) { record('⑦ Service Worker 取证/A-B（信息项）', true, L.join('\\n'), true); return; }

          // —— 取证：当前控制者 + 全部注册项 + 缓存名 ——
          let ctrl = '(无 controller)';
          try {
            if (navigator.serviceWorker.controller) {
              ctrl = navigator.serviceWorker.controller.scriptURL
                + ' state=' + navigator.serviceWorker.controller.state;
            }
          } catch (e) { ctrl = '读 controller EXC ' + e; }
          L.push('controller=' + ctrl);
          try {
            const regs = await navigator.serviceWorker.getRegistrations();
            L.push('registrations(' + regs.length + ')=');
            for (const r of regs) {
              L.push('  scope=' + r.scope
                + ' active=' + (r.active ? r.active.scriptURL.split('/').pop() : '-')
                + ' installing=' + (r.installing ? r.installing.scriptURL.split('/').pop() : '-'));
            }
          } catch (e) { L.push('getRegistrations EXC ' + e); }
          try {
            const keys = await caches.keys();
            L.push('caches(' + keys.length + ')=' + (keys.join(',') || '(空)'));
          } catch (e) { L.push('caches.keys EXC ' + e); }

          const shot = async (marker) => {
            try {
              const r = await fetch('/__shell__/ping?m=' + marker + '&t=' + Date.now(),
                                    {cache:'no-store'});
              const b = await r.text();
              return marker + ': status=' + r.status + ' bytes=' + b.length
                + (b.indexOf('pong') !== -1 ? ' (pong)' : ' (空/非pong)');
            } catch (e) { return marker + ': EXC ' + e; }
          };

          // E0：注销前父页（此时预期被根 SW 控制 → 空 404）
          L.push('--- E0 注销前父页 ---');
          L.push(await shot('E0'));

          // 注销全部注册 + 清全部缓存
          let unregN = 0;
          try {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) { if (await r.unregister()) unregN++; }
          } catch (e) { L.push('注销 EXC ' + e); }
          let delN = 0;
          try {
            const keys = await caches.keys();
            for (const k of keys) { if (await caches.delete(k)) delN++; }
          } catch (e) { L.push('清缓存 EXC ' + e); }
          L.push('已注销注册 ' + unregN + ' 个、清缓存 ' + delN + ' 个');

          // 等 SW 控制状态收敛（父页 controller 在 SW 注销后是否立即释放，各实现不一）
          await new Promise(res => setTimeout(res, 600));
          try {
            L.push('注销后 controller=' +
              (navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : '(已释放)'));
          } catch (e) {}

          // E1：注销后仍在父页 fetch（controller 未释放则可能仍 404）
          L.push('--- E1 注销后父页 ---');
          L.push(await shot('E1'));

          // 全新 iframe 取文本助手（每次新建独立客户端）
          const iframeShot = (url, label) => new Promise(resolve => {
            const f = document.createElement('iframe');
            f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0';
            let done = false;
            const finish = (s) => { if(done) return; done=true; f.remove(); resolve(s); };
            const to = setTimeout(() => finish(label + ': iframe 8s 超时'), 8000);
            f.onload = () => {
              clearTimeout(to);
              setTimeout(() => {
                try {
                  const txt = f.contentWindow.document.body
                    ? f.contentWindow.document.body.innerText : '(无 body)';
                  finish(label + ': ' + txt.slice(0, 200));
                } catch (e) { finish(label + ': 读 body EXC ' + e); }
              }, 250);
            };
            f.onerror = () => { clearTimeout(to); finish(label + ': iframe onerror'); };
            f.src = url;
            document.body.appendChild(f);
          });

          // E2：注销后新建 iframe（关键对照——若无 SW 控制，ping 应真到 listener 回 pong）
          L.push('--- E2 注销后全新 iframe（无 SW 客户端）---');
          L.push(await iframeShot('/__shell__/ping?m=E2&t=' + Date.now(), 'E2-iframe'));

          // 全新 iframe 读环（独立真值通道；其自身读请求先入环再返回，含 E0/E1/E2 轨迹）
          L.push('--- E3 全新 iframe 读到达环 ---');
          L.push(await iframeShot('/diag-log?read=1&m=E3&t=' + Date.now(), 'E3-ring'));

          record('⑦ Service Worker 取证/A-B（信息项）', true, L.join('\\n'), true);
        }

        // ⑧ DIAG-F（临时，信息项）：父 loadHTMLString 文档 vs 真实 http 导航 iframe 文档对照。
        //    必须在③ iframe /app 之前的最早时间点跑，区分：
        //    P1 父页最早 ping（无任何 iframe 时）；
        //    L1 真实 /auth/login iframe 文档内部自查 SW + 自己 fetch ping（该文档不注册 SW）；
        //    A1 真实 /app iframe 文档内部自查 SW + 自己 fetch ping（该文档会注册两个 SW）；
        //    P2 两个 iframe 之后父页再 ping；最后父页读 /diag-log 看到达真值。
        async function probeDocumentAB(){
          const L = [];
          const parentFetch = async (marker) => {
            try {
              const r = await fetch('/__shell__/ping?m=' + marker + '&t=' + Date.now(), {cache:'no-store'});
              const b = await r.text();
              return 'status=' + r.status + ' bytes=' + b.length + (b.indexOf('pong') !== -1 ? ' pong' : '');
            } catch (e) { return 'EXC ' + e; }
          };

          // 先清环（若这步本身都空 404，环仍是旧内容，亦可侧面印证）
          try { await fetch('/diag-log?clear=1&t=' + Date.now(), {cache:'no-store'}); } catch (e) {}

          // P1：此刻③还没跑，父页最早 ping
          L.push('P1 父页最早(无iframe): ' + await parentFetch('P1'));

          // 在真实 iframe 文档内部执行脚本（同源，父可直改其 window/document）
          const insideProbe = (win, marker) => {
            const out = { sw: ('serviceWorker' in win.navigator), ctrl: null, fetch: '(未执行)' };
            try {
              if (out.sw && win.navigator.serviceWorker.controller) {
                out.ctrl = win.navigator.serviceWorker.controller.scriptURL;
              }
            } catch (e) { out.ctrl = 'EXC ' + e; }
            // DIAG-G：真实文档的 body 长度/开头 —— 若为空则说明该导航本身吃到了空 404（空白页）
            let docLen = -1, docHead = '(读不到)';
            try {
              const b = win.document.body;
              const t = (b ? (b.innerText || b.textContent || '') : '').replace(/\\s+/g, ' ').trim();
              docLen = t.length;
              docHead = t.slice(0, 60);
            } catch (e) { docHead = 'EXC ' + e; }
            return new Promise(resolve => {
              let done = false;
              const finish = () => { if(done) return; done = true;
                resolve('sw=' + out.sw + ' ctrl=' + (out.ctrl||'(无)') + '\\n      doc=' + docLen
                        + ' "' + docHead + '"\\n      fetch=' + out.fetch); };
              (async () => {
                try {
                  const r = await win.fetch('/__shell__/ping?m=' + marker + '&t=' + Date.now(),
                                            {cache:'no-store'});
                  const b = await r.text();
                  out.fetch = 'status=' + r.status + ' bytes=' + b.length
                    + (b.indexOf('pong') !== -1 ? ' pong' : '');
                } catch (e) { out.fetch = 'EXC ' + e; }
                finish();
              })();
              setTimeout(finish, 6000);
            });
          };

          const runIframe = (src, marker) => new Promise(resolve => {
            const f = document.createElement('iframe');
            f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0';
            let done = false;
            const finish = s => { if(done) return; done=true; f.remove(); resolve(s); };
            f.onload = () => setTimeout(async () => {
              try {
                let href = '(跨源)';
                try { href = f.contentWindow.location.href; } catch (e) {}
                const res = await insideProbe(f.contentWindow, marker);
                finish('href=' + href + '\\n      ' + res);
              } catch (e) { finish('iframe 内执行 EXC ' + e); }
            }, 800);
            f.onerror = () => finish('iframe onerror');
            setTimeout(() => finish('iframe 9s 超时'), 9000);
            f.src = src;
            document.body.appendChild(f);
          });

          L.push('L1 /auth/login 真实文档: ' + await runIframe('/auth/login?t=' + Date.now(), 'L1'));
          L.push('A1 /app 真实文档(注册SW): ' + await runIframe('/app#/?t=' + Date.now(), 'A1'));

          // N1：iframe **直接导航**到本地壳路由，读导航后文档体 —— 这是导航通道 vs fetch 通道的硬对照。
          //     若这里 doc 显示 pong，说明 WebKit 导航通道完全正常，只有 fetch/XHR 通道被拦。
          L.push('N1 iframe 导航 /__shell__/ping: ' + await runIframe('/__shell__/ping?m=N1&t=' + Date.now(), 'N1'));

          // P2：两个 iframe（尤其 /app）之后父页再 ping
          L.push('P2 父页(多iframe之后): ' + await parentFetch('P2'));

          // 读环（父页通道）
          let ring = '(取环失败)';
          try {
            const r = await fetch('/diag-log?read=1&m=P3&t=' + Date.now(), {cache:'no-store'});
            ring = await r.text();
          } catch (e) { ring = '取环 EXC ' + e; }
          L.push('到达环: ' + ring);
          record('⑧ 父文档 vs 真实 iframe 文档 A/B（信息项）', true, L.join('\\n'), true);

          // ⑨ DIAG-G：原生 App 进程 URLSession 直连 127.0.0.1:<port> 的真值（在页面加载前采集）。
          //    这是不经过 WebKit 的独立通道：若这里 ping 得到 pong，则 listener/反代完全健康，
          //    404 空 body 只能是 WebKit 侧合成；若这里也 404/空，则本端口上应答的不是我们的 HttpBridge。
          record('⑨ 原生 URLSession 直连真值（信息项）', true, NATIVE, true);
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
            '<div class="r"><div class="b ' + (r.diag ? 'z' : (r.pass?'g':'x')) + '"></div><div>' +
            '<div class="t">' + r.name + '</div><div class="d">' + r.detail + '</div></div></div>'
          ).join('') + '<div class="d">①–⑤全绿才算 Phase 5 主线通过（⑥⑦⑧⑨为临时诊断信息项）。</div>';
          const core = results.filter(r => !r.diag);
          const allGreen = core.length === 5 && core.every(r => r.pass);
          if (window.webkit && window.webkit.messageHandlers.s1Report) {
            window.webkit.messageHandlers.s1Report.postMessage(
              JSON.stringify({allGreen: allGreen, results: results}));
          }
        }

        (async () => {
          await probeDocumentAB();
          await probeLogin();
          await probeIframe();
          await probeShellAsset();
          await probeDiagPathMatrix();
          await probeServiceWorker();
          probeSyncBridge();
          render();
        })();
        <\(slash)script></body></html>
        """
    }
}
