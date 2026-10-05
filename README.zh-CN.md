# Pi Messenger

[English](README.md) | 中文

面向共享项目或工作目录的多个 Pi 会话提供基于文件的协作。本仓库是维护中的 `chenhaoxiang/pi-messenger` fork。

> Fork 仓库：<https://github.com/chenhaoxiang/pi-messenger>
>
> **pi-messenger** 适合共享在线状态、文件占用、活动记录和 Crew 工作流；一对一对话请使用 [pi-intercom](https://github.com/chenhaoxiang/pi-intercom)。

## 安装本 fork

```bash
pi install git:github.com/chenhaoxiang/pi-messenger@main
```

安装后重启 Pi 或执行 `/reload`。需要可复现安装时，可固定经过审核的提交：

```bash
pi install git:github.com/chenhaoxiang/pi-messenger@<reviewed-commit>
```

不需要 daemon 或远程服务。共享协作状态默认保存到 `~/.pi/agent/messenger/`，项目 Crew 状态保存到工作目录中的 `.pi/messenger/`。

## 快速开始

加入本地协作网并查看 peer：

```ts
pi_messenger({ action: "join" })
pi_messenger({ action: "status" })
pi_messenger({ action: "feed" })
```

编辑前先占用文件：

```ts
pi_messenger({
  action: "reserve",
  paths: ["src/auth/"],
  reason: "重构认证流程",
})
pi_messenger({ action: "send", to: "SwiftRaven", message: "认证文件已占用。" })
pi_messenger({ action: "release" })
```

`/messenger` 会打开在线状态、活动、聊天和 Crew 面板；Agent 也可以直接调用 `pi_messenger` 工具。

## Fork 提供的能力

### 在线状态与消息

- 展示有主题的 Agent 名称、当前模型/分支/cwd、生命周期状态、工具调用次数和 token 用量；
- 在同一协作域中的会话之间发送私信或广播；
- 对编辑、提交、测试、消息和任务事件记录持久活动 feed；
- 检测卡住的 Agent，并清理已失效的注册；
- 支持 `autoRegister` 和按路径限制的自动注册。

### 文件占用

- 修改文件或目录前先声明占用；
- 其他 Agent 的 write/edit 调用会在占用冲突时被阻止；
- 可显式释放，也会在 session/agent 清理时释放；
- 对过期 owner 保守处理，不会静默抢占仍可能活跃的占用。

### Crew 与 Team

Crew 可以从 PRD、SPEC、DESIGN 或内联提示生成依赖图：

```ts
pi_messenger({ action: "plan" })
pi_messenger({ action: "work", autonomous: true })
pi_messenger({ action: "review", target: "task-1" })
```

依赖满足后，Worker 按波次执行。每个完成任务都会得到 `SHIP`、`NEEDS_WORK` 或 `MAJOR_RETHINK` 审查结果。Team 是可选层，额外提供角色、charter、持久记忆、可复用 profile 和风险标签审批门。

内置角色尽量采用 pi-subagents 的词汇：`planner`、`scout`、`researcher`、`worker`、`reviewer`、`delegate`、`oracle`、`evidence-auditor`。

## Fork 可靠性保证

本 fork 加固的是文件投递边界，不把本地文件系统伪装成 exactly-once 分布式消息系统：

- 只有成功写入原子 processed marker 后才删除 inbox；
- marker 包含规范化 payload fingerprint，同 ID 不同内容会被拒绝并隔离；
- 去重是有界保留，不是永久 exactly-once；
- inbox 处理使用可恢复 stale lock 的目录锁，并串行化恢复竞争；
- 锁竞争未命中会立即返回，并安排有界异步重试；
- 重试元数据与隔离路径都失败时，使用持久 pause ledger 防止重启后误投递；
- 畸形或旧 marker fail closed，不当作投递成功凭据；
- 清理是 best effort，并受 marker 的时间/数量上限约束。

这些规则保护重复投递、并发消费者、过期锁和重启期间的消息；它们不会让本地文件系统变成分布式事务系统。

## Crew 技能与项目状态

扩展内置 Crew Agent 和 `pi-messenger-crew` skill。领域技能按需从以下位置加载：

1. `~/.pi/agent/skills/`；
2. 扩展内的 `crew/skills/`；
3. 项目的 `.pi/messenger/crew/skills/`。

Crew 日志和计划状态按项目保存：

```text
<project>/.pi/messenger/crew/
├── planning-progress.md
├── tasks.json
└── ...
```

查看或定制打包 Agent：

```bash
npx pi-messenger --crew-install
npx pi-messenger --crew-uninstall
```

`.pi/messenger/crew/agents/` 下的项目副本会按名称覆盖扩展默认 Agent。

## 配置

全局配置通常位于：

```text
~/.pi/agent/pi-messenger.json
```

常用配置示例：

```json
{
  "autoRegister": false,
  "autoRegisterPaths": ["~/projects/team-collab"],
  "autoOverlay": true,
  "crewEventsInFeed": true,
  "crew": {
    "models": {
      "worker": "anthropic/claude-haiku-4-5"
    }
  }
}
```

Crew Worker 默认继承宿主会话模型，也可以由任务、角色、frontmatter 或配置覆盖。需要稳定模型合同时，使用明确的 `provider/model` 和思考级别后缀。

## 安全边界

- 协作是本地文件协作，扩展不声称提供远程可靠投递；
- reservation 是本地 write gate，不替代 Git 审查或文件系统权限；
- autonomous Crew 会在任务完成、阻塞、拒绝或达到波次/尝试上限时停止；
- 需要审批的 Team 任务在明确批准前保持阻塞；
- 消息和活动记录可能包含任务文本及文件路径，请保护本地状态目录。

## 开发

```bash
npm install
npm test
```

测试使用一次性项目目录。不要把生产仓库、凭据或私人任务历史作为 fixture。

## 许可证

MIT
