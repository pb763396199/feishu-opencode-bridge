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
  TASK_PRIORITY_LABELS,
  type TaskStatus,
  type BlockedReason,
  type TaskPriority,
} from '../config/bitable-fields.js';
import type { Task } from '../types/task.js';

// 任务命令类型
export type TaskCommand =
  | 'task_show'
  | 'task_set'
  | 'task_title_show'
  | 'task_title_set'
  | 'priority_show'
  | 'priority_set'
  | 'project_show'
  | 'workspace_show'
  | 'do'
  | 'done'
  | 'cancel'
  | 'archive'
  | 'archived_show'
  | 'followup'
  | 'close';

// 命令处理结果
export interface TaskCommandResult {
  success: boolean;
  message: string;
  card?: Record<string, unknown>;  // 需要发送的卡片
}

export interface TaskExecutionDirectoryResolution {
  directory?: string;
  source: 'resolvedDirectory' | 'defaultDirectory' | 'task.workspace_path' | 'none';
}

function redactDirectoryForLog(directory?: string): string {
  const normalized = directory?.trim();
  if (!normalized) {
    return '(none)';
  }

  const normalizedSegments = normalized.replace(/\\/g, '/').split('/').filter(Boolean);
  const tail = normalizedSegments[normalizedSegments.length - 1] || normalized;

  if (/^[A-Za-z]:[\\/]*$/.test(normalized)) {
    return normalized;
  }

  return `…/${tail}`;
}

export function resolveTaskExecutionDirectory(
  task: Pick<Task, 'workspace_path'>,
  session?: Pick<import('../store/chat-session.js').ChatSessionData, 'resolvedDirectory' | 'defaultDirectory'>
): TaskExecutionDirectoryResolution {
  const resolvedDirectory = session?.resolvedDirectory?.trim();
  if (resolvedDirectory) {
    return { directory: resolvedDirectory, source: 'resolvedDirectory' };
  }

  const defaultDirectory = session?.defaultDirectory?.trim();
  if (defaultDirectory) {
    return { directory: defaultDirectory, source: 'defaultDirectory' };
  }

  const taskWorkspacePath = task.workspace_path?.trim();
  if (taskWorkspacePath) {
    return { directory: taskWorkspacePath, source: 'task.workspace_path' };
  }

  return { source: 'none' };
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

      case 'priority_show':
        return this.handlePriorityShow(task);

      case 'priority_set':
        return this.handlePrioritySet(task, context.args || '', context.chatId);

      case 'project_show':
        return this.handleProjectShow(task);

      case 'workspace_show':
        return this.handleWorkspaceShow(task);

      case 'do':
        return this.handleDo(task, context.chatId, context.senderId);

      case 'done':
        return this.handleDone(task, context.senderId);

      case 'cancel':
        return this.handleCancel(task, context.senderId);

      case 'archive':
        return this.handleArchive(task, context.chatId, context.senderId);

      case 'archived_show':
        return this.handleArchivedShow(task, context.senderId);

      case 'followup':
        return this.handleFollowup(task, context.senderId);

      case 'close':
        return this.handleClose(task, context.senderId, context.chatId);

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
      // 重新获取最新任务（含新的 description），异步发送任务信息卡片
      taskStore.getTaskByChatId(chatId).then(updatedTask => {
        if (updatedTask) {
          feishuClient.sendCard(chatId, this.buildTaskInfoCard(updatedTask))
            .catch(err => console.warn('[TaskCommand] 发送任务信息卡片失败:', err));
        }
      }).catch(err => console.warn('[TaskCommand] 获取更新后任务失败:', err));

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
      // 同步更新飞书群名（保留状态圆圈前缀）
      const statusEmoji = this.getStatusEmoji(task.status);
      const renameOk = await feishuClient.updateChatName(chatId, `${statusEmoji} ${trimmedTitle}`);
      if (!renameOk) {
        console.warn(`[TaskCommand] 更新群名失败: chatId=${chatId}`);
      }
      return { success: true, message: `✅ 已更新任务标题为: ${trimmedTitle}` };
    }
    return { success: false, message: '❌ 更新任务标题失败' };
  }

  private handlePriorityShow(task: Task | null): TaskCommandResult {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    const priorityLabel = TASK_PRIORITY_LABELS[task.priority as keyof typeof TASK_PRIORITY_LABELS] ?? task.priority;
    return {
      success: true,
      message: `⚡ **当前优先级**: ${priorityLabel}\n\n使用 \`/priority <urgent|high|medium|low>\` 修改`,
    };
  }

  private async handlePrioritySet(task: Task | null, nextPriorityRaw: string, chatId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    const normalized = nextPriorityRaw.trim().toLowerCase();
    const allowedPriorities: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
    if (!allowedPriorities.includes(normalized as TaskPriority)) {
      return {
        success: false,
        message: '用法: /priority <urgent|high|medium|low>',
      };
    }

    const nextPriority = normalized as TaskPriority;
    const success = await taskStore.updateTaskFields(chatId, {
      priority: nextPriority,
    });
    if (!success) {
      return { success: false, message: '❌ 更新任务优先级失败' };
    }

    const priorityLabel = TASK_PRIORITY_LABELS[nextPriority];
    return {
      success: true,
      message: `✅ 已更新任务优先级为: ${priorityLabel}`,
    };
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
      message: `📂 **执行工作空间**: ${task.workspace_path}\n\n（只读，创建任务时确定）`,
    };
  }

  private async handleDo(task: Task | null, chatId: string, senderId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    // 验证权限：只有创建者可以操作
    if (task.creator_open_id !== senderId) {
      return { success: false, message: '❌ 仅任务创建者可以执行此操作' };
    }

    // 针对不同状态给出精准错误提示
    const statusMessages: Partial<Record<string, string>> = {
      IN_PROGRESS: '⚠️ AI 正在处理中，请等待完成',
      BLOCKED:     '⚠️ 请先处理阻塞（权限授权或回答问题）',
      IN_REVIEW:   '⚠️ 请直接发送消息来继续执行，或 /done 确认完成',
      DONE:        '⚠️ 任务已完成，无法重新执行',
      CANCELLED:   '⚠️ 任务已取消，无法执行',
    };

    if (task.status !== 'TODO') {
      const msg = statusMessages[task.status] || `⚠️ 当前状态「${task.status}」不支持此操作`;
      return { success: false, message: msg };
    }

    const description = task.description?.trim();
    if (!description) {
      return {
        success: false,
        message: '⚠️ 任务内容为空，请先用 `/task <内容>` 填写任务内容',
      };
    }

    // 更新任务状态为 IN_PROGRESS
    const statusOk = await taskStore.updateTaskStatus(chatId, 'IN_PROGRESS');
    if (!statusOk) {
      return { success: false, message: '❌ 更新任务状态失败' };
    }

    // 同步群标题
    await feishuClient.updateChatName(chatId, `🟡 ${task.title}`);

    // 获取 Opencode 会话
    const session = chatSessionStore.getSession(chatId);
    if (!session?.sessionId) {
      return {
        success: false,
        message: '❌ 未找到关联的 OpenCode 会话，请重新创建任务群',
      };
    }

    const normalizedExecutionAgent = task.execution_agent.trim();
    const executionDirectory = resolveTaskExecutionDirectory(task, session);

    console.log(
      `[TaskCommand] 任务执行目录解析: chat=${chatId}, task=${task.task_id}, session=${session.sessionId}, source=${executionDirectory.source}, directory=${redactDirectoryForLog(executionDirectory.directory)}, taskWorkspace=${redactDirectoryForLog(task.workspace_path)}, resolvedDirectory=${redactDirectoryForLog(session.resolvedDirectory)}, defaultDirectory=${redactDirectoryForLog(session.defaultDirectory)}`
    );

    // 异步发送给 Opencode（不 await，让确认消息先发出）
    const sendOptions = {
      ...(normalizedExecutionAgent && normalizedExecutionAgent !== 'default' ? { agent: normalizedExecutionAgent } : {}),
      ...(executionDirectory.directory ? { directory: executionDirectory.directory } : {}),
    };

    const sendPromise = opencodeClient.sendMessage(session.sessionId, description, sendOptions);

    sendPromise
      .then(() => console.log(`[TaskCommand] /do 已将任务描述发给 OpenCode: session=${session.sessionId}`))
      .catch(err => console.error('[TaskCommand] 发送任务描述到 OpenCode 失败:', err));

    const confirmMessage = `🚀 已启动执行！AI 正在处理：\n> ${description.slice(0, 100)}${description.length > 100 ? '...' : ''}`;
    return { success: true, message: confirmMessage };
  }

  private async handleDone(task: Task | null, senderId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    if (task.creator_open_id !== senderId) {
      return { success: false, message: '❌ 仅任务创建者可以执行此操作' };
    }

    // 针对不同状态给出精准提示
    const statusMessages: Partial<Record<string, string>> = {
      TODO:        '⚠️ 请先执行 /do 启动任务',
      IN_PROGRESS: '⚠️ AI 正在执行中，请等待完成后验收',
      BLOCKED:     '⚠️ 请先处理阻塞后再完成',
      DONE:        '⚠️ 任务已完成，无需重复操作',
      CANCELLED:   '⚠️ 任务已取消，无法完成',
    };

    if (task.status !== 'IN_REVIEW') {
      const msg = statusMessages[task.status] || `⚠️ 当前状态「${task.status}」不支持此操作`;
      return { success: false, message: msg };
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

    if (task.status === 'DONE') {
      return {
        success: false,
        message: '⚠️ 任务已完成，无法取消',
      };
    }

    // 返回确认卡片（传入状态，供卡片提示是否有 AI 在运行）
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
        `📋 请在此私聊中发送 \`/create_task\` 创建续集任务。\n\n建议继承以下信息：\n- **项目**: ${task.project_id || '未设置'}\n- **执行工作空间**: ${task.workspace_path || '未设置'}\n- **基于**: ${task.title}`
      );
    } catch (err) {
      console.warn('[TaskCommand] 发送续集任务提示失败:', err);
    }

    return {
      success: true,
      message: '📬 已在私聊中发送续集任务创建提示',
    };
  }

  private async handleArchive(task: Task | null, chatId: string, senderId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    if (task.creator_open_id !== senderId) {
      return { success: false, message: '❌ 仅任务创建者可以执行此操作' };
    }

    if (task.archived) {
      return { success: false, message: '⚠️ 任务已归档，无需重复操作' };
    }

    if (!['DONE', 'CANCELLED'].includes(task.status)) {
      return {
        success: false,
        message: '⚠️ 仅已完成或已取消任务可归档',
      };
    }

    const success = await taskStore.updateTaskFields(chatId, {
      archived: true,
      archived_at: Date.now(),
    });
    if (!success) {
      return {
        success: false,
        message: '❌ 归档失败，请稍后重试',
      };
    }

    return {
      success: true,
      message: '📦 任务已归档，可使用 /close 解散任务群',
    };
  }

  private async handleArchivedShow(task: Task | null, senderId: string): Promise<TaskCommandResult> {
    if (!task) {
      return { success: false, message: '当前群不是任务群' };
    }

    const archivedTasks = await taskStore.listTasks({
      archived: true,
      creator_open_id: senderId,
      ...(task.project_id ? { project_id: task.project_id } : {}),
    });
    const visibleTasks = archivedTasks
      .filter(item => item.creator_open_id === senderId)
      .filter(item => !task.project_id || item.project_id === task.project_id)
      .sort((left, right) => {
        const leftTime = left.archived_at?.getTime() ?? left.updated_at.getTime();
        const rightTime = right.archived_at?.getTime() ?? right.updated_at.getTime();
        return rightTime - leftTime;
      })
      .slice(0, 10);

    if (visibleTasks.length === 0) {
      return {
        success: true,
        message: '📦 暂无已归档任务',
      };
    }

    const lines = visibleTasks.map((item, index) => {
      const archivedAt = item.archived_at ?? item.updated_at;
      const archivedDate = Number.isNaN(archivedAt.getTime())
        ? '未知时间'
        : archivedAt.toLocaleString('zh-CN', {
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          });
      const linkOrChat = item.chat_link || item.chat_id;
      const statusLabel = TASK_STATUS_LABELS[item.status as keyof typeof TASK_STATUS_LABELS] ?? item.status;
      return `${index + 1}. ${item.title}（${statusLabel}，归档于 ${archivedDate}）\n   ${linkOrChat}`;
    });

    return {
      success: true,
      message: `📦 **已归档任务**\n\n${lines.join('\n')}`,
    };
  }

  private async handleClose(
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
      card: this.buildCloseConfirmCard(task),
    };
  }

  // ===== 辅助方法 =====

  /**
   * 根据状态返回对应的状态圆圈 emoji
   */
  getStatusEmoji(status: string): string {
    const emojiMap: Record<string, string> = {
      TODO:        '🔵',
      IN_PROGRESS: '🟡',
      BLOCKED:     '🔴',
      IN_REVIEW:   '🟣',
      DONE:        '🟢',
      CANCELLED:   '⚫',
    };
    return emojiMap[status] ?? '📋';
  }

  // ===== 卡片构建方法 =====

  /**
   * 构建任务信息卡片（含「▶ 执行任务」按钮）
   * public 以便 card-action.ts 和 p2p.ts 调用
   */
  buildTaskInfoCard(task: Task): Record<string, unknown> {
    const isExecutable = task.status === 'TODO';
    const statusLabel = TASK_STATUS_LABELS[task.status as keyof typeof TASK_STATUS_LABELS] ?? task.status;
    const priorityLabel = TASK_PRIORITY_LABELS[task.priority as keyof typeof TASK_PRIORITY_LABELS] ?? task.priority;
    const desc = task.description
      ? task.description.slice(0, 300) + (task.description.length > 300 ? '...' : '')
      : '（未设置任务内容，使用 `/task <内容>` 填写）';

    const detailLines = [
      `**执行 Agent**：${task.execution_agent || 'default'}`,
    ];

    if (task.status === 'BLOCKED' && task.blocked_reason) {
      const blockedReasonMap: Record<BlockedReason, string> = {
        question_asked: '等待回答',
        permission_asked: '等待授权',
      };
      detailLines.push(`**阻塞原因**：${blockedReasonMap[task.blocked_reason]}`);
    }

    if (task.deliverable_summary) {
      detailLines.push(`**交付摘要**：${task.deliverable_summary}`);
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: `📋 ${task.title}` },
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: desc },
        },
        {
          tag: 'div',
          fields: [
            { is_short: true, text: { tag: 'lark_md', content: `**状态**：${statusLabel}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**优先级**：${priorityLabel}` } },
          ],
        },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**执行工作空间**：${task.workspace_path}` },
        },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: detailLines.join('\n') },
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '▶ 执行任务' },
              type: 'primary',
              ...(isExecutable ? {} : { disabled: true, disabled_tip: `当前状态：${statusLabel}` }),
              action_type: 'request',
              value: { action: 'task_do', task_id: task.task_id, chat_id: task.chat_id },
            },
          ],
        },
      ],
    };
  }

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

  private buildCloseConfirmCard(task: Task): Record<string, unknown> {
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
    const isRunning = task.status === 'IN_PROGRESS';
    const extraNote = isRunning
      ? '\n• AI 正在执行，取消将同时停止 AI 工作'
      : '';

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
            content: `**确认后：**\n• 任务状态将变为已取消\n• 任务默认仍保留在当前看板，可稍后使用 \`/archive\` 手动归档${extraNote}\n• 之后可使用 \`/close\` 解散任务群`,
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
              value: {
                action: 'cancel_confirm',
                task_id: task.task_id,
                chat_id: task.chat_id,
                abort_session: isRunning,
              },
            },
          ],
        },
      ],
    };
  }
}

export const taskCommandHandler = new TaskCommandHandler();
