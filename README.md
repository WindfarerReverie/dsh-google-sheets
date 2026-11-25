# dsh-google-sheets

**中文** · [English](#english)

让 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 直接调用 Google 表格官方接口读写表格，不再靠浏览器一格一格点。

- **准**：每次写入或追加后，插件自动按"显示值 / 原始值 / 公式"三种方式把写过的格子读回来比对，`verified=false` 时列出哪格写了什么、表上实际是什么。
- **省**：一次读写只回传几行文字，不截屏、不看网页，改几格大约只花几分钱的模型费用。
- **全**：读的时候可以带上批注、字体颜色、底色、删除线（`details=true`），很多表格把促销价、截止日、作废标记写在这些地方。

## 工具

| 工具 | 作用 |
|---|---|
| `gsheets_connect` | 第一次用时授权：弹出 Google 授权页，点"允许" |
| `gsheets_find` | 按名字找表格 |
| `gsheets_info` | 看一张表有哪些页、多少行列 |
| `gsheets_read` | 读区域（显示值 / 原始值 / 公式，可带批注和颜色） |
| `gsheets_write` | 覆盖写一个区域，写后自动核对 |
| `gsheets_append` | 在已有数据下面追加行，写后自动核对 |
| `gsheets_create` | 新建表格，可带首批数据 |

没有删除类工具。

## 安装

1. 用你自己的 Google 账号在 [Google Cloud 控制台](https://console.cloud.google.com/) 建一个项目，开通 **Google Sheets API** 和 **Google Drive API**。
2. 在 Google Auth Platform 配好应用信息，新建一个 **桌面应用（Desktop app）** 类型的 OAuth 客户端，下载 JSON（文件名 `client_secret_….json`）放进你电脑的「下载」文件夹。插件第一次运行时会把它复制到 `~/.dsh-gsheets/client.json`。
3. 安装插件（在仓库目录 `npm pack` 后）：
   ```
   dsh plugin --profile <你的 profile> add ./dsh-google-sheets-0.1.0.tgz
   ```
   重启 DSH。
4. 在 DSH 里说"连接 Google 表格"，它会调用 `gsheets_connect` 打开授权页；点"允许"后令牌保存在 `~/.dsh-gsheets/token.json`，之后自动续期。

> 应用处于"测试"状态时，Google 每 7 天会让授权失效一次；把应用发布为"正式"可以避免（自己用无需提交 Google 审核，授权时多一页"未经验证"的提示）。

## 权限与隐私

只申请两个权限：表格读写（`spreadsheets`）和 Drive 文件名只读（`drive.metadata.readonly`，只用于按名字找表）。数据只在你的电脑和 Google 之间传输，插件不向任何第三方发送数据。详见 [隐私政策](https://windfarerreverie.github.io/dsh-google-sheets/privacy.html)。

## 测试

`node test.mjs`（模拟 Google 接口，不连真实服务）。

---

## English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that talks to the Google Sheets API directly instead of clicking through a browser.

- **Accurate** — every write/append is read back (formatted, raw and formula) and compared cell by cell; mismatches are reported.
- **Cheap** — compact JSON in and out, no screenshots.
- **Notes & colors** — `gsheets_read` with `details=true` also returns notes, font/background colors and strikethrough.

Tools: `gsheets_connect`, `gsheets_find`, `gsheets_info`, `gsheets_read`, `gsheets_write`, `gsheets_append`, `gsheets_create` (no delete tools).

Setup: create your own Google Cloud project, enable the Sheets and Drive APIs, create a **Desktop app** OAuth client, put the downloaded `client_secret_*.json` in your Downloads folder, install the plugin with `dsh plugin add`, restart DSH and ask it to connect Google Sheets. Tokens are stored locally in `~/.dsh-gsheets/`.

Scopes: `spreadsheets` and `drive.metadata.readonly`. Data flows only between your machine and Google. See the [privacy policy](https://windfarerreverie.github.io/dsh-google-sheets/privacy.html).

MIT License.

## 只读名单（0.2.2 起）
有些表格（比如公司正本）只许公司自己的程序改，不许 AI 直接写。把它们的表格 ID 一行一个写进下面任一个文件，`gsheets_write`、`gsheets_append` 遇到就拒写（返回 written=false 和原因），读不受影响；改了文件立即生效、不用重启：
- 数据目录下的 `readonly-ids.txt`
- 「下载」文件夹里的 `dsh-gsheets-readonly.txt`

`#` 后面是注释，例如 `1kxTnmzD...  # Sales Record`。

