# 推到自己的 GitHub 仓库（触发 iOS 构建）
#
# 用法：
#   .\deploy\ios\push-to-github.ps1 -RepoUrl https://github.com/你的用户名/你的仓库.git
#
# 说明：
#   - 只推 ios-delivery 这一个干净分支（单提交、不含任何凭据历史）
#   - 不要推 master：那边历史里有 QQ 的 sessionVkey/imei
#   - 首次推送会弹出浏览器让你登录 GitHub，不需要在这里填密码或令牌

param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $RepoRoot

if ($RepoUrl -notmatch '^https://github\.com/[^/]+/[^/]+(\.git)?$') {
    Write-Host "[X] 仓库地址格式不对，应形如 https://github.com/用户名/仓库名.git" -ForegroundColor Red
    exit 1
}

# 统一成 .git 结尾
if ($RepoUrl -notmatch '\.git$') { $RepoUrl = "$RepoUrl.git" }

$branch = git branch --show-current
if ($branch -ne 'ios-delivery') {
    Write-Host "[!] 当前分支是 '$branch'，切到干净的 ios-delivery" -ForegroundColor Yellow
    git checkout ios-delivery
}

# 确认这个分支历史里没有凭据文件
$leak = git log --oneline HEAD -- '.auth-state/qq-device.json' 2>$null
if ($leak) {
    Write-Host "[X] 这个分支的历史里含凭据文件，停止推送：" -ForegroundColor Red
    Write-Host $leak
    exit 1
}

Write-Host "[*] 检查远端..." -ForegroundColor Cyan
$existing = git remote get-url mine 2>$null
if ($existing) {
    git remote set-url mine $RepoUrl
} else {
    git remote add mine $RepoUrl
}
Write-Host "    远端 mine -> $RepoUrl"

Write-Host ""
Write-Host "[*] 开始推送（会弹出浏览器让登录 GitHub）..." -ForegroundColor Cyan
# 把干净分支推成 main：新仓库默认分支即 main，workflow_dispatch 才会在 Actions 里出现
git push -u mine ios-delivery:main

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[X] 推送失败。常见原因：" -ForegroundColor Red
    Write-Host "    - 仓库还没在 GitHub 上创建（先建一个空仓库，不要勾 README）"
    Write-Host "    - 弹窗登录没完成"
    Write-Host "    - 仓库名/用户名拼错"
    exit 1
}

$slug = ($RepoUrl -replace '^https://github\.com/', '' -replace '\.git$', '')
Write-Host ""
Write-Host "  ==============================================" -ForegroundColor Green
Write-Host "   推送成功" -ForegroundColor Green
Write-Host "  ==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  下一步：到 GitHub 触发构建"
Write-Host "  1. 打开 https://github.com/$slug/actions"
Write-Host "  2. 左侧选「Build iOS IPA (unsigned)」"
Write-Host "  3. 点「Run workflow」，填："
Write-Host "       server_url  = 你的固定服务端地址（如 http://100.x.x.x:8081）"
Write-Host "       allow_http  = 服务端是 http 就选 true"
Write-Host "  4. 等 10-20 分钟，在该次运行页底部下载 Folia-ipa artifact"
Write-Host ""
Write-Host "  注意：仓库必须是 public，macOS runner 才不额外计费。" -ForegroundColor DarkYellow
Write-Host ""
