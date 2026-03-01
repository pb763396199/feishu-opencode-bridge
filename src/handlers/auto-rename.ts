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
