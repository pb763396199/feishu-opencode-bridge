# 设计文档：建群卡片支持初始 Prompt 与自动命名

**日期**：2026-03-01  
**状态**：已批准，待实现  
**作者**：AI 架构设计（经多轮专家审核）

---

## 1. 背景与目标

### 当前痛点

用户在私聊中通过建群卡片创建会话群时，只能选择会话来源和填写群名，无法在建群的同时输入初始需求。用户必须先完成建群，进入群后再手动发送第一条消息，增加了操作步骤。

此外，当前群名和 Session 名均为时间戳格式（如 `会话-xxxxxx`），可读性差，无法从名称判断群的用途。

### 目标

1. 建群卡片新增**初始 Prompt 输入框**（可选）
2. 有 Prompt 时，建群完成后**自动将 Prompt 发给 OpenCode**，用户无需手动再发一次
3. 利用 OpenCode 处理完第一条消息后**自动命名 Session** 的机制，在 `session.idle` 事件触发后，将最新 Session 标题**同步到飞书群名**

### 成功标准

- 无 Prompt：现有流程完全不变
- 有 Prompt：群建好后 AI 自动开始处理，完成后群名和 Session 名均自动更新为有意义的名称
- 任何路径下不出现循环依赖、流式渲染失效、群名被后续消息覆盖等问题

---

## 2. 方案选型

### 备选方案

| 方案 | 描述 | 结论 |
|------|------|------|
| A（采用）| `session.idle` 后拉取 Session 最新 title，比较差异后同步 | 准确、低开销、与现有事件基础设施契合 |
| B | 发完 Prompt 后延迟轮询（每 2s 查一次，最多 5 次） | 轮询开销大，时机不精确，可能拿到中间状态 |
| C | 本地截取 Prompt 前 N 字直接作为群名 | 不符合"复用 OpenCode 命名机制"需求，质量差 |

**采用方案 A**：`session.idle` 事件触发 → `getSessionById` 拉取最新 title → 比较变化 → 同步飞书群名。

---

## 3. 架构设计

### 3.1 数据流

```
用户填写 initial_prompt → create_chat_submit
  │
  ▼
p2p.ts: create_chat_submit handler
  ├─ 读取 form_value.initial_prompt（trim）
  └─ 调用 createGroupWithSessionSelection(openId, sessionId, chatId, msgId, options)
       options: { rawDirectory, customChatName, initialPrompt }
       │
       ▼
  [现有逻辑] 创建飞书群（临时群名）+ 创建 OpenCode Session
       │
       ├─ shouldSendPrompt = !!initialPrompt
       ├─ shouldAutoRename = !!initialPrompt && !customChatName && !bindExistingSession
       │
       ├─ shouldAutoRename → registerPendingAutoRename(sessionId)  ← auto-rename.ts
       │
       ├─ 发简化版 onboarding（有/无 Prompt 均发，有 Prompt 时去掉角色创建示例）
       │
       └─ shouldSendPrompt → groupHandler.sendInitialPrompt(chatId, sessionId, prompt)
                                └─ ensureStreamingBuffer + sendMessagePartsAsync
                                   （AI 开始异步处理）

OpenCode 处理 Prompt，自动命名 Session
  │
  ▼
session.idle 事件 → index.ts
  ├─ [现有] outputBuffer 完成兜底
  └─ [新增] pendingAutoRenameSet.has(sessionId)
       └─ pendingAutoRenameSet.delete(sessionId)  ← 一次性
       └─ syncSessionTitleToChat(sessionId, chatId)  ← auto-rename.ts
            ├─ opencodeClient.getSessionById(sessionId)
            ├─ 比较 session.title vs chatSessionStore.getSession(chatId).title
            ├─ 若变化：feishuClient.updateChatName(chatId, newTitle)
            └─ chatSessionStore.updateTitle(chatId, newTitle)
```

### 3.2 核心条件逻辑

```typescript
const shouldSendPrompt = !!initialPrompt;
// 用户自定义了群名：群名已确定，无需自动命名
// 绑定已有 Session：不应覆盖已有 Session 的名字
const shouldAutoRename = !!initialPrompt && !customChatName && !bindExistingSession;
```

---

## 4. 组件接口变更

### 4.1 新文件：`src/handlers/auto-rename.ts`

```typescript
/**
 * 等待自动命名的 Session ID 集合（一次性，完成后即移除）
 * 放在 handlers 层，可合法依赖 feishuClient（infra 层）
 */
export const pendingAutoRenameSet = new Set<string>();

export function registerPendingAutoRename(sessionId: string): void {
  pendingAutoRenameSet.add(sessionId);
}

export async function syncSessionTitleToChat(
  sessionId: string,
  chatId: string
): Promise<void> {
  try {
    const session = await opencodeClient.getSessionById(sessionId);
    if (!session?.title) return;

    const stored = chatSessionStore.getSession(chatId);
    if (!stored || session.title === stored.title) return; // 未变化，跳过

    const ok = await feishuClient.updateChatName(chatId, session.title);
    if (!ok) {
      console.warn(`[AutoRename] 飞书群名更新失败，已跳过: chatId=${chatId}`);
    }
    chatSessionStore.updateTitle(chatId, session.title);
    console.log(`[AutoRename] 群名已同步: ${chatId} → "${session.title}"`);
  } catch (error) {
    console.warn(`[AutoRename] 同步群名时发生异常，已跳过: sessionId=${sessionId}`, error);
  }
}
```

**依赖方向**：`auto-rename.ts` → `opencodeClient`、`chatSessionStore`、`feishuClient`。无循环依赖。

### 4.2 `src/feishu/client.ts` — 新增方法

```typescript
/**
 * 更新飞书群名称
 * 前提：机器人为群管理员（建群时已自动设置）
 */
async updateChatName(chatId: string, name: string): Promise<boolean> {
  try {
    const response = await this.client.im.chat.update({
      path: { chat_id: chatId },
      data: { name },
    });
    if (response.code === 0) {
      console.log(`[飞书] 群名已更新: chatId=${chatId}, name="${name}"`);
      return true;
    }
    console.warn(`[飞书] 更新群名失败: code=${response.code}, msg=${response.msg}`);
    return false;
  } catch (error) {
    console.warn('[飞书] updateChatName 异常:', error);
    return false;
  }
}
```

### 4.3 `src/handlers/group.ts` — 新增公共方法

```typescript
/**
 * 发送初始 Prompt（建群自动触发，不经过命令解析和附件处理）
 * 复用 ensureStreamingBuffer + processPrompt，保证流式渲染正常
 */
async sendInitialPrompt(chatId: string, sessionId: string, prompt: string): Promise<void> {
  this.ensureStreamingBuffer(chatId, sessionId, null); // null = 发新消息（非 reply）
  const sessionData = chatSessionStore.getSession(chatId);
  await this.processPromptWithConfig(sessionId, prompt, chatId, null, undefined, {
    preferredModel: sessionData?.preferredModel,
    preferredAgent: sessionData?.preferredAgent,
    preferredEffort: sessionData?.preferredEffort,
  });
}
```

> 注：`processPrompt` 为 private，需改为 protected 或抽取一个内部可调用的方法。具体实现中根据代码结构调整。

### 4.4 `src/handlers/p2p.ts` — 接口变更

**新增 Options 接口**（替换末尾散列参数）：

```typescript
interface CreateGroupOptions {
  rawDirectory?: string;
  customChatName?: string;
  initialPrompt?: string;
}
```

**`createGroupWithSessionSelection` 签名变更**：

```typescript
// 变更前
private async createGroupWithSessionSelection(
  openId: string,
  selectedSessionId: string,
  chatId?: string,
  messageId?: string,
  rawDirectory?: string,
  customChatName?: string
): Promise<void>

// 变更后
private async createGroupWithSessionSelection(
  openId: string,
  selectedSessionId: string,
  chatId?: string,
  messageId?: string,
  options?: CreateGroupOptions
): Promise<void>
```

**`create_chat_submit` handler 新增读取**：

```typescript
// 读取初始 Prompt
const initialPrompt = formValue?.initial_prompt?.trim() || '';

// 调用时改为 options 对象
await this.createGroupWithSessionSelection(
  openId, selectedSessionId, chatId, messageId,
  { rawDirectory, customChatName, initialPrompt }
);
```

### 4.5 `src/feishu/cards.ts` — 卡片新增字段

**`CreateChatCardData` 接口**：

```typescript
export interface CreateChatCardData {
  // ...现有字段...
  initialPromptInput?: string; // 用于回显（预留，正常为空）
}
```

**`buildCreateChatSelectorElements` 新增元素**（群名输入框之后）：

```typescript
// 2. 初始 Prompt 输入框（放在群名之后）
formElements.push({
  tag: 'input',
  name: 'initial_prompt',
  placeholder: {
    tag: 'plain_text',
    content: '输入初始需求（可选）。有内容则创建后自动发给 AI，并根据内容命名群组和会话',
  },
  max_length: 2000,
  ...(data.initialPromptInput ? { default_value: data.initialPromptInput } : {}),
});
```

> 不使用 `multiline: true`，避免飞书客户端兼容性风险。单行输入已满足初始需求场景。

### 4.6 `src/index.ts` — `sessionIdle` 事件扩展

```typescript
import { pendingAutoRenameSet, syncSessionTitleToChat } from './handlers/auto-rename.js';

// 监听会话空闲事件（完成兜底）
opencodeClient.on('sessionIdle', (event: any) => {
  const sessionID = toSessionId(event?.sessionID || event?.sessionId);
  if (!sessionID) return;

  const chatId = chatSessionStore.getChatId(sessionID);
  if (!chatId) return;

  // [现有逻辑] outputBuffer 完成兜底
  const bufferKey = `chat:${chatId}`;
  markActiveToolsCompleted(bufferKey);
  const buffer = outputBuffer.get(bufferKey);
  if (buffer && buffer.status === 'running') {
    outputBuffer.setStatus(bufferKey, 'completed');
  }

  // [新增] 自动命名同步（一次性）
  if (pendingAutoRenameSet.has(sessionID)) {
    pendingAutoRenameSet.delete(sessionID);
    void syncSessionTitleToChat(sessionID, chatId);
  }
});
```

---

## 5. 错误处理与边界条件

### 5.1 各节点降级策略

| 场景 | 处理方式 |
|------|---------|
| `sendInitialPrompt` 抛出异常 | catch 后向飞书群发提示 `❌ 自动发送初始需求失败，请在群内重新发送`，群和 Session 保留 |
| `getSessionById` 失败（网络抖动） | `warn` 日志，跳过命名同步，Session 从 Set 移除 |
| Session title 未变化（OpenCode 未自动命名） | 静默跳过，不调飞书 API |
| `updateChatName` 飞书 API 失败 | `warn` 日志，仍执行 `chatSessionStore.updateTitle`（内部状态一致），群名停留在临时名 |
| 进程重启（`pendingAutoRenameSet` 丢失） | 可接受，群名保持临时名，不影响功能 |

### 5.2 边界条件

| 场景 | 处理 |
|------|------|
| Prompt 仅含空白字符 | `trim()` 后视为空，走无 Prompt 流程 |
| 用户填了群名 + 填了 Prompt | `shouldSendPrompt=true`（发 Prompt），`shouldAutoRename=false`（不覆盖用户群名） |
| 绑定已有 Session + 填了 Prompt | `shouldSendPrompt=true`，`shouldAutoRename=false`（不覆盖已有 Session 名） |
| Prompt 超过 2000 字符 | 飞书 input `max_length: 2000` 在前端截断 |
| 用户建群后手动 `/rename` | `shouldAutoRename` 为一次性（Set 中的 sessionId），`/rename` 执行后 Session title 已被更新，下次 `session.idle` 不在 Set 中，不会覆盖 |

---

## 6. Onboarding 文案调整

### 有 Prompt 时（简化版）

```
👋 会话已就绪，正在自动处理您的初始需求...
🎭 使用 /panel 选择角色，使用 /help 查看完整命令。
```

### 无 Prompt 时（现有版本，不变）

```
👋 会话已就绪，直接发送需求即可开始。
🎭 使用 /panel 选择角色，使用 /help 查看完整命令。
🧩 可创建自定义角色：创建角色 名称=旅行助手; 描述=擅长规划行程; 类型=主; 工具=webfetch
```

---

## 7. 受影响文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/handlers/auto-rename.ts` | **新增** | `pendingAutoRenameSet` + `registerPendingAutoRename` + `syncSessionTitleToChat` |
| `src/feishu/client.ts` | 新增方法 | `updateChatName(chatId, name)` |
| `src/handlers/group.ts` | 新增公共方法 | `sendInitialPrompt(chatId, sessionId, prompt)` |
| `src/handlers/p2p.ts` | 修改 | 新增 `CreateGroupOptions` 接口；`createGroupWithSessionSelection` 参数 → options；`create_chat_submit` 读取 `initial_prompt` |
| `src/feishu/cards.ts` | 修改 | `CreateChatCardData` 新增 `initialPromptInput?`；表单新增 `initial_prompt` input 元素 |
| `src/index.ts` | 修改 | `sessionIdle` handler 末尾追加自动命名同步 |

---

## 8. 依赖关系图（无循环）

```
index.ts
  └─ imports: auto-rename.ts (handlers层)
       └─ imports: opencodeClient, chatSessionStore, feishuClient

p2p.ts
  └─ imports: auto-rename.ts (handlers层)
  └─ imports: groupHandler (handlers层)

group.ts
  └─ [现有依赖不变]

cards.ts
  └─ [现有依赖不变]
```

`p2p.ts` 不 import `index.ts`，循环依赖已消除。

---

## 9. 未纳入本期的内容（YAGNI）

- 飞书群名更新失败时的重试机制（降级静默已足够）
- `pendingAutoRenameSet` 持久化（进程重启降级可接受）
- Prompt 字数统计回显
- 建群时同步设置飞书群头像
