# 邀请码与统一识别服务

客户端只持有个人会话。上游 API 密钥保存在独立网关的环境文件中，不编入客户端、源码或 Release。网关使用 Python 3.12 标准库，监听回环端口 18879，由现有 HTTPS 反向代理提供独立前缀 `/annotationcapture/api/`。

网关运行于专用系统用户和独立 systemd 服务；SQLite 只保存邀请码与会话的 SHA-256、用户状态及每日调用计数。原始邀请码创建后只输出一次；请求图像和上游响应不落盘。数据、配置和服务均与同机其他应用分开。

## 本机管理入口

管理员的 SSH 配置位于私密目录 `D:/AppData/AnnotationCapture/Admin/server.json`，结构为 `host` 与 `identityFile`。SSH 私钥仍使用现有受保护文件。不要将该配置、邀请码或提供方环境变量放进项目目录。

```powershell
node scripts/gateway-admin.cjs create '用户称呼' 'D:/AppData/AnnotationCapture/Admin/person-invite.json'
node scripts/gateway-admin.cjs list
node scripts/gateway-admin.cjs revoke '<account-id>'
```

创建命令只在终端输出账号 ID、称呼和私密文件路径。请在本机私密管理目录查看和交付邀请码。停用一个账号会同时撤销其邀请码和全部设备会话，不影响其他账号。

## 配置新 API

使用 DeepSeek 时，只需填写 Windows 用户环境变量 `ANNOTATION_LLM_API_KEY`。管理命令默认使用 `https://api.deepseek.com`、支持图片的 `deepseek-flash` 及低强度推理。以下变量可覆盖默认值，用于调整服务：

| 变量 | 内容 |
| --- | --- |
| `ANNOTATION_LLM_BASE_URL` | 支持图片输入的 OpenAI 兼容接口基础地址，例如以 `/v1` 结尾的 HTTPS 地址；也接受完整 `/chat/completions` 地址 |
| `ANNOTATION_LLM_API_KEY` | 新 API 密钥 |
| `ANNOTATION_LLM_MODEL` | 支持图片输入的模型名 |
| `ANNOTATION_LLM_EXTRA_JSON` | 可选 JSON 对象，可配置 `thinking`、`reasoning_effort`、`temperature`、`top_p` |

填写后运行：

```powershell
node scripts/gateway-admin.cjs configure-provider
```

命令从用户环境变量读取，不依赖旧进程继承，不打印凭据。配置经 SSH 标准输入传输，写入服务器 root 专用的 `/etc/annotationcapture/provider.env`，仅重启网关，失败时恢复原配置。上游必须支持 `image_url` 图片消息；不支持图片的纯文本 API 无法完成公式识别。不会回退到旧 DeepSeek 配置。

## 部署和限额

`node scripts/gateway-deploy.cjs` 打包有哈希清单的网关源码，经已登记的服务器维护 staging 入口验证后安装。安装前检查原有学习服务，新增独立 nginx snippet；健康检查失败时恢复原配置和网关代码。此入口针对当前受管理服务器布局，不是任意主机的一键安装器。

默认每个来源每分钟最多 10 次登录，每账号每分钟 12 次识别，并发上游调用最多 2 个。每日默认总计 5000 次、每账号 1000 次上游尝试，按 UTC 日持久计数；失败的上游尝试也计数。可用服务器环境变量 `ANNOTATION_DAILY_GLOBAL`、`ANNOTATION_DAILY_ACCOUNT` 调整。API 未配置时不扣每日调用计数。

单个 PNG 最大 6 MiB；只允许 HTTPS 上游，回环 HTTP 仅用于隔离测试。生产只开放登录、会话检查和识别接口，账号管理没有公共 HTTP 入口。完整截图继续由客户端本地归档；公式图片仅在识别请求中传递。

## 验收边界

`test_server.py` 使用临时数据库和本机假上游验证协议、权限、限额与错误处理。真实模型准确性由 `scripts/live-ocr-acceptance.cjs` 另验，预期答案不进入 API 请求。配置尚未填写时可以验收邀请登录与截图保存，不能据此宣称真实 OCR 已通过。
