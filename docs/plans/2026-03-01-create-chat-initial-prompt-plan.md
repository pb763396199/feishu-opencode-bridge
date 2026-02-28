# 建群卡片支持初始 Prompt 与自动命名 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在建群卡片中新增可选的"初始需求"输入框，有内容时自动发给 OpenCode，并在 AI 处理完成后将 session 名称同步到飞书群名和本地存储。

**Architecture:** 新增 `src/handlers/auto-rename.ts` 统一管理自动命名逻辑；`feishu/client.ts` 新增 `updateChatName`；`group.ts` 新增公共 `sendInitialPrompt`；`p2p.ts` 通过 options 对象传递 `initialPrompt`；`index.ts` 在 `sessionIdle` 末尾触发命名同步。

**Tech Stack:** TypeScript, 飞书 Node SDK (`@larksuiteoapi/node-sdk`), OpenCode SDK

**Worktree:** `F:\AiProject\FeishuOpencodeBridge\.worktrees\feature\create-chat-initial-prompt`

**Design Doc:** `docs/plans/2026-03-01-create-chat-initial-prompt-design.md`

---

## Task 1: 新增 `updateChatName` 方法到飞书客户端

**Files:**
- Modify: `src/feishu/client.ts`

**Step 1: 在 `feishu/client.ts` 末尾（`disbandChat` 方法之后）添加方法**

找到 `disbandChat` 方法（约 line 864），在其后新增：

```typescript
// 更新群名称
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

**Step 2: 构建验证**

```bash
npm run build
```

期望：无 TypeScript 错误，构建成功。

**Step 3: Commit**

```bash
git add src/feishu/client.ts
git commit -m "feat: 飞书客户端新增 updateChatName 方法"
```

---

## Task 2: 新增 `src/handlers/auto-rename.ts`

**Files:**
- Create: `src/handlers/auto-rename.ts`

**Step 1: 创建文件**

```typescript
/**
 * 自动命名模块
 * 负责：
 * 1. 追踪哪些 session 需要在 session.idle 后同步飞书群名
 * 2. 执行同步逻辑（读取 OpenCode session title → 更新飞书群名 → 更新本地缓存）
 */
import { opencodeClient } from '../opencode/client.js';
import { chatSessionStore } from '../store/chat-session.js';
import { feishuClient } from '../feishu/client.js';

/**
 * 等待自动命名的 session ID 集合（一次性触发，完成后即移除）
 */
export const pendingAutoRenameSet = new Set<string>();

/**
 * 注册一个 session 以待自动命名
 * 应在 sendInitialPrompt 之前调用，确保时序正确
 */
export function registerPendingAutoRename(sessionId: string): void {
  pendingAutoRenameSet.add(sessionId);
}

/**
 * 将 OpenCode session 最新标题同步到飞书群名和本地缓存
 * 在 session.idle 事件中一次性触发
 */
export async function syncSessionTitleToChat(
  sessionId: string,
  chatId: string
): Promise<void> {
  try {
    const session = await opencodeClient.getSessionById(sessionId);
    if (!session?.title) {
      console.log(`[AutoRename] session title 为空，跳过: sessionId=${sessionId}`);
      return;
    }

    const stored = chatSessionStore.getSession(chatId);
    if (!stored) {
      console.log(`[AutoRename] chatId 无记录，跳过: chatId=${chatId}`);
      return;
    }

    if (session.title === stored.title) {
      console.log(`[AutoRename] session title 未变化，跳过: "${session.title}"`);
      return;
    }

    const ok = await feishuClient.updateChatName(chatId, session.title);
    if (!ok) {
      console.warn(`[AutoRename] 飞书群名更新失败，仅更新本地缓存: chatId=${chatId}`);
    }

    chatSessionStore.updateTitle(chatId, session.title);
    console.log(`[AutoRename] 群名已同步: chatId=${chatId}, title="${session.title}"`);
  } catch (error) {
    console.warn(`[AutoRename] 同步群名时发生异常，已跳过: sessionId=${sessionId}`, error);
  }
}
```

**Step 2: 构建验证**

```bash
npm run build
```

期望：无错误。

**Step 3: Commit**

```bash
git add src/handlers/auto-rename.ts
git commit -m "feat: 新增 auto-rename 模块，管理 session 标题自动同步逻辑"
```

---

## Task 3: `group.ts` 新增公共 `sendInitialPrompt` 方法

**Files:**
- Modify: `src/handlers/group.ts`

**Step 1: 将 `processPrompt` 改为可在子类/外部调用**

`processPrompt` 是 `private` 方法（约 line 313）。需要将其改为 `public` 或新增一个公共包装方法。

推荐方式：新增公共方法 `sendInitialPrompt`，在类末尾（`export const groupHandler` 之前）添加：

```typescript
/**
 * 发送建群初始 Prompt（由 p2p.ts 在建群后调用）
 * 复用 ensureStreamingBuffer + processPrompt，保证流式渲染正常
 * @param chatId 飞书群 ID
 * @param sessionId OpenCode session ID
 * @param prompt 初始需求文本
 */
async sendInitialPrompt(chatId: string, sessionId: string, prompt: string): Promise<void> {
  // null 表示发新消息（非 reply 到某条用户消息）
  this.ensureStreamingBuffer(chatId, sessionId, null);

  const sessionData = chatSessionStore.getSession(chatId);
  try {
    await this.processPrompt(
      sessionId,
      prompt,
      chatId,
      null as unknown as string, // messageId: 无用户消息 ID，流式卡片以新消息形式发出
      undefined, // 无附件
      {
        preferredModel: sessionData?.preferredModel,
        preferredAgent: sessionData?.preferredAgent,
        preferredEffort: sessionData?.preferredEffort,
      }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Group] sendInitialPrompt 失败:', errorMsg);
    await feishuClient.sendText(chatId, `❌ 自动发送初始需求失败，请在群内重新发送\n原因: ${errorMsg}`);
  }
}
```

注意：`processPrompt` 的 `messageId` 参数是 `string` 类型，但传 `null` 时 `ensureStreamingBuffer` 的第三个参数已经是 `null`，`processPrompt` 内部在 `reply` 时会使用 `messageId`；当 `messageId` 为 null/undefined 时会退化为 `sendText`。需要检查 `processPrompt` 签名：

```typescript
// 当前签名（约 line 313）：
private async processPrompt(
  sessionId: string,
  text: string,
  chatId: string,
  messageId: string,   // ← 这里需要允许 null
  ...
```

如果 `messageId` 是严格 `string` 类型，需要修改为 `string | null`。检查 `processPrompt` 内部对 `messageId` 的使用，确认传 `null` 安全：
- `ensureStreamingBuffer(chatId, sessionId, messageId)` — 第三参数已定义为 `string | null`，✅
- `feishuClient.reply(messageId, ...)` — `reply` 可能要求非空，需确认

若 `processPrompt` 的 `messageId` 不能为 null，则直接调 `sendMessagePartsAsync` 代替，参考 `processPrompt` 末尾的核心调用：

```typescript
// 备用方案（如 processPrompt 不接受 null messageId）：
const sessionData = chatSessionStore.getSession(chatId);
this.ensureStreamingBuffer(chatId, sessionId, null);

let providerId: string | undefined;
let modelId: string | undefined;
if (modelConfig.defaultProvider && modelConfig.defaultModel) {
  providerId = modelConfig.defaultProvider;
  modelId = modelConfig.defaultModel;
}
if (sessionData?.preferredModel) {
  const [p, m] = sessionData.preferredModel.split(':');
  if (p && m) { providerId = p; modelId = m; }
}

await opencodeClient.sendMessagePartsAsync(
  sessionId,
  [{ type: 'text', text: prompt }],
  {
    providerId,
    modelId,
    agent: sessionData?.preferredAgent,
    ...(sessionData?.preferredEffort ? { variant: sessionData.preferredEffort } : {}),
    ...(sessionData?.resolvedDirectory ? { directory: sessionData.resolvedDirectory } : {}),
  }
);
```

选择哪种方案，取决于 `processPrompt` 是否接受 `null` messageId。实现时先尝试方案一，TypeScript 报错则切换方案二。

**Step 2: 构建验证**

```bash
npm run build
```

期望：无错误。

**Step 3: Commit**

```bash
git add src/handlers/group.ts
git commit -m "feat: group handler 新增 sendInitialPrompt 公共方法"
```

---

## Task 4: `cards.ts` 建群卡片新增 initial_prompt 输入框

**Files:**
- Modify: `src/feishu/cards.ts`

**Step 1: 扩展 `CreateChatCardData` 接口**

找到 `CreateChatCardData` 接口（约 line 470），新增可选字段：

```typescript
export interface CreateChatCardData {
  selectedSessionId?: string;
  sessionOptions: CreateChatSessionOption[];
  totalSessionCount?: number;
  manualBindEnabled: boolean;
  projectOptions?: Array<{ name: string; directory: string; source: 'alias' | 'history' }>;
  allowCustomPath?: boolean;
  chatNameInput?: string;
  initialPromptInput?: string; // 新增：用于回显初始需求（正常为空）
}
```

**Step 2: 在 `buildCreateChatSelectorElements` 中添加 input 元素**

找到注释 `// 2. 会话来源选择器`（约 line 531），在其**之前**（即群名输入框之后）插入：

```typescript
// 2. 初始需求输入框（可选，有内容时创建群后自动发给 AI 并命名）
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

插入后顺序为：群名 → 初始需求 → 会话来源 → 工作项目 → 自定义目录 → 提交按钮。

**Step 3: 构建验证**

```bash
npm run build
```

期望：无错误。

**Step 4: Commit**

```bash
git add src/feishu/cards.ts
git commit -m "feat: 建群卡片新增初始需求输入框"
```

---

## Task 5: `p2p.ts` — 接口重构与逻辑扩展

**Files:**
- Modify: `src/handlers/p2p.ts`

**Step 1: 添加 `CreateGroupOptions` 接口**

在文件顶部 import 区域之后，`P2PHandler` 类定义之前，新增：

```typescript
interface CreateGroupOptions {
  rawDirectory?: string;
  customChatName?: string;
  initialPrompt?: string;
}
```

**Step 2: 修改 `createGroupWithSessionSelection` 签名**

将现有签名：
```typescript
private async createGroupWithSessionSelection(
  openId: string,
  selectedSessionId: string,
  chatId?: string,
  messageId?: string,
  rawDirectory?: string,
  customChatName?: string
): Promise<void>
```

改为：
```typescript
private async createGroupWithSessionSelection(
  openId: string,
  selectedSessionId: string,
  chatId?: string,
  messageId?: string,
  options?: CreateGroupOptions
): Promise<void>
```

**Step 3: 更新函数体内对参数的引用**

函数体内将 `rawDirectory` 替换为 `options?.rawDirectory`，将 `customChatName` 替换为 `options?.customChatName`。

在函数体适当位置（获取 `customChatName` 之后）添加 prompt 逻辑：

```typescript
const initialPrompt = options?.initialPrompt?.trim() || '';
const shouldSendPrompt = !!initialPrompt;
// 有 prompt 但用户已自定义群名，或绑定已有 session，不做自动命名
const shouldAutoRename = !!initialPrompt && !options?.customChatName && !bindExistingSession;
```

**Step 4: 在建群成功后添加自动命名注册**

在 `chatSessionStore.setSession(...)` 调用之后：

```typescript
// 注册自动命名（在 sendInitialPrompt 之前注册，确保时序）
if (shouldAutoRename) {
  registerPendingAutoRename(targetSessionId);
}
```

需要在文件顶部 import：
```typescript
import { registerPendingAutoRename } from './auto-rename.js';
```

**Step 5: 修改 onboarding 文案**

将现有 onboarding 逻辑改为：

```typescript
// 有 prompt 时：简化版 onboarding（去掉角色创建示例，改为提示正在处理）
const onboardingText = bindExistingSession
  ? [
      '🔗 已绑定已有 OpenCode 会话，直接发送需求即可继续之前上下文。',
      '🎭 使用 /panel 选择角色，使用 /help 查看完整命令。',
    ].join('\n')
  : shouldSendPrompt
  ? [
      '👋 会话已就绪，正在自动处理您的初始需求...',
      '🎭 使用 /panel 选择角色，使用 /help 查看完整命令。',
    ].join('\n')
  : [
      '👋 会话已就绪，直接发送需求即可开始。',
      '🎭 使用 /panel 选择角色，使用 /help 查看完整命令。',
      '🧩 可创建自定义角色：创建角色 名称=旅行助手; 描述=擅长规划行程; 类型=主; 工具=webfetch',
    ].join('\n');
await feishuClient.sendText(newChatId, onboardingText);
```

**Step 6: 在发送控制面板后，发送初始 prompt**

在 `commandHandler.pushPanelCard(newChatId)` 调用之后（约 line 663）：

```typescript
// 有初始 prompt 时，自动发给 OpenCode
if (shouldSendPrompt) {
  try {
    await groupHandler.sendInitialPrompt(newChatId, targetSessionId, initialPrompt);
  } catch (error) {
    console.error('[P2P] 发送初始 prompt 失败:', error);
    await feishuClient.sendText(newChatId, '❌ 自动发送初始需求失败，请在群内重新发送');
  }
}
```

需在文件顶部确认已 import `groupHandler`（当前已有）。

**Step 7: 更新 `create_chat_submit` handler 中的调用**

找到约 line 794 的调用：
```typescript
await this.createGroupWithSessionSelection(openId, selectedSessionId, chatId, messageId, rawDirectory, customChatName);
```

改为：

```typescript
// 读取初始 prompt
const initialPrompt = formValue?.initial_prompt?.trim() || '';

await this.createGroupWithSessionSelection(
  openId,
  selectedSessionId,
  chatId,
  messageId,
  { rawDirectory, customChatName, initialPrompt }
);
```

**Step 8: 构建验证**

```bash
npm run build
```

期望：无错误。

**Step 9: Commit**

```bash
git add src/handlers/p2p.ts
git commit -m "feat: p2p handler 支持建群初始 prompt，重构参数为 options 对象"
```

---

## Task 6: `index.ts` — `sessionIdle` 事件末尾追加自动命名同步

**Files:**
- Modify: `src/index.ts`

**Step 1: 在文件顶部添加 import**

找到现有的 import 区域，新增：

```typescript
import { pendingAutoRenameSet, syncSessionTitleToChat } from './handlers/auto-rename.js';
```

**Step 2: 在 `sessionIdle` 事件处理末尾追加逻辑**

找到 `sessionIdle` 事件处理（约 line 1329）：

```typescript
opencodeClient.on('sessionIdle', (event: any) => {
  const sessionID = toSessionId(event?.sessionID || event?.sessionId);
  if (!sessionID) return;

  const chatId = chatSessionStore.getChatId(sessionID);
  if (!chatId) return;

  const bufferKey = `chat:${chatId}`;
  markActiveToolsCompleted(bufferKey);
  const buffer = outputBuffer.get(bufferKey);
  if (buffer && buffer.status === 'running') {
    outputBuffer.setStatus(bufferKey, 'completed');
  }
  // ↑ 现有逻辑到此结束
});
```

在 `outputBuffer.setStatus` 之后，`}` 之前新增：

```typescript
  // 自动命名同步（一次性，仅对建群时有初始 prompt 的 session）
  if (pendingAutoRenameSet.has(sessionID)) {
    pendingAutoRenameSet.delete(sessionID); // 先删，防止重复触发
    void syncSessionTitleToChat(sessionID, chatId);
  }
```

**Step 3: 构建验证**

```bash
npm run build
```

期望：无错误。

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: sessionIdle 事件后自动同步 session 标题到飞书群名"
```

---

## Task 7: 端到端功能验证

**Step 1: 构建完整项目**

```bash
npm run build
```

期望：无错误，无 TypeScript 警告（忽略已有的 any 使用）。

**Step 2: 验证变更清单**

确认以下所有文件均已按计划修改：

```
✅ src/handlers/auto-rename.ts      — 新建
✅ src/feishu/client.ts             — updateChatName 方法
✅ src/handlers/group.ts            — sendInitialPrompt 方法
✅ src/feishu/cards.ts              — initial_prompt input + CreateChatCardData 字段
✅ src/handlers/p2p.ts              — options 对象 + prompt 逻辑 + 读取 form_value
✅ src/index.ts                     — sessionIdle 末尾自动命名触发
```

**Step 3: 手动冒烟测试（如有运行环境）**

1. 私聊机器人，触发建群卡片（`/create_chat`）
2. 填写"初始需求"，点击"创建群聊"
3. 验证：进入新群后 onboarding 为简化版，AI 开始回复
4. AI 完成后，验证：群名从临时名变为有意义的名称

**Step 4: 无 prompt 回归测试**

1. 私聊机器人，触发建群卡片
2. 不填写"初始需求"，点击"创建群聊"
3. 验证：与现有流程一致，onboarding 完整，无自动命名触发

**Step 5: 最终 Commit（如有遗留）**

```bash
git log --oneline -8
```

确认 6 个功能 commit 均已存在。

---

## 关键注意事项

1. **`processPrompt` 的 `messageId` 参数**：若其签名为严格 `string`（不接受 null），在 `sendInitialPrompt` 中使用备用方案（直接调 `sendMessagePartsAsync`），参见 Task 3 中的备用方案说明。

2. **`ensureStreamingBuffer` 可见性**：该方法为 `private`，`sendInitialPrompt` 在同一个类中调用，✅ 无问题。

3. **import 顺序**：`auto-rename.ts` import 了 `feishuClient`、`opencodeClient`、`chatSessionStore`，这三个均为单例，在模块加载时已初始化，不存在循环依赖。

4. **Windows 路径**：worktree 路径含空格时 npm 命令需加引号，但本项目路径无空格，正常执行即可。
