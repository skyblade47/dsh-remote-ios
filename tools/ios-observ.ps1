# ============================================================================
# iPad 观测链路（Windows 侧，基于 go-ios）
#
# 定位：iPad 不是开发环境，而是**被观测的对象** —— 本脚本跑在 Windows 上，
#       通过 USB（Apple Mobile Device Service / usbmuxd）看设备、抓日志、截图、装包。
#
# 前提（本机已就绪，见 README §1）：
#   · Apple Mobile Device Service（usbmuxd）已装并 Running
#   · go-ios 的 ios.exe（默认 E:\项目\_ios-tools\go-ios\ios.exe；可用 -IosExe 或 DSH_IOS_TOOL 覆盖）
#
# 🔴 两个实测踩过的坑（本脚本已按实测写法修正，别改回去）：
#   ① go-ios 的**设备/输出参数用等号形式**：`--udid=<v>`、`--output=<路径>`。
#      写成空格形式（`--udid <v>`）在 1.3.2 上不生效 —— 参数被当位置参数。
#   ② 原生命令的 stdout 会混进 PowerShell 函数的返回值（`$rc` 会变成 `{"deviceList":[]} 0`）
#      ⇒ 必须显式接住 stdout，只回 @{rc;out}（见 Run-Ios）。
#
# 用法：
#   powershell -File tools/ios-observ.ps1 -Action Doctor      # 环境+设备自检（先跑这个）
#   powershell -File tools/ios-observ.ps1 -Action Wait        # 等 iPad 插上/被信任
#   powershell -File tools/ios-observ.ps1 -Action Session     # ★ 一键观测会话（日志+截图+归档）
#   powershell -File tools/ios-observ.ps1 -Action Evidence    # 只归档一次（info+截图+崩溃列表）
#   powershell -File tools/ios-observ.ps1 -Action Tunnel      # iOS 17+ 起隧道（需管理员）
#   powershell -File tools/ios-observ.ps1 -Action List|Info|Syslog|Shot|Crash|Install|Launch
#
# ⚠️ iOS 17+ 的多数命令需要 tunnel：先 `-Action Tunnel`（另开一个窗口/管理员），再跑其它动作。
# ============================================================================

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Doctor', 'Wait', 'Session', 'Evidence', 'Tunnel', 'TunnelStop', 'List', 'Info', 'Syslog', 'Shot', 'Crash', 'Install', 'Launch')]
  [string]$Action,
  [string]$IosExe = $(if ($env:DSH_IOS_TOOL) { $env:DSH_IOS_TOOL } else { 'E:\项目\_ios-tools\go-ios\ios.exe' }),
  [string]$Udid = '',
  [string]$Ipa = '',
  [string]$OutDir = '',
  [string]$BundleId = 'com.skyblade47.dshremote',
  [int]$WaitSeconds = 120
)

$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host $m }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Bad($m) { Write-Host $m -ForegroundColor Red }
function Good($m) { Write-Host $m -ForegroundColor Green }

function Need-Tool {
  if (-not (Test-Path $IosExe)) {
    Bad "找不到 go-ios：$IosExe"
    Say "  修：用 -IosExe <路径> 或设环境变量 DSH_IOS_TOOL。下载见 README §1。"
    exit 2
  }
}

# go-ios 的等号形式参数（坑 ①）
function UdidArg {
  if ($Udid) { return @("--udid=$Udid") }
  if ($DeviceUdid) { return @("--udid=$DeviceUdid") }   # 会话里自动探测到的
  return @()
}
$script:DeviceUdid = ''

# 🔴 坑 ②：接住 stdout（+stderr），只回 @{rc;out}
#    · stdout 不接住会混进函数返回值（`$rc` 变成 `{"deviceList":[]} 0`）
#    · go-ios 每次都会往 stderr 打同一句良性 WARN（agent 未跑，iOS17+ tunnel 提示）
#      ⇒ 一并接住后**过滤掉那句**，否则真实输出会被淹掉（2026-09-30 实测）
function Run-Ios([string[]]$cmdArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # 否则原生命令写 stderr 第一行就变成终止错误
  $raw = & $IosExe @cmdArgs 2>&1
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $prev
  $out = @($raw | Where-Object { "$_" -notmatch 'go-ios agent is not running' })
  return @{ rc = $rc; out = $out }
}
function Show-Ios([string[]]$cmdArgs) {
  $r = Run-Ios $cmdArgs
  $r.out | ForEach-Object { Say $_ }
  return $r.rc
}

function Get-Devices {
  $r = Run-Ios @('list')
  $devs = @()
  foreach ($line in $r.out) {
    if (-not $line) { continue }
    try { $j = $line | ConvertFrom-Json } catch { continue }
    if ($j.deviceList) { $devs += $j.deviceList }
  }
  return $devs
}

function Ensure-OneDevice {
  $devs = Get-Devices
  if ($devs.Count -eq 0) {
    Bad "没有检测到设备。"
    Say "  ① iPad 用 USB 线连上这台电脑"
    Say "  ② iPad 上会弹「要信任此电脑吗」⇒ 点「信任」并输密码（不弹就拔插一次）"
    Say "  ③ 再跑：-Action Doctor"
    exit 1
  }
  if ($devs.Count -gt 1 -and -not $Udid) {
    Warn "检测到 $($devs.Count) 台设备 —— 请用 -Udid <udid> 指定一台："
    $devs | ForEach-Object { Say ("   " + $_.udid + "  " + $_.serialNumber) }
    exit 2
  }
  if (-not $Udid) { $script:DeviceUdid = $devs[0].udid }
  return $devs
}

function Evidence-Dir {
  $base = if ($OutDir) { $OutDir } else { Join-Path (Get-Location) 'evidence' }
  $dir = Join-Path $base (Get-Date -Format 'yyyyMMdd-HHmmss')
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

Need-Tool

switch ($Action) {

  'Doctor' {
    Say "=== 观测链路自检 ==="
    # 1) Apple 服务
    $svc = Get-Service -Name 'Apple Mobile Device Service' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { Good "① Apple Mobile Device Service：Running" }
    else { Bad "① Apple Mobile Device Service：未运行/未安装（USB 通信地基）"
           Say "   修：winget install Apple.AppleMobileDeviceSupport" }
    # 2) go-ios
    $v = Run-Ios @('version')
    Good ("② go-ios：" + ($v.out -join ' '))
    # 3) 设备（用 --details 拿型号/iPadOS；字段名不写死 —— 只把 JSON 原样打出来）
    $r = Run-Ios @('list', '--details')
    $devs = Get-Devices
    if ($devs.Count -eq 0) {
      Warn "③ 设备：未检测到（插上 iPad 并在设备上点「信任此电脑」）"
    } else {
      Good "③ 设备：检测到 $($devs.Count) 台"
      $r.out | ForEach-Object { Say ("   " + $_) }
    }
    # 4) tunnel
    $t = Run-Ios @('tunnel', 'ls')
    $tOut = ($t.out -join ' ').Trim()
    if ($t.rc -eq 0 -and $tOut -and $tOut -notmatch '^\s*(\[\]|\{\})?\s*$') { Good ("④ tunnel：" + $tOut) }
    else { Warn "④ tunnel：未在跑（iOS 17+ 的多数命令需要它）⇒ 另开窗口跑 -Action Tunnel" }
    Say ""
    Say "下一步：设备就绪就跑 -Action Session（一键抓日志+截图+归档）"
    exit 0
  }

  'Wait' {
    Say "等待设备接入（最多 $WaitSeconds 秒）…（Ctrl+C 可中断）"
    # 🔴 这里**不能**调 Ensure-OneDevice —— 它没设备时会直接 exit(1)，那就不是"等"了
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
      $devs = Get-Devices
      if ($devs.Count -gt 0) {
        Good ("已接入：" + $devs[0].udid)
        Say "  记住它（或跑 -Action Doctor 看详情），然后就能跑 -Action Session"
        exit 0
      }
      Start-Sleep -Seconds 3
      Write-Host '.' -NoNewline
    }
    Bad "超时（$WaitSeconds 秒）仍未检测到设备"
    Say "  · iPad 上没弹「信任此电脑」⇒ 拔插一次，或 设置→通用→传输或还原→还原位置与隐私"
    Say "  · 换个 USB 口/线试试（数据线，不是只充电的）"
    exit 1
  }

  'Tunnel' {
    Say "启动 tunnel（go-ios：iOS 17+ 必需；首次会要求配对）"
    Warn "此动作需要**管理员权限**（会创建虚拟网卡）。若报权限错，请以管理员身份重开终端。"
    $rc = Show-Ios @('tunnel', 'start')
    if ($rc -ne 0) { Bad "tunnel 启动失败（rc=$rc）"; exit 1 }
    Good "tunnel 已启动 —— 保持这个窗口开着，另开一个窗口跑其它 -Action"
    exit 0
  }

  'TunnelStop' {
    $rc = Show-Ios @('tunnel', 'stopagent')
    Say "（rc=$rc）"
    exit 0
  }

  'Session' {
    Say "=== ★ 一键观测会话 ==="
    Ensure-OneDevice | Out-Null
    $dir = Evidence-Dir
    $logFile = Join-Path $dir 'syslog.txt'
    $errFile = Join-Path $dir 'syslog.err.txt'
    Say "证据目录：$dir"

    # 1) 先存静态信息（这些命令失败不该中断会话）
    foreach ($pair in @(@('info', 'device-info.json'), @('devicename', 'device-name.txt'), @('date', 'device-date.txt'))) {
      $outFile = Join-Path $dir $pair[1]
      $r = Run-Ios ((UdidArg) + @($pair[0]))
      $r.out | Out-File -FilePath $outFile -Encoding UTF8
      Say ("  已存 " + $pair[1] + "（rc=" + $r.rc + "）")
    }

    # 2) 后台抓 syslog
    $syslogArgs = @('syslog') + (UdidArg)
    Say "开始抓 syslog → $logFile"
    $proc = Start-Process -FilePath $IosExe -ArgumentList $syslogArgs `
      -RedirectStandardOutput $logFile -RedirectStandardError $errFile -PassThru -WindowStyle Hidden
    Say ""
    Good "▶ 现在去 iPad 上**做那个要复现的操作**（比如打开 app、点某个按钮）"
    Say "  做完后回到这个窗口按回车，我会停止抓取并截图归档。"
    Read-Host | Out-Null

    # 3) 停日志 + 截图
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    $shot = Join-Path $dir 'screenshot.png'
    $rc = Show-Ios ((UdidArg) + @("screenshot", "--output=$shot"))
    if (Test-Path $shot) { Good "截图已存：$shot" } else { Warn "截图失败（rc=$rc）" }

    # 4) 崩溃列表
    $r = Run-Ios ((UdidArg) + @('crash', 'ls'))
    $r.out | Out-File -FilePath (Join-Path $dir 'crash-list.txt') -Encoding UTF8

    # 5) 会话小结（人看 + 给我看）
    $lines = @(
      "# 观测会话小结",
      "",
      "- 时间：" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),
      "- 设备 udid：" + $(if ($DeviceUdid) { $DeviceUdid } else { '(单设备)' }),
      "- 工具：go-ios（见 device-info.json）",
      "- 日志行数：" + $((Get-Content $logFile -ErrorAction SilentlyContinue).Count),
      "",
      "## 包含",
      "- device-info.json / device-name.txt / device-date.txt",
      "- syslog.txt（抓取窗口内的系统日志）",
      "- screenshot.png（结束时刻的屏幕）",
      "- crash-list.txt",
      "",
      "## 怎么用",
      "把这整个目录给我（或只给 syslog.txt + screenshot.png）即可。",
      "排查白屏/证书失败：在 syslog.txt 里搜 dsh-ios / App Transport Security / didFail。"
    )
    $lines | Out-File -FilePath (Join-Path $dir 'SUMMARY.md') -Encoding UTF8
    Say ""
    Good "完成。证据目录：$dir"
    Say "  日志行数：" + $((Get-Content $logFile -ErrorAction SilentlyContinue).Count)
    exit 0
  }

  'Evidence' {
    $dir = Evidence-Dir
    Say "证据目录：$dir"
    $r = Run-Ios ((UdidArg) + @('info'));       $r.out | Out-File (Join-Path $dir 'device-info.json') -Encoding UTF8
    $r = Run-Ios ((UdidArg) + @('devicename')); $r.out | Out-File (Join-Path $dir 'device-name.txt') -Encoding UTF8
    $shot = Join-Path $dir 'screenshot.png'
    $rc = Show-Ios ((UdidArg) + @("screenshot", "--output=$shot"))
    $r = Run-Ios ((UdidArg) + @('crash', 'ls')); $r.out | Out-File (Join-Path $dir 'crash-list.txt') -Encoding UTF8
    Good ("完成：" + $dir + "  （截图 rc=" + $rc + "）")
    exit 0
  }

  'List'  { Show-Ios @('list') | Out-Null; exit 0 }
  'Info'  { exit (Show-Ios ((UdidArg) + @('info'))) }
  'Crash' { exit (Show-Ios ((UdidArg) + @('crash', 'ls'))) }
  'Launch' { exit (Show-Ios ((UdidArg) + @('launch', $BundleId))) }

  'Syslog' {
    Say "实时 syslog（Ctrl+C 结束）—— 先在 iPad 上操作，再看这里"
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $IosExe @(@('syslog') + (UdidArg))
    $ErrorActionPreference = $prev
    exit 0
  }

  'Shot' {
    $dir = if ($OutDir) { $OutDir } else { Join-Path (Get-Location) 'shots' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $name = Join-Path $dir ("shot-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".png")
    $rc = Show-Ios ((UdidArg) + @("screenshot", "--output=$name"))
    if (Test-Path $name) { Good "已存：$name" } else { Bad "截图失败（rc=$rc）"; exit 1 }
    exit 0
  }

  'Install' {
    if (-not $Ipa) { Bad "Install 需要 -Ipa <路径>"; exit 2 }
    if (-not (Test-Path $Ipa)) { Bad "找不到 ipa：$Ipa"; exit 2 }
    Say "安装 $Ipa"
    if ($Ipa -notmatch '\.(ipa|app)$') { Warn "不是 .ipa/.app —— go-ios 需要应用包" }
    exit (Show-Ios ((UdidArg) + @('install', "--path=" + (Resolve-Path $Ipa).Path)))
  }
}
