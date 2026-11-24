# 共享白板

AnnotationCapture 托盘的「打开独立白板」和 GraspMemoEdu 的题目白板使用同一套 HTML、TypeScript 和样式。桌面随程序加载本地资源。网站在独立来源的 iframe 中加载固定版本，题目、登录、模型调用和保存目录由网站宿主管理。

- 压感路径和套索几何复用桌面批注的实现。独立白板提供画笔、笔色、笔宽、橡皮、套索移动和删除、直线、矩形、椭圆、撤销和重做。
- 普通画笔支持涂抹删除，识别手势和墨迹相交判定与截图批注共用。手势成功时，只删除碰到的整条笔画，涂抹痕迹随之消失，可一步撤销。工具栏可以关闭此手势。
- 浏览器构建使用 `pnpm run build:whiteboard`。默认输出到 `D:/Artifacts/AnnotationCapture/whiteboard-v4`，可通过 `ANNOTATION_WHITEBOARD_OUTPUT` 指定新的构建目录。桌面构建同时生成 `whiteboard.html`，随 Windows 安装包发布。
- 宿主加载页面后以 `annotation-whiteboard:v1` 握手并传入一个 `MessagePort`。白板支持冻结、PNG 快照、恢复场景和写入文字。消息传递不包含网站登录凭据或目录句柄。
- 宿主收到 `selection: {id, count}` 后，可用 `snapshotSelection` 获取只含所选笔迹的 PNG。`replaceSelection` 接受该快照的 `id` 和变量文本，只在选区仍然有效时替换，并写入画布撤销历史。识别服务和变量存储由宿主提供。
- Web 产物对应源代码和构建脚本以同一标签提供，附 GPLv3 和依赖许可说明。更新时使用独立版本路径，已发布路径按原版本保留。
