// src/handlers/member-events.ts
// 飞书群成员事件处理器

import { feishuClient } from '../feishu/client.js';
import { taskStore } from '../store/task-store.js';

/**
 * 成员退群事件数据
 */
export interface MemberRemovedEvent {
  chatId: string;
  userId: string;
  operatorId?: string;
}

/**
 * 成员事件处理器
 * 处理任务群中创建者退群后的自动拉回逻辑
 */
class MemberEventsHandler {
  /**
   * 处理成员退群事件
   */
  async handleMemberRemoved(event: MemberRemovedEvent): Promise<void> {
    console.log(`[MemberEvents] 用户退群：chat=${event.chatId}, user=${event.userId}`);

    // 检查是否为任务群
    const task = await taskStore.getTaskByChatId(event.chatId);
    if (!task) {
      console.log(`[MemberEvents] 非任务群，忽略退群事件`);
      return;
    }

    // 检查是否为创建者
    if (event.userId !== task.creator_open_id) {
      console.log(`[MemberEvents] 非创建者退群，忽略`);
      return;
    }

    // 只在任务执行中时拉回（IN_PROGRESS/BLOCKED），已完成/已取消的任务不拉回
    if (['DONE', 'CANCELLED', 'ARCHIVED'].includes(task.status)) {
      console.log(`[MemberEvents] 任务状态为 ${task.status}，无需拉回创建者`);
      return;
    }

    // 尝试拉回创建者
    console.log(`[MemberEvents] 创建者退群（任务状态=${task.status}），尝试拉回：${event.userId}`);

    const pulled = await this.pullUserBack(event.chatId, event.userId);

    if (pulled) {
      // 发送提示消息
      await feishuClient.sendText(
        event.chatId,
        '⚠️ 任务创建者不可退出任务群，已自动拉回'
      );
    } else {
      // 拉回失败，发送警告
      await feishuClient.sendText(
        event.chatId,
        '❌ 任务创建者已离职或不可用，任务无法继续。请联系管理员处理。'
      );
    }
  }

  /**
   * 拉回用户到群聊
   */
  private async pullUserBack(chatId: string, userId: string): Promise<boolean> {
    try {
      // 使用飞书 client 的 addChatMembers 方法
      const success = await feishuClient.addChatMembers(chatId, [userId]);

      if (success) {
        console.log(`[MemberEvents] 拉回成功: ${userId}`);
        return true;
      }

      console.error(`[MemberEvents] 拉回失败: userId=${userId}`);
      return false;
    } catch (error) {
      console.error(`[MemberEvents] 拉回异常:`, error);
      return false;
    }
  }

  /**
   * 处理群解散事件
   * 清理本地任务缓存
   */
  async handleChatDisbanded(chatId: string): Promise<void> {
    console.log(`[MemberEvents] 群解散: chat=${chatId}`);

    // 检查是否为任务群
    const isTaskChat = taskStore.isTaskChat(chatId);
    if (isTaskChat) {
      // 使缓存失效
      taskStore.invalidateCache(chatId);
      console.log(`[MemberEvents] 已清理任务群缓存: ${chatId}`);
    }
  }
}

export const memberEventsHandler = new MemberEventsHandler();
