// src/handlers/task-lifecycle.ts
// 任务生命周期事件处理器：监听 OpenCode 事件自动流转 Task 状态

import { taskStore } from '../store/task-store.js';
import { chatSessionStore } from '../store/chat-session.js';
import { feishuClient } from '../feishu/client.js';

class TaskLifecycleHandler {
  // 防止同一 session 在短时间内重复触发 IN_PROGRESS（busy 事件可能多次触发）
  private inProgressSessions = new Set<string>();
  // 同步锁：防止竞态条件导致多次并发进入
  private sessionLocks = new Set<string>();
  // In Review 延迟提醒计时器
  private reviewNotifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 防重入：正在处理中的 BLOCKED 转换（chatId → 锁定中）
  private blockingChats = new Set<string>();

  /**
   * OpenCode Session 首次产生工具调用时，Task → IN_PROGRESS（兜底）
   * 正常情况下 /do 命令已立刻更新为 IN_PROGRESS，此方法作为备用保障。
   */
  async onSessionFirstToolCall(sessionId: string): Promise<void> {
    // 同步检查 + 加锁（防止竞态条件）
    if (this.inProgressSessions.has(sessionId)) {
      console.log(`[TaskLifecycle] Session ${sessionId} 已处理过，跳过`);
      return;
    }
    if (this.sessionLocks.has(sessionId)) {
      console.log(`[TaskLifecycle] Session ${sessionId} 正在处理中，跳过并发调用`);
      return;
    }

    // 加锁
    this.sessionLocks.add(sessionId);
    this.inProgressSessions.add(sessionId);
    // 30 秒后清除，允许下次 /do 重新触发
    setTimeout(() => {
      this.inProgressSessions.delete(sessionId);
      this.sessionLocks.delete(sessionId);
    }, 30_000);

    try {
      console.log(`[TaskLifecycle] 开始处理 Session ${sessionId} 的 IN_PROGRESS 状态更新`);

      const chatId = chatSessionStore.getChatId(sessionId);
      if (!chatId) {
        console.warn(`[TaskLifecycle] Session ${sessionId} 未找到对应的 chatId`);
        return;
      }

      // 强制从 Bitable 读最新状态（不用缓存），避免缓存与 Bitable 不一致导致误判
      taskStore.invalidateCache(chatId);
      console.log(`[TaskLifecycle] 已清除 chatId ${chatId} 的缓存，准备从 Bitable 读取最新状态`);

      const task = await taskStore.getTaskByChatId(chatId);
      if (!task) {
        console.warn(`[TaskLifecycle] chatId ${chatId} 未找到对应的 Task`);
        return;
      }

      console.log(`[TaskLifecycle] 查询到 Task ${task.task_id}，当前状态: ${task.status}`);

      // 只在活跃的 TODO 状态时触发兜底，跳过终态和已在 IN_PROGRESS / IN_REVIEW 的
      if (['DONE', 'CANCELLED', 'IN_PROGRESS', 'IN_REVIEW'].includes(task.status)) {
        console.log(`[TaskLifecycle] Task ${task.task_id} 状态为 ${task.status}，无需更新`);
        return;
      }

      console.log(`[TaskLifecycle] Session ${sessionId} 首次工具调用 → Task ${task.task_id} IN_PROGRESS（兜底）`);

      const success = await taskStore.updateTaskStatus(chatId, 'IN_PROGRESS');
      if (success) {
        console.log(`[TaskLifecycle] ✅ Task ${task.task_id} 状态更新成功: -> IN_PROGRESS`);
        await feishuClient.updateChatName(chatId, `🟡 ${task.title}`);
      } else {
        console.warn(`[TaskLifecycle] ❌ Task ${task.task_id} 状态更新失败，重试...`);
        // 并发冲突可能导致 1254045 错误，重试 3 次
        let retries = 2;
        while (retries-- > 0) {
          const freshTask = await taskStore.getTaskByChatIdFromSource(chatId);
          if (!freshTask) {
            console.error(`[TaskLifecycle] 重试时获取任务失败: ${chatId}`);
            break;
          }

          if (freshTask.status === 'IN_PROGRESS') {
            console.log(`[TaskLifecycle] 任务 ${task.task_id} 已被其他请求更新为 IN_PROGRESS`);
            break;
          }

          const retrySuccess = await taskStore.updateTaskStatus(chatId, 'IN_PROGRESS');
          if (retrySuccess) {
            console.log(`[TaskLifecycle] ✅ 重试成功 -> IN_PROGRESS`);
            await feishuClient.updateChatName(chatId, `🟡 ${task.title}`);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } catch (error) {
      console.error(`[TaskLifecycle] ❌ 处理 Session ${sessionId} 时发生异常:`, error);
    }
  }

  /**
   * OpenCode Session 进入 idle 状态时，Task IN_PROGRESS → IN_REVIEW
   * 同时启动延迟提醒计时器
   */
  async onSessionIdle(sessionId: string): Promise<void> {
    const chatId = chatSessionStore.getChatId(sessionId);
    if (!chatId) return;

    const task = await taskStore.getTaskByChatId(chatId);
    if (!task || task.status !== 'IN_PROGRESS') return;

    console.log(`[TaskLifecycle] Session ${sessionId} idle → Task ${task.task_id} IN_REVIEW`);

    const success = await taskStore.updateTaskStatus(chatId, 'IN_REVIEW');
    if (!success) {
      console.warn(`[TaskLifecycle] 更新状态为 IN_REVIEW 失败: ${task.task_id}`);
      return;
    }

    await feishuClient.updateChatName(chatId, `🟣 ${task.title}`);
    this.scheduleReviewNotify(chatId);
  }

  /**
   * 调度 In Review 验收提醒（延迟 TASK_REVIEW_NOTIFY_DELAY_MS 毫秒后发送）
   */
  private scheduleReviewNotify(chatId: string): void {
    // 取消旧计时器（防重复）
    const existing = this.reviewNotifyTimers.get(chatId);
    if (existing) clearTimeout(existing);

    const delayMs = parseInt(process.env.TASK_REVIEW_NOTIFY_DELAY_MS ?? '600000', 10);

    const timer = setTimeout(async () => {
      this.reviewNotifyTimers.delete(chatId);
      // 重新获取任务状态（用户可能已经发消息，状态已变）
      const task = await taskStore.getTaskByChatId(chatId);
      if (!task || task.status !== 'IN_REVIEW') return;

      await feishuClient.sendText(
        chatId,
        '🟣 AI 已完成本次工作，请验收结果。\n\n如验收通过，请使用 /done 完成任务\n如需继续执行，请直接在群内发送消息'
      );
    }, delayMs);

    this.reviewNotifyTimers.set(chatId, timer);
    console.log(`[TaskLifecycle] 已设置 In Review 提醒计时: chatId=${chatId}, delay=${delayMs}ms`);
  }

  /**
   * 取消 In Review 延迟提醒（用户已发消息，状态回 IN_PROGRESS）
   */
  cancelReviewNotify(chatId: string): void {
    const timer = this.reviewNotifyTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.reviewNotifyTimers.delete(chatId);
      console.log(`[TaskLifecycle] 已取消 chatId ${chatId} 的 In Review 提醒计时`);
    }
  }

  /**
   * OpenCode Session 触发权限请求时，Task IN_PROGRESS → BLOCKED（等待授权）
   * 同时更新群标题为红色，发送阻塞提示消息
   */
  async onPermissionAsked(sessionId: string): Promise<void> {
    const chatId = chatSessionStore.getChatId(sessionId);
    if (!chatId) return;

    // 同步加锁（在任何 await 之前），防止并发调用都通过检查
    if (this.blockingChats.has(chatId)) {
      console.log(`[TaskLifecycle] onPermissionAsked 重复触发，跳过: chatId=${chatId}`);
      return;
    }
    this.blockingChats.add(chatId);

    const task = await taskStore.getTaskByChatId(chatId);
    if (!task || task.status !== 'IN_PROGRESS') {
      // 状态不对，解锁（避免锁死）
      this.blockingChats.delete(chatId);
      return;
    }

    console.log(`[TaskLifecycle] Permission asked → Task ${task.task_id} BLOCKED`);
    await taskStore.setBlocked(chatId, 'permission_asked');
    await feishuClient.updateChatName(chatId, `🔴 ${task.title}`);
    await feishuClient.sendText(
      chatId,
      '⛔ 任务已暂停：AI 请求权限授权，请在上方卡片中处理后继续。'
    );
  }

  /**
   * OpenCode Session 触发提问时，Task IN_PROGRESS → BLOCKED（等待回答）
   * 同时更新群标题为红色，发送阻塞提示消息
   */
  async onQuestionAsked(sessionId: string): Promise<void> {
    const chatId = chatSessionStore.getChatId(sessionId);
    if (!chatId) return;

    // 同步加锁（在任何 await 之前），防止并发调用都通过检查
    if (this.blockingChats.has(chatId)) {
      console.log(`[TaskLifecycle] onQuestionAsked 重复触发，跳过: chatId=${chatId}`);
      return;
    }
    this.blockingChats.add(chatId);

    const task = await taskStore.getTaskByChatId(chatId);
    if (!task || task.status !== 'IN_PROGRESS') {
      // 状态不对，解锁（避免锁死）
      this.blockingChats.delete(chatId);
      return;
    }

    console.log(`[TaskLifecycle] Question asked → Task ${task.task_id} BLOCKED`);
    await taskStore.setBlocked(chatId, 'question_asked');
    await feishuClient.updateChatName(chatId, `🔴 ${task.title}`);
    await feishuClient.sendText(
      chatId,
      '⛔ 任务已暂停：AI 需要您回答问题，请在上方卡片中作答后继续。'
    );
  }

  /**
   * 用户操作（允许/拒绝权限或回答问题）后，Task BLOCKED → IN_PROGRESS
   * 同时更新群标题为黄色，发送恢复消息
   */
  async onBlockedResolved(sessionId: string): Promise<void> {
    const chatId = chatSessionStore.getChatId(sessionId);
    if (!chatId) return;

    const task = await taskStore.getTaskByChatId(chatId);
    if (!task || task.status !== 'BLOCKED') return;

    console.log(`[TaskLifecycle] Blocked resolved → Task ${task.task_id} IN_PROGRESS`);
    // 清除防重入锁，允许下一次 BLOCKED 触发
    this.blockingChats.delete(chatId);
    await taskStore.clearBlocked(chatId);  // 内部恢复为 IN_PROGRESS
    await feishuClient.updateChatName(chatId, `🟡 ${task.title}`);
  }
}

export const taskLifecycleHandler = new TaskLifecycleHandler();
