# Folia iOS IPA 构建（未签名）

产出可自行签名的 `Folia.ipa`。签名由使用者负责（Sideloadly / AltStore / 自有证书 / 企业证书皆可）。

## 一、为什么 app 要加载远程地址

二创的全部功能都跑在自托管服务端：

| 功能 | 跑在哪 |
|---|---|
| 插件音源引擎（8 个源） | `deploy/selfhost/server.mjs` |
| 网易云 / 酷狗 / QQ 后端 | 同上（三个 npm 包） |
| 音频代理（`/media-proxy`、`/platform-audio`） | 同上 |

iOS 里没有 Node 环境，**app 只能连那台电脑**。所以 app 的 WebView 直接加载服务端页面：
相对路径天然正确、没有 CORS 问题，且改前端不用重新打包签名。

代价两条，必须接受：
1. 电脑要开着（服务端在跑）
2. `FOLIA_SERVER_URL` 必须是**固定地址**

## 二、固定地址是硬要求

Quick Tunnel 每次重启换域名 → app 会连不上。两个选择：

| 方案 | 费用 | 做法 |
|---|---|---|
| **Tailscale** | 免费 | 电脑和手机各装 Tailscale，用 `http://100.x.x.x:8081` |
| 域名 + 命名隧道 | 约 ¥30/年 | Cloudflare 命名隧道绑固定域名，用 `https://folia.你的域名` |

Tailscale 的 100.x 是 http，所以构建时要选 `allow_http = true`。

## 三、怎么打包

### 前提：你自己的 GitHub 仓库

本仓库的 `origin` 指向官方上游 `chthollyphile/folia-major`，**你推不上去**。需要：

1. 在 GitHub 建一个新仓库（**建议公开**——公开仓库的 macOS runner 不额外计费）
2. 把本目录推到那里：

```powershell
git remote add mine https://github.com/你的用户名/folia-ios.git
git push mine master
```

### 触发构建

GitHub → 你的仓库 → **Actions** → 左侧 **Build iOS IPA (unsigned)** → **Run workflow**

填两个参数：
- `server_url`：`http://100.x.x.x:8081`（Tailscale）或 `https://你的域名`
- `allow_http`：服务端是 http 就选 `true`

等约 10-20 分钟，跑完后在该次运行页面底部下载 **Folia-ipa** artifact，解压得到 `Folia.ipa`。

### 签名并安装

ipa 是未签名的，用你自己的方式签名后安装即可。

```powershell
# 用 Sideloadly 的例子（仅示意，你按自己的方式）
sideloadly -i Folia.ipa --appleid 你的AppleID
```

## 四、工作流做了什么

`.github/workflows/ios-ipa.yml`：

```
macos-15 runner
  → npm ci --ignore-scripts          # 跳过 Electron 二进制
  → npm run build                    # 产出 dist（webDir 需要存在）
  → npm i @capacitor/{core,cli,ios}@8
  → 生成 capacitor.config.json       # server.url = 你填的地址
  → npx cap add ios / cap sync ios
  → Info.plist：ATS 允许 http（可选）、UIBackgroundModes=audio（后台播放）
  → xcodebuild CODE_SIGNING_ALLOWED=NO
  → 打 Payload/ 成 zip → Folia.ipa
  → 上传 artifact
```

## 五、功能完整性说明

因为 app 加载的就是同一个 Web 应用，**功能与 PWA 完全一致**：

- ✅ 插件音源（8 个，搜索/播放/歌词/榜单）
- ✅ 网易云 / 酷狗 / QQ 登录与播放
- ✅ 歌词动画、AI 主题、可视化器
- ✅ 后台播放（已加 `UIBackgroundModes: audio`）
- ⚠️ 本地音乐扫描：iOS WebView 不支持文件系统扫描，此项不可用
- ⚠️ 服务端不可达时白屏（因为它就是远程页面）

## 六、常见问题

**Actions 里看不到这个 workflow？**
推送的分支不是默认分支时，workflow 只在 Actions 列表里显示为"该分支上的"。确认文件在默认分支上。

**构建成功但 app 白屏？**
服务端地址填错或服务端没跑。先在手机浏览器打开那个地址确认能访问。

**改了前端要重新打包吗？**
不用。重新构建前端产物并重启服务端即可，app 加载的是服务端页面。

**签名后闪退？**
多半是签名证书与 app 的 entitlement 不匹配；`UIBackgroundModes` 需要签名里带相应权限。
