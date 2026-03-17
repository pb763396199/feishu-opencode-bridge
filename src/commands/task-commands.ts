// src/commands/task-commands.ts
// 任务群专属命令处理器

import { feishuClient } from '../feishu/client.js';
import { taskStore } from '../store/task-store.js';
import { bitableClient } from '../feishu/bitable-client.js';
import { opencodeClient } from '../opencode/client.js';
import { chatSessionStore } from '../store/chat-session.js';
import {
  TASK_FIELDS,
  TASK_STATUS_LABELS,
  type TaskStatus,
  type BlockedReason,
} from '../config/bitable-fields.js';
import type { Task } from '../types/task.js';

// 任务命令类型
export type TaskCommand =
  | 'task_show'
  | 'task_set'
  | 'task_title_show'
  | 'task_title_set'
  | 'project_show'
  | 'workspace_show'
  | 'todo'
  | 'backlog'
  | 'done'
  | 'cancel'
  | 'followup'
  | 'close_task';

// 命令处理结果
export interface TaskCommandResult {
  success: boolean;
  message: string;
  card?: Record<string, unknown>;  // 需要发送的卡片
}

class TaskCommandHandler {
  /**
   * 处理任务命令
   */
  async handle(
    command: TaskCommand,
    context: {
      chatId: string;
      messageId: string;
      senderId: string;
      args?: string;
    }
  ): Promise<TaskCommandResult> {
    // 获取任务信息
    const task = await taskStore.getTaskByChatId(context.chatId);

    switch (command) {
      case 'task_show':
        return this.handleTaskShow(task);

      case 'task_set':
        return this.handleTaskSet(task, context.args || '', context.chatId);

      case 'task_title_show':
        return this.handleTaskTitleShow(task);

      case 'task_title_set':
        return this.handleTaskTitleSet(task, context.args || '', context.chatId);

      case 'project_show':
        return this.handleProjectShow(task);

      case 'workspace_show':
        return this.handleWorkspaceShow(task);

      case 'todo':
        return this.handleTodo(task, context.chatId, context.senderId);

      case 'backlog':
        return this.handleBacklog(task, context.senderId);

      case 'done':
        return this.handleDone(task, context.senderId);

      case 'cancel':
        return this.handleCancel(task, context.senderId);

      case 'followup':
        return this.handleFollowup(task, context.senderId);

      case 'close_task':
        return this.handleCloseTask(task, context.senderId, context.chatId);

      default:
        return { success: false, message: '未知命令' };
    }
  }

  // ===== 命令处理方法 =====

  private handleTaskShow(task: Task | null): TaskCommandResult {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    const content = task.description || '（未设置任务内容）';
    return {
      success: true,
      message: `📋 **任务内容**\n\n${content}\n\n使用 \`/task <新内容>\` 修改`,
    };
  }

  private async handleTaskSet(task: Task | null, content: string, chatId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    if (!content.trim()) {
      return { success: false, message: '用法: /task <新内容>' };
    }

    const success = await taskStore.updateTaskFields(chatId, {
      description: content.trim(),
    });

    if (success) {
      return { success: true, message: '✅ 已更新任务内容' };
    }
    return { success: false, message: '❌ 更新任务内容失败' };
  }

  private handleTaskTitleShow(task: Task | null): TaskCommandResult {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    return {
      success: true,
      message: `📌 **任务标题**: ${task.title}\n\n使用 \`/task_title <新标题>\` 修改`,
    };
  }

  private async handleTaskTitleSet(
    task: Task | null,
    newTitle: string,
    chatId: string
  ): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    if (!newTitle.trim()) {
      return { success: false, message: '用法: /task_title <新标题>' };
    }

    const trimmedTitle = newTitle.trim();
    const success = await taskStore.updateTaskFields(chatId, {
      title: trimmedTitle,
    });

    if (success) {
      // 同步更新飞书群名（设计文档 §10.8）
      const renameOk = await feishuClient.updateChatName(chatId, trimmedTitle);
      if (!renameOk) {
        console.warn(`[TaskCommand] 更新群名失败: chatId=${chatId}`);
      }
      return { success: true, message: `✅ 已更新任务标题为: ${trimmedTitle}` };
    }
    return { success: false, message: '❌ 更新任务标题失败' };
  }

  private async handleProjectShow(task: Task | null): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    if (!task.project_id) {
      return {
        success: true,
        message: '📁 **所属项目**: 未设置',
      };
    }

    // 从 Bitable 反查项目详细信息
    try {
      const project = await bitableClient.findProjectById(task.project_id);
      if (project) {
        let message = `📁 **所属项目**\n\n**项目名称**: ${project.name}\n**项目ID**: ${project.project_id}`;
        if (project.repo_url) {
          message += `\n**仓库地址**: ${project.repo_url}`;
        }
        message += `\n**创建时间**: ${project.created_at.toLocaleDateString('zh-CN')}`;
        return { success: true, message };
      }
      return {
        success: true,
        message: `📁 **所属项目**\n\n**项目ID**: ${task.project_id}\n（项目信息暂不可用）`,
      };
    } catch {
      return {
        success: true,
        message: `📁 **所属项目**\n\n**项目ID**: ${task.project_id}`,
      };
    }
  }

  private handleWorkspaceShow(task: Task | null): TaskCommandResult {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    return {
      success: true,
      message: `📂 **工作目录**: ${task.workspace_path}\n\n（只读，创建任务时确定）`,
    };
  }

  private async handleTodo(task: Task | null, chatId: string, senderId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    // 验证权限：只有创建者可以操作
    if (task.creator_open_id !== senderId) {
      return { success: false, message: '❌ 仅任务创建者可以执行此操作' };
    }

    // 状态检查：只允许从 INBOX 或 TODO 启动（防止重复启动和状态回退）
    if (!['INBOX', 'TODO'].includes(task.status)) {
      const statusLabels: Record<string, string> = {
        DONE: '已完成',
        CANCELLED: '已取消',
        IN_PROGRESS: '进行中',
        BLOCKED: '被阻塞',
        BACKLOG: '待规划',
      };
      const statusLabel = statusLabels[task.status] || task.status;
      return {
        success: false,
        message: `⚠️ 任务当前状态为「${statusLabel}」，无法重复启动`,
      };
    }

    const description = task.description?.trim();
    if (!description) {
      return {
        success: false,
        message: '⚠️ 任务内容为空，请先用 `/task <内容>` 填写任务内容',
      };
    }

    // 更新任务状态为 TODO
    const statusOk = await taskStore.updateTaskStatus(chatId, 'TODO');
    if (!statusOk) {
      return { success: false, message: '❌ 更新任务状态失败' };
    }

    // 将任务描述发送给 OpenCode
    const session = chatSessionStore.getSession(chatId);
    if (!session?.sessionId) {
      return {
        success: false,
        message: '❌ 未找到关联的 OpenCode 会话，请重新创建任务群',
      };
    }

    // 先返回确认消息，再异步发给 OpenCode
    // 避免 OpenCode 流式回复比确认消息先到达飞书群
    const confirmMessage = `✅ 已启动执行！AI 正在处理：\n> ${description.slice(0, 100)}${description.length > 100 ? '...' : ''}`;

    // 异步发送给 OpenCode（不 await，让确认消息先发出）
    opencodeClient.sendMessage(session.sessionId, description)
      .then(() => console.log(`[TaskCommand] /todo 已将任务描述发给 OpenCode: session=${session.sessionId}`))
      .catch(err => console.error('[TaskCommand] 发送任务描述到 OpenCode 失败:', err));

    return { success: true, message: confirmMessage };
  }

  private async handleBacklog(task: Task | null, senderId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    // 验证权限：只有创建者可以操作
    if (task.creator_open_id !== senderId) {
      return { success: false, message: '❌ 仅任务创建者可以执行此操作' };
    }

    // 已取消的任务不能再移到待规划
    if (task.status === 'CANCELLED') {
      return {
        success: false,
        message: '⚠️ 任务已取消，无法移至待规划',
      };
    }

    const success = await taskStore.updateTaskStatus(task.chat_id, 'BACKLOG');

    if (success) {
      return { success: true, message: '✅ 已移至待规划' };
    }
    return { success: false, message: '❌ 更新状态失败' };
  }

  private async handleDone(task: Task | null, senderId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    if (task.creator_open_id !== senderId) {
      return { success: false, message: '❌ 仅任务创建者可以执行此操作' };
    }

    // 已取消的任务不能再完成
    if (task.status === 'CANCELLED') {
      return {
        success: false,
        message: '⚠️ 任务已取消，无法完成',
      };
    }

    if (task.status === 'BLOCKED') {
      return {
        success: false,
        message: '⚠️ 任务当前被阻塞，请先处理阻塞后再完成',
      };
    }

    // 返回确认卡片
    return {
      success: true,
      message: '',
      card: this.buildDoneConfirmCard(task),
    };
  }

  private async handleCancel(task: Task | null, senderId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    if (task.creator_open_id !== senderId) {
      return { success: false, message: '❌ 仅任务创建者可以执行此操作' };
    }

    // 已取消的任务不能重复取消
    if (task.status === 'CANCELLED') {
      return {
        success: false,
        message: '⚠️ 任务已取消，无需重复操作',
      };
    }

    // 返回确认卡片（与 /done 一致）
    return {
      success: true,
      message: '',
      card: this.buildCancelConfirmCard(task),
    };
  }

  private async handleFollowup(task: Task | null, senderId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    if (task.creator_open_id !== senderId) {
      return { success: false, message: '❌ 仅任务创建者可以执行此操作' };
    }

    if (task.status !== 'DONE') {
      return {
        success: false,
        message: '⚠️ 仅已完成的任务可以创建续集',
      };
    }

    // 通知用户在私聊中用 /create_task 创建续集任务（预填当前任务信息）
    try {
      await feishuClient.sendText(
        senderId,
        `📋 请在此私聊中发送 \`/create_task\` 创建续集任务。\n\n建议继承以下信息：\n- **项目**: ${task.project_id || '未设置'}\n- **工作目录**: ${task.workspace_path || '未设置'}\n- **基于**: ${task.title}`
      );
    } catch (err) {
      console.warn('[TaskCommand] 发送续集任务提示失败:', err);
    }

    return {
      success: true,
      message: '📬 已在私聊中发送续集任务创建提示',
    };
  }

  private async handleCloseTask(
    task: Task | null,
    senderId: string,
    chatId: string
  ): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    if (task.creator_open_id !== senderId) {
      return { success: false, message: '❌ 仅任务创建者可以执行此操作' };
    }

    if (!['DONE', 'CANCELLED'].includes(task.status)) {
      return {
        success: false,
        message: '⚠️ 仅已完成或已取消任务可解散群',
      };
    }

    // 返回确认卡片
    return {
      success: true,
      message: '',
      card: this.buildCloseTaskConfirmCard(task),
    };
  }

  // ===== 卡片构建方法 =====

  private buildDoneConfirmCard(task: Task): Record<string, unknown> {
    return {
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**✅ 任务完成确认**\n\n「${task.title}」`,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '**注意：** 确认完成后任务将标记为已完成状态',
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '继续工作' },
              type: 'default',
              action_type: 'request',
              value: { action: 'done_cancel', task_id: task.task_id, chat_id: task.chat_id },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '确认完成' },
              type: 'primary',
              action_type: 'request',
              value: { action: 'done_confirm', task_id: task.task_id, chat_id: task.chat_id },
            },
          ],
        },
      ],
    };
  }

  private buildCloseTaskConfirmCard(task: Task): Record<string, unknown> {
    return {
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**⚠️ 确认解散任务群？**\n\n「${task.title}」`,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '**解散后：**\n• 任务记录保留在多维表格\n• 群聊历史将被删除\n• 此操作不可恢复',
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '取消' },
              type: 'default',
              action_type: 'request',
              value: { action: 'close_task_cancel', task_id: task.task_id },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '确认解散' },
              type: 'danger',
              action_type: 'request',
              value: { action: 'close_task_confirm', task_id: task.task_id, chat_id: task.chat_id },
            },
          ],
        },
      ],
    };
  }

  private buildCancelConfirmCard(task: Task): Record<string, unknown> {
    return {
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**⚠️ 取消任务确认**\n\n「${task.title}」`,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '**确认后：**\n• 任务状态将变为已取消\n• 任务将在看板中隐藏\n• 之后可使用 `/close_task` 解散任务群',
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '继续任务' },
              type: 'default',
              action_type: 'request',
              value: { action: 'cancel_cancel', task_id: task.task_id, chat_id: task.chat_id },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '确认取消' },
              type: 'danger',
              action_type: 'request',
              value: { action: 'cancel_confirm', task_id: task.task_id, chat_id: task.chat_id },
            },
          ],
        },
      ],
    };
  }
}

export const taskCommandHandler = new TaskCommandHandler();
