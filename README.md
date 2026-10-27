# AnnotationCapture

截图、批注、每日归档，并把选定的手写公式识别为 LaTeX，放入剪贴板。基于 [eSearch 15.6.1](https://github.com/xushengfeng/eSearch/tree/15.6.1) 的批注编辑器，保留画笔、形状、文字、橡皮擦、撤销和重做。

## 下载与使用

访问 [静态下载页](https://rowan-memoedu.github.io/AnnotationCapture/) 查看下载、快捷键和使用边界。

从 [Releases](https://github.com/Rowan-memoedu/AnnotationCapture/releases) 下载 `AnnotationCapture-0.1.1-windows-x64.zip`，解压到可写目录，运行 `AnnotationCapture.exe`。运行时已随包提供，无需安装 Node.js、Python、pnpm 或 OCR 模型。当前发行目标是 Windows x64；包未做商业代码签名。

1. 点击“开始截图”，或按 `Ctrl+Alt+S`。截图后使用批注工具书写。
2. 按 `Esc` 或 `Ctrl+Enter`：保存带批注的截图后退出。正在落笔时会等抬笔再保存。
3. 按 `Ctrl+Shift+Enter`，或点击“选公式并识别”：先归档完整截图，再框选一个手写公式，点击“识别选定公式”。只发送选区内的批注笔迹，网页背景不会发送给识别服务。
4. 成功后，LaTeX 文本进入剪贴板，结果窗口同时展示输入图和可编辑的识别结果。若等待期间剪贴板发生变化，会保留结果供手动复制。

截图快捷键可在设置中修改。公式选择期间按 `Esc` 会退出，已经归档的截图仍保留。保存失败会显示错误并保留画布，修复归档目录后可重试。

## 配置 DeepSeek

在设置中填入自己的 API Key，默认模型为支持图片输入的 `deepseek-flash`。密钥由 Windows 的系统加密能力保护，仅存放在本机。发行包不含开发者密钥，也不提供共享额度。

识别默认启用 DeepSeek 的低强度推理，以改善公式结构和字母大小写的识别；只使用最终公式文本，推理内容不会进入剪贴板。接口依据：[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。

也可通过 `ANNOTATION_DEEPSEEK_API_KEY` 或 `DEEPSEEK_API_KEY` 环境变量提供密钥。已保存密钥优先于环境变量。“清除已保存密钥”不会删除环境变量。

未配置识别服务时，截图归档与公式图导出仍可使用；不会虚构识别结果或清空剪贴板。请求失败、余额不足或超时会显示相应状态，可在结果卡上重试。接口依据：[DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/)。

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

`scripts/ui-acceptance.cjs` 验证真实截图、绘画、归档与未配置状态；`scripts/edge-acceptance.cjs` 验证最后一笔、撤销重做、橡皮擦、保存失败、选区取消、文字编辑和 100%/150%/200% 显示缩放；`scripts/live-ocr-acceptance.cjs` 使用现有 DeepSeek Key 对实际编辑器鼠标笔迹进行端到端验收。脚本需要 Playwright，可通过 `PLAYWRIGHT_MODULE` 指向模块目录；实际使用软件不需要 Playwright。设置 `ANNOTATION_EXE` 可针对打包后的程序执行相同验收。

`node scripts/accept-release.cjs` 会将当前版本 ZIP 解压到新的隔离目录，然后依次执行独立启动、截图批注、编辑边界和四个真实 OCR 样例，生成汇总报告。测试窗口移到可见桌面之外并关闭原生焦点，避免桌面操作混入绘画输入；识别的预期答案只用于验收比较，不发送给模型。

## 授权

本项目继续采用 GPL-3.0。上游授权与署名见 `LICENSE`、`README.eSearch.md` 和 `THIRD_PARTY_NOTICES.md`。每次发行附带对应源码标签和依赖授权。用户截图、运行数据、API Key 不进入源码仓库或发行包。
