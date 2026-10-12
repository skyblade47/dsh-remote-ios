import Foundation

enum RewriteError: LocalizedError {
    case hitCountMismatch(Int, Int)
    var errorDescription: String? {
        switch self {
        case let .hitCountMismatch(got, want):
            return "shell 资产引用命中数 \(got) 与白名单 \(want) 不一致"
        }
    }
}

enum ShellHTMLRewriter {
    // 注入用字面量锚点（必须是 /__shell__/ 形态，才能与 12 个外链一起被正则统一改写）
    private static let viewportOld = "viewport-fit=cover\""
    private static let viewportNew = "viewport-fit=cover, interactive-widget=resizes-content\""
    private static let cssAnchor = #"<link rel="stylesheet" href="/__shell__/writing.css" />"#
    private static let cssInjected = #"<link rel="stylesheet" href="/__shell__/ipad.css" />"#
    private static let jsAnchor = #"<script src="/__shell__/sync-net.js"></script>"#
    private static let jsInjected = #"<script src="/__shell__/ipad.js"></script>"#

    // 临时真机自检探针（内联，随主文档执行，不依赖 ipad.js 自身）：
    // 报告改写注入是否进了最终 HTML、ipad.js 外链是否成功加载执行。
    // 诊断完成后随本块一并移除。
    private static let probeInjected = #"""
<script>
(function(){
  function render(){
    var b=document.getElementById('__wcip_body'); if(!b)return;
    var scripts=Array.prototype.slice.call(document.querySelectorAll('script[src]')).map(function(s){
      try{return s.src.split('/').pop()}catch(e){return '?'}
    });
    b.textContent =
      'INLINE PROBE ran ✓\n'+
      'readyState='+document.readyState+'\n'+
      'ipad.js tag in DOM='+(scripts.indexOf('ipad.js')>=0?'YES':'NO')+'\n'+
      'ipad.js executed='+(window.__wciPadShell?'YES':'NO')+'\n'+
      'wcStorage='+(typeof window.wcStorage)+'\n'+
      ((window.__wciDiagLog||[]).join('\n'));
  }
  function boot(){
    if(document.getElementById('__wcip'))return;
    var box=document.createElement('div');box.id='__wcip';
    box.setAttribute('style','position:fixed;left:0;right:0;top:0;z-index:2147483646;'+
      'background:rgba(0,40,120,.92);color:#fff;font:12px/1.35 -apple-system,monospace;'+
      'padding:6px 8px;max-height:40vh;overflow:auto;white-space:pre-wrap;'+
      '-webkit-text-size-adjust:100%');
    var h=document.createElement('div');
    h.textContent='PROBE（内联，确认后移除）';h.style.fontWeight='bold';
    var b=document.createElement('div');b.id='__wcip_body';
    box.appendChild(h);box.appendChild(b);
    (document.body||document.documentElement).appendChild(box);
    window.__wcipRender=render;render();
  }
  boot();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){boot();render()});
  setTimeout(function(){boot();render()},1200);
  setTimeout(function(){boot();render()},3500);
})();
</script>
"""#

    /// 仅在锚点存在且未注入过时插入，保证对任意输入（含测试里的无锚点片段）幂等、可重入。
    private static func injectOnce(_ html: String, anchor: String, insertion: String) -> String {
        guard html.contains(anchor), !html.contains(insertion) else { return html }
        return html.replacingOccurrences(of: anchor, with: anchor + "\n" + insertion)
    }

    static func rewrite(_ html: String, css: ((String) -> String?)? = nil) throws -> String {
        // 第一步：结构注入（插进去的仍是 /__shell__/ 字面量，与原 12 外链同走下面的正则）
        let withViewport = html.contains(viewportNew)
            ? html
            : html.replacingOccurrences(of: viewportOld, with: viewportNew)
        let withCSS = injectOnce(withViewport, anchor: cssAnchor, insertion: cssInjected)
        let withPadJS = injectOnce(withCSS, anchor: jsAnchor, insertion: jsInjected)
        // 临时：探针紧随 ipad.js 外链之后（一起幂等；__wcip 已存在则不重复）
        let withJS = injectOnce(withPadJS, anchor: jsInjected, insertion: probeInjected)

        // 第二步：白名单引用统一改写（既有逻辑，不动）
        var hits = 0
        let regex = try NSRegularExpression(
            pattern: #"/__shell__/([A-Za-z0-9._-]+\.(?:js|css))"#
        )
        let mutable = NSMutableString(string: withJS)
        let matches = regex.matches(in: withJS, range: NSRange(location: 0, length: (withJS as NSString).length))
        for m in matches.reversed() {
            let file = (withJS as NSString).substring(with: m.range(at: 1))
            guard AssetManifest.isAsset(file) else { continue }
            regex.replaceMatches(
                in: mutable, range: m.range(at: 0),
                withTemplate: "dsh-asset://local/\(file)"
            )
            hits += 1
        }
        guard hits == 0 || hits == AssetManifest.names.count else {
            throw RewriteError.hitCountMismatch(hits, AssetManifest.names.count)
        }

        // 第三步：样式表内联。真机实测：WKWebView 对自定义 scheme（dsh-asset://）下的
        // <link rel=stylesheet> 不应用，但同一 scheme 的 <script> 正常执行；三个外链 CSS 全不生效
        // 时三栏 flex 退化为纵向堆叠。把白名单样式表就地换成 <style> 彻底绕开该非对称行为；
        // 提供不出内容的样式表保留外链，JS 一律不动。幂等：输入已是 <style data-asset> 时无外链可换。
        return inlineStylesheets(mutable as String, css: css)
    }

    /// 把 `<link rel="stylesheet" href="dsh-asset://local/<name>.css" ...>` 就地替换为
    /// `<style data-asset="<name>">…</style>`（css 闭包返回 nil 则保留原 link）。
    private static func inlineStylesheets(_ html: String, css: ((String) -> String?)?) -> String {
        guard let css else { return html }
        let linkRegex = try? NSRegularExpression(
            pattern: #"<link\s+rel="stylesheet"\s+href="dsh-asset://local/([A-Za-z0-9._-]+\.css)"\s*/?>"#
        )
        guard let linkRegex else { return html }
        let source = html as NSString
        let matches = linkRegex.matches(in: html, range: NSRange(location: 0, length: source.length))
        var out = html
        for m in matches.reversed() {
            let name = source.substring(with: m.range(at: 1))
            guard AssetManifest.isAsset(name), let body = css(name) else { continue }
            guard let nsRange = Range(m.range, in: out) else { continue }
            out.replaceSubrange(nsRange, with: #"<style data-asset="\#(name)">\#(body)</style>"#)
        }
        return out
    }
}
