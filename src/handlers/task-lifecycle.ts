// src/handlers/task-lifecycle.ts
// 任务生命周期事件处理器：监听 OpenCode 事件自动流转 Task 状态

import { taskStore } from '../store/task-store.js';
import { chatSessionStore } from '../store/chat-session.js';

class TaskLifecycleHandler {
  // 防止同一 session 在短时间内重复触发 IN_PROGRESS（busy 事件可能多次触发）
  private inProgressSessions = new Set<string>();
  // 同步锁：防止竞态条件导致多次并发进入
  private sessionLocks = new Set<string>();

  /**
   * OpenCode Session 首次产生工具调用时，Task → IN_PROGRESS
   * 设计文档 §2.2: IN_PROGRESS 由首次工具调用事件触发
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
    // 30 秒后清除，允许下次 /todo 重新触发
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

      // 只在活跃状态时触发，跳过终态和已在 IN_PROGRESS 的
      if (['DONE', 'CANCELLED', 'IN_PROGRESS'].includes(task.status)) {
        console.log(`[TaskLifecycle] Task ${task.task_id} 状态为 ${task.status}，无需更新`);
        return;
      }

      console.log(`[TaskLifecycle] Session ${sessionId} 首次工具调用 → Task ${task.task_id} IN_PROGRESS`);
      
      const success = await taskStore.updateTaskStatus(chatId, 'IN_PROGRESS');
      if (success) {
        console.log(`[TaskLifecycle] ✅ Task ${task.task_id} 状态更新成功: -> IN_PROGRESS`);
      } else {
        console.warn(`[TaskLifecycle] ❌ Task ${task.task_id} 状态更新失败，重试...`);
        // 并发冲突可能导致 1254045 错误，重试 3 次
        let retries = 2;  // 失败后重试 2 次 = 总共最多 3 次尝试
        while (retries-- > 0) {
          // 重新查询任务状态（可能已被其他请求更新）
          const freshTask = await taskStore.getTaskByChatIdFromSource(chatId);
          if (!freshTask) {
            console.error(`[TaskLifecycle] 重试时获取任务失败: ${chatId}`);
            break;
          }
          
          if (freshTask.status === 'IN_PROGRESS') {
            console.log(`[TaskLifecycle] 任务 ${task.task_id} 已被其他请求更新为 IN_PROGRESS`);
            break; // 已经更新成功
          }

          // 重试更新
          const retrySuccess = await taskStore.updateTaskStatus(chatId, 'IN_PROGRESS');
          if (retrySuccess) {
            console.log(`[TaskLifecycle] ✅ 重试成功 -> IN_PROGRESS`);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 500)); // 等待片刻再重试
        }
      }
    } catch (error) {
      console.error(`[TaskLifecycle] ❌ 处理 Session ${sessionId} 时发生异常:`, error);
    }
  }

  /**
   * OpenCode Session 触发权限请求时，Task → BLOCKED（等待授权）
   * 设计文档 §2.3
   */
  async onPermissionAsked(sessionId: string): Promise<void> {
    const chatId = chatSessionStore.getChatId(sessionId);
    if (!chatId) return;

    const task = await taskStore.getTaskByChatId(chatId);
    if (!task || task.status !== 'IN_PROGRESS') return;

    console.log(`[TaskLifecycle] Permission asked → Task ${task.task_id} BLOCKED`);
    await taskStore.setBlocked(chatId, 'permission_asked');
  }

  /**
   * OpenCode Session 触发提问时，Task → BLOCKED（等待回答）
   * 设计文档 §2.3
   */
  async onQuestionAsked(sessionId: string): Promise<void> {
    const chatId = chatSessionStore.getChatId(sessionId);
    if (!chatId) return;

    const task = await taskStore.getTaskByChatId(chatId);
    if (!task || task.status !== 'IN_PROGRESS') return;

    console.log(`[TaskLifecycle] Question asked → Task ${task.task_id} BLOCKED`);
    await taskStore.setBlocked(chatId, 'question_asked');
  }

  /**
   * 用户操作（允许/拒绝权限或回答问题）后，Task BLOCKED → IN_PROGRESS
   * 设计文档 §2.3
   */
  async onBlockedResolved(sessionId: string): Promise<void> {
    const chatId = chatSessionStore.getChatId(sessionId);
    if (!chatId) return;

    const task = await taskStore.getTaskByChatId(chatId);
    if (!task || task.status !== 'BLOCKED') return;

    console.log(`[TaskLifecycle] Blocked resolved → Task ${task.task_id} IN_PROGRESS`);
    await taskStore.clearBlocked(chatId);
  }
}

export const taskLifecycleHandler = new TaskLifecycleHandler();
