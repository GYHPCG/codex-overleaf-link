# CSTCloud 适配版更新记录

本分支基于上游已发布的 v2.4.1，包含 `latex.cstcloud.cn` 适配和 GPT-6 备用模型选项。以下记录仅适用于此自定义分支。

### 2026-10-23

#### 优化

- 已启动的项目预加载完成后再检查镜像，减少任务开始时重复获取完整项目的情况。
- 并发的后台文件列表读取和项目快照读取共享正在进行的 ZIP 下载。下载完成后即释放；强制刷新和写入校验继续单独读取，避免使用旧内容。
- 局部论文润色优先阅读目标段落和必要的相关定义、引用；普通文字润色按改动范围检查文字和 LaTeX 语法，按需进行本地编译。

#### 新增

- 任务过程显示工作区准备、完整项目下载、Codex 处理、网页回写与验证的耗时。
- 显示本地环境准备、Codex 进程和会话就绪、首次模型文字输出及运行总耗时。首次输出计时从提交模型任务开始；进程和会话就绪时间为累计值，不应相加。
- Native Host 日志记录阶段耗时、模型 ID 和推理强度，便于区分启动延迟与模型处理时间；新增计时记录不包含提示词或论文正文。

#### 验证范围

- 自动化回归测试覆盖并发下载合并、强制刷新隔离、预加载期间启动任务、Codex 事件及回写相关行为。
- 未对真实 CSTCloud 论文进行前后耗时对比，不承诺固定提速比例。模型服务、复杂技能和编译仍可能耗时。

#### 本机更新

在此自定义仓库目录执行（Node.js >= 20，并已安装 Codex CLI）：

```sh
npm ci
npm run build:content
node bin/codex-overleaf-link.mjs install-native --extension-id baebbifpfkkmbomoioanolpnjmfhpbad
node bin/codex-overleaf-link.mjs doctor
```

Chrome 需加载此仓库的 `extension` 目录。若使用单独复制的扩展目录，先把构建后的 `extension` 内容更新到该目录，再在 `chrome://extensions` 点击 CSTCloud 扩展的“重新加载”，最后刷新论文项目页。

当前电脑的扩展目录为 `/Users/chenggong/.codex-overleaf/cstcloud/extension`。保留原扩展条目可以保留该条目的设置。原版托管安装的更新命令不用于升级此自定义分支。
