# pi-lark-notify

pi 主对话 ⇄ 飞书 双向桥。人在外面，用手机飞书就能远程指挥 pi 连续干活。

```
pi 完成任务 → 飞书收到通知（含完整回复原文）
           → 你长按通知回复"顺便把测试也跑了"
           → 该 pi 会话自动收到这句话并继续执行
           → 完成后又收到通知 → ……
```

## 功能

- **下行通知**：主对话每次彻底完成（`agent_settled`，自动重试/压缩不算）时，把项目名、完成时间、最后一条回复**完整原文**推送到飞书私聊或群聊
- **上行回注**：监听飞书 `im.message.receive_v1` 事件（WebSocket 长连接，**无需公网 webhook**），把你的回复通过 `pi.sendUserMessage` 注入对应会话继续执行（会话忙时自动排队）
- **精确路由**：回复某条通知 → 注入发出该通知的会话（按 message_id 匹配，多窗口不串话）；直接发消息 → 注入最近通知过的会话
- **天然排除子 agent**：subagent / workflow 运行在独立进程，不会触发主会话事件
- **安全边界**：只接受指定用户（`userId`）的单聊消息，他人给机器人发消息不会触发任何动作
- **多会话协调**：跨会话共享状态文件（目录锁保护），`/reload` 后旧实例残留的事件消费者自动清理

## 依赖

| 依赖 | 说明 | 安装 |
|---|---|---|
| `@amaster.ai/pi-lark` | 提供 lark-cli 自动安装与凭证初始化 | `pi install npm:@amaster.ai/pi-lark` |
| `@larksuite/cli`（lark-cli） | 飞书官方 CLI，发消息/事件监听都由它执行 | pi-lark 在会话启动时自动安装到 `~/.lark-cli`，无需手动 |

## 新机器落地（完整步骤）

### 1. 安装两个包

```bash
pi install npm:@amaster.ai/pi-lark
pi install git:github.com/<你的账号>/pi-lark-notify   # 推送仓库后
# 或者直接拷贝本目录到目标机器，按本地路径安装：
pi install /path/to/pi-lark-notify
```

### 2. 飞书自建应用（可多台机器复用同一个）

在 [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用，或复用已有的：

1. **开启机器人能力**（应用能力 → 机器人）
2. **开通权限**（权限管理）：
   - `im:message`（获取与发送单聊、群组消息）
   - `im:message:send_as_bot`（以应用的身份发消息）
   - `contact:user.id:readonly`（可选，用于通过手机号/邮箱查 open_id）
3. **创建版本并发布**（版本管理与发布）——权限必须发布后才生效

> 事件接收走 WebSocket 长连接，**不需要**在控制台配置事件订阅，也不需要公网回调地址。

### 3. 配置 `~/.pi/agent/settings.json`

```json
{
  "pi-lark": {
    "appId": "cli_xxx",
    "appSecret": "${LARK_APP_SECRET}",
    "domain": "feishu"
  },
  "lark-notify": {
    "enabled": true,
    "userId": "ou_xxx"
  }
}
```

- `appSecret` 支持 `${ENV_VAR}` 环境变量语法，避免明文
- **复用同一个应用时 appId/appSecret/open_id 全部不变**（open_id 是"应用 × 用户"维度，与机器无关），配置可直接照抄
- 不知道自己的 open_id？配好凭证后执行：

```bash
lark-cli api POST "/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id" \
  --data '{"mobiles":["你的手机号"]}' --as bot
```

### 4. 生效与验证

1. pi 里执行 `/reload`（或重启会话）
2. 随便聊一句 → 对话完成后飞书应收到通知
3. **长按通知 → 回复** → 该会话应自动收到 `【飞书】...` 并继续执行，同时飞书收到"✅ 已转达"回执

## 配置项（`lark-notify` 一节）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（下行 + 上行） |
| `userId` | — | 私聊接收人 open_id（与 `chatId` 二选一，优先） |
| `chatId` | — | 群聊 chat_id（需先把机器人拉进群） |
| `replyEnabled` | `true` | 上行回注开关（关闭则只发通知） |
| `receipt` | `true` | 转达后回执一条"已转达 ✅" |

全局配置在 `~/.pi/agent/settings.json`，项目级可用 `<项目>/.pi/settings.json` 覆盖（例如不同项目发给不同群）。

## 注意事项

### 多机器同时使用

- **回复通知**的路由是精确的（按 message_id 匹配），多机并存也安全
- **直接发消息**（不回复通知）会注入"本机最近通知过的会话"——多台机器同时开着 pi 会话时，可能多台都注入同一条。多机场景请养成**回复具体通知**的习惯

### 装了 hermes 的机器（可选）

lark-cli 检测到 `HERMES_HOME` 等环境变量会误判运行环境并报 `config bind` 错误。本扩展内部的调用已自动清洗环境变量，不受影响；但**手动或让 agent 使用 lark 技能**时，把本包 `bin/` 下的包装脚本拷到 PATH 靠前的目录（如 `~/bin`）即可根治：

```bash
cp bin/lark-cli bin/lark-cli.cmd ~/bin/   # Windows git-bash + cmd 双版本
```

## 工作原理（简述）

```
session_start ─→ spawn `lark-cli event consume im.message.receive_v1`
                     │（NDJSON 事件流，崩溃自动重启，退避 3s→60s）
agent_settled ─→ lark-cli im +messages-send ─→ 记录 通知message_id → 本会话
事件到达 ─→ 过滤(本人/单聊/去重/防过期) ─→ 路由(reply_to 精确匹配 / lastNotifier)
           ─→ 跨会话认领(状态文件目录锁) ─→ pi.sendUserMessage(followUp)
session_shutdown ─→ 清理消费者与注册信息
```

- 共享状态：`~/.pi/agent/lark-notify-state.json`（目录锁 `*.lock` 互斥，15s 死锁自动破除）
- 会话身份：每个扩展实例随机 sid，注入前以 sid 认领事件，杜绝多窗口重复注入

## 文件结构

```
pi-lark-notify/
├── package.json            # pi 包清单（extensions 声明）
├── extensions/
│   └── lark-notify.ts      # 扩展本体（单文件，零依赖）
├── bin/                    # 可选：hermes 环境 lark-cli 包装脚本
│   ├── lark-cli
│   └── lark-cli.cmd
└── README.md
```

## 卸载

```bash
pi remove pi-lark-notify
# 如不再需要 lark 能力：pi remove npm:@amaster.ai/pi-lark
```

删除 settings.json 中的 `pi-lark` / `lark-notify` 两节即可彻底清理。
