# AnnotationCapture

截图、批注、每日归档，并把选定的手写公式识别为 LaTeX，放入剪贴板。基于 [eSearch 15.6.1](https://github.com/xushengfeng/eSearch/tree/15.6.1) 的批注编辑器，保留画笔、形状、文字、橡皮擦、撤销和重做。

0.2.0 加入全屏画笔入口和邀请码登录，登录后统一使用管理员配置的 DeepSeek 服务。

## 下载与使用

访问 [静态下载页](https://rowan-memoedu.github.io/AnnotationCapture/) 查看下载、快捷键和使用边界。

从 [Releases](https://github.com/Rowan-memoedu/AnnotationCapture/releases) 下载 `AnnotationCapture-0.2.0-windows-x64.zip`，解压到可写目录，运行 `AnnotationCapture.exe`。运行时已随包提供，无需安装 Node.js、Python、pnpm 或 OCR 模型。当前发行目标是 Windows x64；包未做商业代码签名。

1. 按 `Alt+W`，或点击“全屏批注”：截取鼠标所在显示器，直接进入画笔。按 `Ctrl+Alt+S`，或点击“区域截图”：框选后自动切换画笔，在选区上继续批注。
2. 按 `Esc` 或 `Ctrl+Enter`：保存带批注的截图后退出。正在落笔时会等抬笔再保存。
3. 按 `Ctrl+Shift+Enter`，或点击“选公式并识别”：先归档完整截图，再框选一个手写公式，点击“识别选定公式”。只发送选区内的批注笔迹，网页背景不会发送给识别服务。
4. 成功后，LaTeX 文本进入剪贴板，结果窗口同时展示输入图和可编辑的识别结果。若等待期间剪贴板发生变化，会保留结果供手动复制。

两种截图快捷键均可在设置中修改。区域模式只保存选定区域；全屏模式保存当前显示器完整画面。公式选择期间按 `Esc` 会退出，已经归档的截图仍保留。保存失败会显示错误并保留画布，修复归档目录后可重试。

## 从旧版覆盖升级

1. 完成当前批注，从系统托盘右键菜单选择“退出”。关闭设置窗口只会留在后台，不能代替退出程序。
2. 将新版 ZIP 的全部内容解压到原来的程序目录，选择覆盖同名程序文件；保持 `AnnotationCapture.exe` 路径不变。不要先删除旧目录，也不要删除或替换 `AnnotationCapture-data`。
3. 重新运行原来的 `AnnotationCapture.exe` 或桌面快捷方式。历史归档、自定义归档目录、快捷键和画笔设置继续保留。

从 0.1.1 升级后，首次识别须使用邀请码登录，此后自动恢复登录，不再填写个人 API。已在 0.2.0 登录的用户再次覆盖更新仍保留本机登录状态。使用 `--userData` 或 `--archiveRoot` 的用户继续使用原快捷方式及参数。

已在本机使用 0.1.1 正式 ZIP 验证上述两种数据目录的覆盖升级，并逐文件核对归档哈希。快捷键若被其他程序占用，设置中会提示具体入口，可换一个组合；另一可用快捷键仍保留。

## 邀请码登录

首次使用公式识别，在软件中输入管理员提供的个人邀请码。登录状态由 Windows 加密保存在本机，后续启动自动恢复。个人邀请码可用于自己的多台电脑；管理员可单独停用一个用户，该用户所有设备的登录随之失效。

所有登录用户使用管理员配置的统一识别服务，无需填写 API Key 或模型。发行包不包含上游 API 密钥；登录凭据只用于访问独立网关。完整截图留在本机，仅主动选中的公式笔迹图发送到服务。

旧版保存的个人密钥及 DeepSeek 环境变量不会用于 0.2.0 的识别请求。离线时保留本机登录状态，服务恢复后可重新连接。

未登录或统一服务尚未配置时，截图归档与公式图导出仍可使用，剪贴板保持原样。请求失败或超时会显示状态，可在结果卡上重试。管理员配置见 [网关运维说明](gateway/README.md)。

## 保存内容

默认数据目录为程序旁的 `AnnotationCapture-data`。归档位置可以在设置中更换，默认是该数据目录下的 `Archive`。每次完成批注后生成独立目录：

```text
Archive/YYYY-MM-DD/<截图编号>/
  capture.png       带批注的完整截图选区
  capture.json      截图尺寸、屏幕、时间与完整性记录
  formula-*.png     单独框选的纯笔迹图
  formula-*.json    识别状态与结果
```

日期按电脑本地时区划分。不会自动删除历史归档。公式识别不会缩小或覆盖 `capture.png`。结果列表展示当前运行期间的任务；重启后，原始图和结果仍可从归档目录查看。

可用 `--userData <绝对路径>` 和 `--archiveRoot <绝对路径>` 指定独立数据/初始归档目录；`--input <图片路径>` 可导入图像进行批注。归档目录一旦在设置中保存，以设置为准。

## 当前边界

- 输出是 LaTeX 文本；Math Academy 的具体公式输入器和自动粘贴尚未适配。
- 识别仅转写选定公式，不求解，不自动纠正数学表达式。结果可在复制前后人工检查、编辑。
- 完成按钮、Esc、窗口关闭以及正常退出都会先归档；强制结束进程、系统故障或断电无法保证未完成批注不丢失。
- 此版本集中提供截图批注、归档和公式识别。上游的录屏、滚动截图、搜索和贴图功能未作为本发行版入口开放。

## 构建与验收

使用 Node.js 24 和 pnpm 10.17.0：

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
pnpm run typecheck
pnpm test
pnpm run release:win
```

`ANNOTATION_ARTIFACTS` 可指定打包暂存与发行产物目录；本项目开发环境默认使用 `D:/Artifacts/AnnotationCapture`。发行包与源码独立，不引用开发机器的 `node_modules`。

`scripts/capture-modes-acceptance.cjs` 核对两种入口、默认画笔及归档像素；`scripts/invite-login-acceptance.cjs` 验证真实网关登录、重启、多设备及单用户撤销；`scripts/ui-acceptance.cjs` 验证真实截图、绘画、归档与未登录状态；`scripts/edge-acceptance.cjs` 验证最后一笔、撤销重做、橡皮擦、保存失败、选区取消、文字编辑和 100%/150%/200% 显示缩放。`scripts/live-ocr-acceptance.cjs` 通过私密的 `ANNOTATION_INVITE_FILE` 登录，使用统一 API 做四个真实笔迹样例；客户端无需上游密钥。

脚本需要 Playwright，可通过 `PLAYWRIGHT_MODULE` 指向模块目录；实际使用软件不需要 Playwright。设置 `ANNOTATION_EXE` 可针对打包后的程序执行相同验收。`pnpm run test:gateway` 运行隔离网关测试，使用本机假上游验证协议与权限，不计为真实模型识别通过。

`scripts/upgrade-acceptance.cjs` 从旧版正式 ZIP 启动，在同一程序路径覆盖新版，检查默认/自定义数据目录、原归档哈希、设置、首次邀请码登录及重复覆盖后免登录。需要分别指定旧、新 ZIP 和私密邀请码文件，可通过 `ANNOTATION_OLD_ZIP`、`ANNOTATION_NEW_ZIP`、`ANNOTATION_INVITE_FILE` 配置。

`node scripts/accept-release.cjs` 将当前版本 ZIP 解压到新的隔离目录，执行独立启动、两种截图模式及编辑边界。提供 `ANNOTATION_INVITE_FILE` 时增加四个真实 OCR 样例；缺少该项时报告明确保留真实 API 待验收状态，不标记为可正式发布。完成实际屏幕捕获后才将绘画窗口移到可见桌面之外；识别的预期答案只用于验收比较，不发送给模型。

## 授权

本项目继续采用 GPL-3.0。上游授权与署名见 `LICENSE`、`README.eSearch.md` 和 `THIRD_PARTY_NOTICES.md`。每次发行附带对应源码标签和依赖授权。用户截图、运行数据、API Key 不进入源码仓库或发行包。
