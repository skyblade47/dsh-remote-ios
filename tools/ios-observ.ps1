# ============================================================================
# iPad 观测 / 装包（Windows 侧，基于 go-ios）
#
# 前提（本机已就绪，见 README §1）：
#   · Apple Mobile Device Service（usbmuxd）已装并 Running
#   · go-ios 的 ios.exe（默认 E:\项目\_ios-tools\go-ios\ios.exe，可用 -IosExe 或 DSH_IOS_TOOL 覆盖）
#
# 用法：
#   powershell -File tools/ios-observ.ps1 -Action List
#   powershell -File tools/ios-observ.ps1 -Action Info
#   powershell -File tools/ios-observ.ps1 -Action Syslog        # Ctrl+C 结束
#   powershell -File tools/ios-observ.ps1 -Action Shot
#   powershell -File tools/ios-observ.ps1 -Action Crash
#   powershell -File tools/ios-observ.ps1 -Action Install -Ipa .\build\DSHRemote-unsigned.ipa
#   powershell -File tools/ios-observ.ps1 -Action Launch
#
# ⚠️ iOS 17+ 的多数命令需要 tunnel（go-ios 需先 `ios tunnel start`，要管理员权限）。
#    若报 tunnel 类错误，另开一个窗口跑：& <ios.exe> tunnel start
# ============================================================================

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('List', 'Info', 'Syslog', 'Shot', 'Crash', 'Install', 'Launch')][string]$Action,
  [string]$IosExe = $(if ($env:DSH_IOS_TOOL) { $env:DSH_IOS_TOOL } else { 'E:\项目\_ios-tools\go-ios\ios.exe' }),
  [string]$Udid = '',
  [string]$Ipa = '',
  [string]$OutDir = '',
  [string]$BundleId = 'com.skyblade47.dshremote'
)

$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host $m }
function Need-Tool {
  if (-not (Test-Path $IosExe)) {
    Write-Host "找不到 go-ios：$IosExe（用 -IosExe 或环境变量 DSH_IOS_TOOL 指定）" -ForegroundColor Red
    exit 2
  }
}
function UdidArg { if ($Udid) { return @('--udid', $Udid) } else { return @() } }

# 🔴 为什么返回哈希而不是"只返回退出码"：
#    原生命令的 stdout 会**混进 PowerShell 函数的返回值**（函数会把所有未捕获的输出当返回值），
#    于是 `$rc` 变成 `{"deviceList":[]} 0` 这种数组（2026-09-30 实测踩到）。
#    ⇒ 这里把 stdout **显式接住**，函数只回 @{rc;out}。
function Run-Ios([string[]]$cmdArgs) {
  $prev = $ErrorActionPreference
  # $ErrorActionPreference='Stop' 下，原生命令往 stderr 写第一行会被升级成终止错误 ⇒ 本次调用期间降级
  $ErrorActionPreference = 'Continue'
  $out = & $IosExe @cmdArgs
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return @{ rc = $rc; out = @($out) }
}

# 流式（syslog 用）：不接住输出，让它直接上屏；调用方不看退出码
function Run-Ios-Stream([string[]]$cmdArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $IosExe @cmdArgs
  $ErrorActionPreference = $prev
}

Need-Tool

switch ($Action) {
  'List' {
    Say "=== 已连接设备（空 = 没插 / 没在设备上点「信任此电脑」）==="
    $r = Run-Ios @('list')
    $r.out | ForEach-Object { Say $_ }
    if ($r.rc -ne 0) { Say "（list 失败 rc=$($r.rc)）" }
    Say ""
    Say "提示：首次连接需在 iPad 上点「信任此电脑」。"
    exit 0
  }

  'Info' {
    Say "=== 设备信息 ==="
    $r = Run-Ios ((UdidArg) + @('info'))
    $r.out | ForEach-Object { Say $_ }
    if ($r.rc -ne 0) {
      Say "（info 失败 rc=$($r.rc)；iOS 17+ 可能要先跑 `ios tunnel start`）"
      exit 1
    }
    exit 0
  }

  'Syslog' {
    Say "=== 实时系统日志（Ctrl+C 结束）==="
    Say "   排查白屏/证书失败：先在 iPad 上操作，再看这里。"
    Run-Ios-Stream ((UdidArg) + @('syslog'))
    exit 0
  }

  'Shot' {
    $dir = if ($OutDir) { $OutDir } else { Join-Path (Get-Location) 'shots' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $name = Join-Path $dir ("shot-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".png")
    Say "截图 → $name"
    $r = Run-Ios ((UdidArg) + @('screenshot', '--output', $name))
    $r.out | ForEach-Object { Say $_ }
    if ($r.rc -ne 0) { Say "（screenshot 失败 rc=$($r.rc)）" ; exit 1 }
    if (Test-Path $name) { Say "✅ 已保存：$name（把这张图发我即可）" }
    exit 0
  }

  'Crash' {
    $dir = if ($OutDir) { $OutDir } else { Join-Path (Get-Location) 'crash' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Say "崩溃日志列表："
    $r = Run-Ios ((UdidArg) + @('crash', 'ls'))
    $r.out | ForEach-Object { Say $_ }
    Say ""
    Say "取回全部：ios crash cp --app=$BundleId --output=$dir"
    exit 0
  }

  'Install' {
    if (-not $Ipa) { Write-Host "Install 需要 -Ipa <路径>" -ForegroundColor Red; exit 2 }
    if (-not (Test-Path $Ipa)) { Write-Host "找不到 ipa：$Ipa" -ForegroundColor Red; exit 2 }
    Say "安装 $Ipa"
    Say "🔴 前提：该 ipa **必须已被签名**（未签名的用 Sideloadly + 你的 Apple ID 重签）"
    $r = Run-Ios ((UdidArg) + @('install', '--path', (Resolve-Path $Ipa).Path))
    $r.out | ForEach-Object { Say $_ }
    if ($r.rc -ne 0) { Say "（install 失败 rc=$($r.rc)）" ; exit 1 }
    Say "✅ 已安装"
    exit 0
  }

  'Launch' {
    Say "启动 $BundleId"
    $r = Run-Ios ((UdidArg) + @('launch', $BundleId))
    $r.out | ForEach-Object { Say $_ }
    if ($r.rc -ne 0) { Say "（launch 失败 rc=$($r.rc)）" ; exit 1 }
    exit 0
  }
}
