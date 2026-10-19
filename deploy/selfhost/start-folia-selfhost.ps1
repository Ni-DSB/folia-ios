# Folia 自托管一键启动 —— 手机 PWA 免费公网方案
#
# 组成：Node 自托管服务（前端 + 网易云 API + 插件音源引擎 + 音频代理）+ Cloudflare 免费隧道
# 特点：完全免费、无需服务器、无需域名、跨网络可用、iPhone 可加主屏幕
# 代价：电脑必须开机不休眠；隧道地址每次重启会变（变了要重新加主屏幕 + 重新登录）
#
# 用法：右键"使用 PowerShell 运行"，或：
#   powershell -ExecutionPolicy Bypass -File .\start-folia-selfhost.ps1

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$Repo = Join-Path $Root '..\..'          # 仓库根（deploy/selfhost 的上两级）
$Bin = Join-Path $Root 'bin'
$Cfd = Join-Path $Bin 'cloudflared.exe'
$Port = 8081
$Local = "http://127.0.0.1:$Port"
$UrlFile = Join-Path $Bin 'folia-url.txt'
$TunnelLog = Join-Path $Bin 'tunnel-folia.log'

function Info($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[X] $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  Folia 自托管（手机 PWA）" -ForegroundColor Magenta
Write-Host "  ========================" -ForegroundColor Magenta
Write-Host ""

# ---------- 0. 依赖检查 ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die "找不到 node。需要 Node.js 22+。" }
Info "Node: $(& node -v)"

# cloudflared 复用 DSH链接 里现成的；没有就报错
if (-not (Test-Path $Cfd)) {
    $alt = "D:\DSH链接\bin\cloudflared.exe"
    if (Test-Path $alt) { New-Item -ItemType Directory -Force -Path $Bin | Out-Null; Copy-Item $alt $Cfd -Force; Info "已从 DSH链接 复制 cloudflared" }
    else { Die "缺 cloudflared.exe（放 $Cfd，或确保 D:\DSH链接\bin\cloudflared.exe 存在）" }
}

# ---------- 1. 构建前端（若 dist 缺失或过期）----------
$distIndex = Join-Path (Resolve-Path $Repo) 'dist\index.html'
$srcNewest = (Get-ChildItem (Join-Path (Resolve-Path $Repo) 'src') -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
if (-not (Test-Path $distIndex) -or $srcNewest -gt (Get-Item $distIndex).LastWriteTime) {
    Info "构建 Web 前端（含插件音源接口，约 1-2 分钟）..."
    Push-Location (Resolve-Path $Repo)
    npm run build:selfhost 2>&1 | Out-Host
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Die "构建失败（退出码 $code）" }
    Ok "前端已构建"
} else {
    Ok "前端已是最新，跳过构建"
}

# ---------- 2. 起自托管服务 ----------
Info "启动 Folia 自托管服务 (端口 $Port)..."
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Warn "端口 $Port 已被占用，先停掉旧进程"
    $existing.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}
Push-Location (Resolve-Path $Repo)
$svc = Start-Process -FilePath 'node' -ArgumentList 'deploy\selfhost\server.mjs' -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Bin 'server.out.log') -RedirectStandardError (Join-Path $Bin 'server.err.log')
Pop-Location

# 等健康检查通过
$up = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    try {
        $h = Invoke-RestMethod -Uri "$Local/healthz" -TimeoutSec 5
        if ($h.ok) { $up = $true; break }
    } catch {}
}
if (-not $up) { Die "服务没起来，看 $Bin\server.err.log" }
Ok "服务已就绪"

# ---------- 3. 建隧道 ----------
Info "建立 Cloudflare 免费隧道..."
Get-Process -Name cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Remove-Item $TunnelLog -ErrorAction SilentlyContinue
Start-Process -FilePath $Cfd -ArgumentList 'tunnel', '--url', $Local, '--no-autoupdate' -WindowStyle Hidden -RedirectStandardError $TunnelLog -RedirectStandardOutput (Join-Path $Bin 'tunnel-folia.out.log')

$url = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $TunnelLog) {
        $m = [regex]::Match((Get-Content $TunnelLog -Raw), 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($m.Success) { $url = $m.Value; break }
    }
}
if (-not $url) { Die "隧道没拿到地址，看 $TunnelLog" }
$url | Out-File $UrlFile -Encoding ascii -NoNewline
Ok "隧道地址: $url"

# ---------- 4. 公网验证 ----------
Start-Sleep -Seconds 3
try {
    $pub = Invoke-RestMethod -Uri "$url/healthz" -TimeoutSec 15
    if ($pub.ok) { Ok "公网验证通过" } else { Warn "公网 healthz 异常" }
} catch { Warn "公网暂时不通（可能还在生效），稍后再试" }

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "   现在用手机浏览器打开：" -ForegroundColor Green
Write-Host "   $url" -ForegroundColor Yellow
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "   iPhone: Safari 打开 → 分享 → 添加到主屏幕" -ForegroundColor Gray
Write-Host "   插件音源：搜索框输入 → 顶部标签切源（bilibili/汽水/咪咕…）" -ForegroundColor Gray
Write-Host "   管理音源：设置 → 连接与集成 → 自定义音源" -ForegroundColor Gray
Write-Host ""
Write-Host "   ⚠ 电脑别关机/别睡眠（电源计划设'永不睡眠'）" -ForegroundColor DarkYellow
Write-Host "   ⚠ 重跑本脚本会换地址 → 手机要重新加主屏幕 + 重新登录" -ForegroundColor DarkYellow
Write-Host "   当前地址存在: $UrlFile" -ForegroundColor Gray
Write-Host ""
