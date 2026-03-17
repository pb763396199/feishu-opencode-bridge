// 飞书卡片动作处理器
// 处理 /panel 和 question 工具的卡片交互

import { opencodeClient } from '../opencode/client.js';
import { chatSessionStore } from '../store/chat-session.js';
import { taskStore } from '../store/task-store.js';
import { outputBuffer } from '../opencode/output-buffer.js';
import { commandHandler } from './command.js';
import { feishuClient } from '../feishu/client.js';
import type { FeishuCardActionEvent } from '../feishu/client.js';
import { p2pHandler } from './p2p.js';
import { lifecycleHandler } from './lifecycle.js';

export class CardActionHandler {
  // 防重复点击：正在处理的 action
  private processingActions = new Set<string>();
  // 确认卡片单次消费锁：同一张确认卡只允许处理一次
  private consumedActionCards = new Set<string>();
  private readonly ACTION_CARD_TTL_MS = 30 * 60 * 1000;

  private buildActionCardKey(taskId: string, event: FeishuCardActionEvent, actionName?: string): string {
    if (event.messageId && event.messageId.trim()) {
      return `msg:${event.messageId}`;
    }
    const suffix = actionName && actionName.trim() ? actionName.trim() : 'unknown';
    return `task:${taskId}:${suffix}`;
  }

  private tryConsumeActionCard(taskId: string, event: FeishuCardActionEvent, actionName?: string): boolean {
    const key = this.buildActionCardKey(taskId, event, actionName);
    if (this.consumedActionCards.has(key)) {
      return false;
    }

    this.consumedActionCards.add(key);
    setTimeout(() => {
      this.consumedActionCards.delete(key);
    }, this.ACTION_CARD_TTL_MS);

    return true;
  }

  private async updateActionCard(messageId: string | undefined, card: object, scene: string): Promise<void> {
    if (!messageId) {
      return;
    }

    const success = await feishuClient.updateCard(messageId, card);
    if (!success) {
      // 200672 = 卡片已过期/状态已变更，这是预期场景（卡片已被替换或用户已操作）
      // 静默忽略，不报错
      console.log(`[CardAction] 卡片更新跳过 (${scene}): messageId=${messageId}（卡片已变更）`);
    }
  }

  private extractSelectedOption(value: unknown): string | undefined {
    if (typeof value === 'string') {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : undefined;
    }

    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const candidates = [record.value, record.key, record.label];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue;
      }
      const normalized = candidate.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }

    return undefined;
  }

  async handle(event: FeishuCardActionEvent): Promise<object | void> {
    const actionValue = event.action.value as any;
    const action = actionValue?.action;

    console.log(`[CardAction] 收到动作: ${action}, value:`, JSON.stringify(actionValue));

    switch (action) {
      case 'stop':
        return this.handleStop(actionValue);
      case 'undo':
        return this.handleUndo(actionValue);
      case 'model_select':
        return this.handleModelSelect(actionValue, event);
      case 'agent_select':
        return this.handleAgentSelect(actionValue, event);
      case 'toggle_thinking':
        return this.handleToggleThinking(actionValue, event);
      case 'create_chat':
        // P2P 创建会话，由 p2pHandler 处理
        return;
      case 'permission_allow':
      case 'permission_deny':
        // 权限确认，由 index.ts 直接处理
        return;
      case 'done_confirm':
        return this.handleDoneConfirm(actionValue, event);
      case 'done_cancel':
        return this.handleDoneCancel(actionValue, event);
      case 'cancel_confirm':
        return this.handleCancelConfirm(actionValue, event);
      case 'cancel_cancel':
        return this.handleCancelCancel(actionValue, event);
      case 'close_task_confirm':
        return this.handleCloseTaskConfirm(actionValue, event);
      case 'close_task_cancel':
        return this.handleCloseTaskCancel(actionValue, event);
      case 'create_task_submit':
        return this.handleCreateTaskSubmit(actionValue, event);
      case 'create_task_cancel':
        return { toast: { type: 'info', content: '已取消创建任务' } };
      default:
        console.warn(`[CardAction] 未知动作: ${action}`);
        return;
    }
  }

  private async handleStop(value: any): Promise<object> {
    const { conversationKey, chatId } = value;
    if (!conversationKey) return { msg: 'ok' };

    // 1. 中断本地输出缓冲
    outputBuffer.abort(conversationKey);

    // 2. 获取会话ID并中断OpenCode会话
    const session = chatId ? chatSessionStore.getSession(chatId) : null;
    if (session?.sessionId) {
      try {
        await opencodeClient.abortSession(session.sessionId);
        console.log(`[CardAction] 已中断会话: ${session.sessionId}`);
      } catch (e) {
        console.error('[CardAction] 中断会话失败:', e);
      }
    }

    return {
      toast: {
        type: 'success',
        content: '已停止',
        i18n_content: { zh_cn: '已停止', en_us: 'Stopped' }
      }
    };
  }

  private async handleUndo(value: any): Promise<object> {
    const { chatId } = value;
    if (!chatId) return { msg: 'ok' };

    try {
      await commandHandler.handleUndo(chatId);
      return {
        toast: {
          type: 'success',
          content: '已撤回',
          i18n_content: { zh_cn: '已撤回', en_us: 'Undone' }
        }
      };
    } catch (error) {
      console.error('[CardAction] Undo failed:', error);
      return {
        toast: {
          type: 'error',
          content: '撤回失败',
          i18n_content: { zh_cn: '撤回失败', en_us: 'Undo failed' }
        }
      };
    }
  }

  private async handleModelSelect(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { chatId } = value;
    const selectedOption = this.extractSelectedOption((event.action as Record<string, unknown>).option) || this.extractSelectedOption(value.selected);

    if (!chatId || !selectedOption) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    // 更新配置
    chatSessionStore.updateConfig(chatId, { preferredModel: selectedOption });
    console.log(`[CardAction] 已切换模型: ${selectedOption}`);

    const reconciled = await commandHandler.reconcilePreferredEffort(chatId);
    const effortNotice = reconciled.clearedEffort
      ? `；强度 ${reconciled.clearedEffort} 不兼容，已回退为默认`
      : '';
    const toastText = `已切换模型: ${selectedOption}${effortNotice}`;

    // 只返回toast，不更新卡片
    // 卡片更新可能失败（错误码200672），所以只返回toast确保用户知道操作成功
    return {
      toast: {
        type: 'success',
        content: toastText,
        i18n_content: { zh_cn: toastText, en_us: `Model changed: ${selectedOption}` }
      }
    };
  }

  private async handleAgentSelect(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { chatId } = value;
    const selectedOption = this.extractSelectedOption((event.action as Record<string, unknown>).option) || this.extractSelectedOption(value.selected);

    if (!chatId) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    const agentName = selectedOption === 'none' ? undefined : selectedOption;
    chatSessionStore.updateConfig(chatId, { preferredAgent: agentName });
    console.log(`[CardAction] 已切换角色: ${agentName || '默认'}`);

    // 只返回toast，不更新卡片
    return {
      toast: {
        type: 'success',
        content: agentName ? `已切换角色: ${agentName}` : '已切换为默认角色',
        i18n_content: { zh_cn: agentName ? `已切换角色: ${agentName}` : '已切换为默认角色', en_us: agentName ? `Role changed: ${agentName}` : 'Role reset to default' }
      }
    };
  }

  private async handleToggleThinking(_value: any, _event: FeishuCardActionEvent): Promise<object> {
      // 兼容历史卡片按钮：思考展开已改为飞书原生折叠面板，无需回调更新。
      return { msg: 'ok' };
  }

  // ===== 任务卡片回调处理 =====

  private async handleDoneConfirm(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { chat_id, task_id } = value;
    if (!chat_id || !task_id) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    // 单次消费确认卡：同一张卡只处理一次
    if (!this.tryConsumeActionCard(task_id, event, 'done_confirm')) {
      return {
        toast: {
          type: 'info',
          content: '⚠️ 该确认卡片已处理，请使用最新指令',
          i18n_content: { zh_cn: '⚠️ 该确认卡片已处理，请使用最新指令', en_us: '⚠️ This card was already handled' }
        }
      };
    }

    // 防重复点击检查
    const actionKey = `done_${chat_id}`;
    if (this.processingActions.has(actionKey)) {
      console.log(`[CardAction] 群 ${chat_id} 正在完成中，忽略重复点击`);
      return {
        toast: {
          type: 'info',
          content: '⏳ 正在完成任务，请稍候...',
          i18n_content: { zh_cn: '⏳ 正在完成任务，请稍候...', en_us: '⏳ Completing task, please wait...' }
        }
      };
    }

    // 先加锁，再做任何 await，避免竞态窗口
    this.processingActions.add(actionKey);

    try {
      // 获取任务当前状态
      const task = await taskStore.getTaskByChatId(chat_id);
      if (!task) {
        return { toast: { type: 'error', content: '任务不存在' } };
      }

      if (task.status === 'DONE') {
        return { toast: { type: 'info', content: '⚠️ 任务已完成，无需重复操作' } };
      }

      // 立即返回响应（飞书要求 3 秒内响应）
      // 只返回 toast，不返回 card（飞书不支持回调响应中更新卡片，会报 200672）
      // 异步执行完成操作，在群聊中发送确认消息
      this.doDoneTaskAsync(chat_id, task_id).finally(() => {
        // 3 秒后移除标记
        setTimeout(() => {
          this.processingActions.delete(actionKey);
        }, 3000);
      });

      return {
        toast: {
          type: 'success',
          content: '✅ 正在完成任务...',
          i18n_content: { zh_cn: '✅ 正在完成任务...', en_us: '✅ Completing task...' }
        }
      };
    } catch (error) {
      this.processingActions.delete(actionKey);
      console.error('[CardAction] 完成任务失败:', error);
      return { toast: { type: 'error', content: '❌ 操作失败' } };
    }
  }

  private async handleDoneCancel(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { task_id } = value;
    if (!task_id) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    if (!this.tryConsumeActionCard(task_id, event, 'done_cancel')) {
      return {
        toast: {
          type: 'info',
          content: '⚠️ 该确认卡片已处理',
          i18n_content: { zh_cn: '⚠️ 该确认卡片已处理', en_us: '⚠️ This card was already handled' }
        }
      };
    }

    // 只返回 toast，不返回 card（飞书不支持回调响应中更新卡片，会报 200672）
    return {
      toast: {
        type: 'info',
        content: '已取消',
      }
    };
  }

  private async handleCancelConfirm(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { chat_id, task_id } = value;
    if (!chat_id || !task_id) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    if (!this.tryConsumeActionCard(task_id, event, 'cancel_confirm')) {
      return {
        toast: {
          type: 'info',
          content: '⚠️ 该确认卡片已处理，请使用最新指令',
          i18n_content: { zh_cn: '⚠️ 该确认卡片已处理，请使用最新指令', en_us: '⚠️ This card was already handled' }
        }
      };
    }

    // 防重复点击检查
    const actionKey = `cancel_${chat_id}`;
    if (this.processingActions.has(actionKey)) {
      console.log(`[CardAction] 群 ${chat_id} 正在取消中，忽略重复点击`);
      return {
        toast: {
          type: 'info',
          content: '⏳ 正在取消任务，请稍候...',
          i18n_content: { zh_cn: '⏳ 正在取消任务，请稍候...', en_us: '⏳ Cancelling task, please wait...' }
        }
      };
    }

    this.processingActions.add(actionKey);

    try {
      // 获取任务当前状态
      const task = await taskStore.getTaskByChatId(chat_id);
      if (!task) {
        return { toast: { type: 'error', content: '任务不存在' } };
      }

      if (task.status === 'CANCELLED') {
        return { toast: { type: 'info', content: '⚠️ 任务已取消，无需重复操作' } };
      }

      // 立即返回响应（飞书要求 3 秒内响应）
      // 只返回 toast，不返回 card（飞书不支持回调响应中更新卡片，会报 200672）
      // 异步执行取消操作，在群聊中发送确认消息
      this.doCancelTaskAsync(chat_id, task_id).finally(() => {
        // 3 秒后移除标记
        setTimeout(() => {
          this.processingActions.delete(actionKey);
        }, 3000);
      });

      return {
        toast: {
          type: 'success',
          content: '✅ 正在取消任务...',
          i18n_content: { zh_cn: '✅ 正在取消任务...', en_us: '✅ Cancelling task...' }
        }
      };
    } catch (error) {
      this.processingActions.delete(actionKey);
      console.error('[CardAction] 取消任务失败:', error);
      return { toast: { type: 'error', content: '❌ 操作失败' } };
    }
  }

  private async handleCancelCancel(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { task_id } = value;
    if (!task_id) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    if (!this.tryConsumeActionCard(task_id, event, 'cancel_cancel')) {
      return {
        toast: {
          type: 'info',
          content: '⚠️ 该确认卡片已处理',
          i18n_content: { zh_cn: '⚠️ 该确认卡片已处理', en_us: '⚠️ This card was already handled' }
        }
      };
    }

    // 只返回 toast，不返回 card（飞书不支持回调响应中更新卡片，会报 200672）
    return {
      toast: {
        type: 'info',
        content: '已取消',
      }
    };
  }

  private async handleCloseTaskConfirm(value: any, _event: FeishuCardActionEvent): Promise<object> {
    const { chat_id, task_id } = value;
    if (!chat_id || !task_id) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    // 防重复点击检查
    const actionKey = `close_task_${chat_id}`;
    if (this.processingActions.has(actionKey)) {
      console.log(`[CardAction] 群 ${chat_id} 正在解散中，忽略重复点击`);
      return {
        toast: {
          type: 'info',
          content: '⏳ 正在解散任务群，请稍候...',
          i18n_content: { zh_cn: '⏳ 正在解散任务群，请稍候...', en_us: '⏳ Closing task group, please wait...' }
        }
      };
    }

    try {
      // 获取任务状态
      const task = await taskStore.getTaskByChatId(chat_id);
      if (!task) {
        return { toast: { type: 'error', content: '任务不存在' } };
      }

      // 标记正在处理
      this.processingActions.add(actionKey);

      // 立即返回响应（飞书要求 3 秒内响应，解散群聊可能耗时）
      // 异步执行解散操作
      this.doCloseTaskAsync(chat_id, task_id, task.status).finally(() => {
        // 3秒后移除标记（给用户足够的时间看到结果）
        setTimeout(() => {
          this.processingActions.delete(actionKey);
        }, 3000);
      });
      
      return {
        toast: {
          type: 'success',
          content: '✅ 正在解散任务群...',
          i18n_content: { zh_cn: '✅ 正在解散任务群...', en_us: '✅ Closing task group...' }
        }
      };
    } catch (error) {
      this.processingActions.delete(actionKey);
      console.error('[CardAction] 解散任务群失败:', error);
      return { toast: { type: 'error', content: '❌ 操作失败' } };
    }
  }

  /**
   * 异步执行解散任务群（避免飞书回调超时）
   */
  private async doCloseTaskAsync(chatId: string, taskId: string, taskStatus: string): Promise<void> {
    try {
      // 1. 只标记隐藏，不改变状态
      await taskStore.updateTaskFields(chatId, { hidden: true });

      // 2. 记录群解散时间
      await taskStore.updateTaskFields(chatId, { closed_at: Date.now() });

      // 3. 标记正在解散（防止事件处理器重复操作）
      lifecycleHandler.markDissolving(chatId);

      // 4. 解散群聊
      const success = await feishuClient.disbandChat(chatId);
      
      if (success) {
        // 5. 清理本地缓存
        taskStore.invalidateCache(chatId);
        chatSessionStore.removeSession(chatId);
        
        console.log(`[CardAction] 任务群已解散：${chatId}，任务状态保持：${taskStatus}`);
      } else {
        console.error(`[CardAction] 解散任务群失败：${chatId}`);
      }
    } catch (error) {
      console.error('[CardAction] 异步解散任务群失败:', error);
    }
  }

  private async handleCloseTaskCancel(_value: any, _event: FeishuCardActionEvent): Promise<object> {
    // 直接返回新卡片内容替换原卡片（飞书回调响应中的 card 字段会替换原卡片）
    return {
      toast: {
        type: 'info',
        content: '已取消',
      },
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: 'grey',
          title: { tag: 'plain_text', content: '⚠️ 解散任务群 - 已取消' }
        },
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: '继续使用 `/close_task` 可以随时解散任务群' }
          }
        ]
      }
    };
  }

  /**
   * 异步执行任务完成（避免飞书回调超时）
   */
  private async doDoneTaskAsync(chatId: string, taskId: string): Promise<void> {
    try {
      const success = await taskStore.markDone(chatId);
      if (success) {
        console.log(`[CardAction] 任务已完成：${taskId}`);
        // 注意：不再调用 updateCard，因为飞书在回调响应时已经替换了卡片
        // 在群聊中发送确认消息
        await feishuClient.sendText(chatId, '✅ 任务已完成！\n\n使用 `/close_task` 可以解散任务群');
      } else {
        console.error(`[CardAction] 完成任务失败：${taskId}`);
        await feishuClient.sendText(chatId, '❌ 完成任务失败，请稍后重试');
      }
    } catch (error) {
      console.error('[CardAction] 异步完成任务失败:', error);
      await feishuClient.sendText(chatId, '❌ 操作失败，请稍后重试');
    }
  }

  /**
   * 异步执行任务取消（避免飞书回调超时）
   */
  private async doCancelTaskAsync(chatId: string, taskId: string): Promise<void> {
    try {
      const success = await taskStore.markCancelled(chatId);
      if (success) {
        console.log(`[CardAction] 任务已取消：${taskId}`);
        // 注意：不再调用 updateCard，因为飞书在回调响应时已经替换了卡片
        // 在群聊中发送确认消息
        await feishuClient.sendText(chatId, '✅ 任务已取消\n\n使用 `/close_task` 可以解散任务群');
      } else {
        console.error(`[CardAction] 取消任务失败：${taskId}`);
        await feishuClient.sendText(chatId, '❌ 取消任务失败，请稍后重试');
      }
    } catch (error) {
      console.error('[CardAction] 异步取消任务失败:', error);
      await feishuClient.sendText(chatId, '❌ 操作失败，请稍后重试');
    }
  }

  private buildDoneProcessingCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '⏳ 正在完成任务...' }
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '任务正在完成中，请稍候...' }
        }
      ]
    };
  }

  private buildDoneFinishedCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '✅ 任务已完成' }
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '任务已标记为完成，可使用 `/close_task` 解散任务群。' }
        }
      ]
    };
  }

  private buildDoneCancelledCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'grey',
        title: { tag: 'plain_text', content: '✅ 任务完成确认 - 已取消' }
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '继续使用 `/done` 可以随时标记任务完成。' }
        }
      ]
    };
  }

  private buildCancelProcessingCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '⏳ 正在取消任务...' }
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '任务正在取消中，请稍候...' }
        }
      ]
    };
  }

  private buildCancelFinishedCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '⚠️ 任务已取消' }
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '任务已取消，可使用 `/close_task` 解散任务群。' }
        }
      ]
    };
  }

  private buildCancelCancelledCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'grey',
        title: { tag: 'plain_text', content: '⚠️ 取消任务确认 - 已取消' }
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '继续使用 `/cancel` 可以随时取消任务。' }
        }
      ]
    };
  }

  private buildActionFailedCard(title: string, content: string): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'red',
        title: { tag: 'plain_text', content: title }
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content }
        }
      ]
    };
  }

  private async handleCreateTaskSubmit(value: Record<string, unknown>, event: FeishuCardActionEvent): Promise<object> {
    const senderId = event.openId;
    if (!senderId) {
      return { toast: { type: 'error', content: '无法获取用户信息' } };
    }

    // form 容器提交时，input/select_static 值在 action.form_value 中（与 create_chat 一致）
    const formValue = event.action.form_value ?? {};
    console.log('[CardAction] create_task_submit form_value:', JSON.stringify(formValue));

    const taskTitle = (formValue.task_title ?? '').trim();
    const taskDescription = (formValue.task_description ?? '').trim() || null;
    const projectSelect = (formValue.project_select ?? '').trim();
    const projectNameInput = (formValue.project_name ?? '').trim();
    const workspaceSelect = (formValue.workspace_select ?? '').trim();
    const workspacePathInput = (formValue.workspace_path ?? '').trim();

    // 决定项目名称（下拉选择 > 手动输入）
    const projectName = (projectSelect && projectSelect !== '__manual__')
      ? projectSelect
      : projectNameInput;

    // 校验必填字段
    if (!taskTitle) {
      return { toast: { type: 'error', content: '❌ 请填写任务名称' } };
    }
    if (!projectName) {
      return { toast: { type: 'error', content: '❌ 请从下拉列表选择项目，或手动输入项目名称' } };
    }

    // 决定工作目录（下拉选择 > 手动输入）
    const workspacePath = (workspaceSelect && workspaceSelect !== '__manual__')
      ? workspaceSelect
      : workspacePathInput;
    if (!workspacePath) {
      return { toast: { type: 'error', content: '❌ 请选择或填写工作目录路径' } };
    }

    // 异步创建任务群，不阻塞卡片响应
    p2pHandler.createTaskGroup({
      openId: senderId,
      taskTitle,
      taskDescription: taskDescription || null,
      projectName,
      workspacePath,
    }).catch((err: unknown) => {
      console.error('[CardAction] 创建任务群失败:', err);
    });

    return {
      toast: {
        type: 'success',
        content: '✅ 正在创建任务群，请稍候...',
      },
    };
  }
}

export const cardActionHandler = new CardActionHandler();
