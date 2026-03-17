import { feishuClient } from '../feishu/client.js';
import { chatSessionStore } from '../store/chat-session.js';
import { opencodeClient } from '../opencode/client.js';
import { reliabilityConfig, userConfig } from '../config.js';
import { getRuntimeCronManager } from '../reliability/runtime-cron-registry.js';
import { cleanupRuntimeCronJobsByConversation } from '../reliability/runtime-cron-orphan.js';

export interface CleanupStats {
  scannedChats: number;
  disbandedChats: number;
  deletedSessions: number;
  skippedProtectedSessions: number;
  removedOrphanMappings: number;
  removedCronJobs: number;
}

export class LifecycleHandler {
  // 正在解散的群聊集合（防止事件处理器重复操作）
  private dissolvingChats = new Set<string>();

  /**
   * 标记群聊正在解散
   */
  markDissolving(chatId: string): void {
    this.dissolvingChats.add(chatId);
    console.log(`[Lifecycle] 标记群 ${chatId} 正在解散`);
  }

  /**
   * 检查群聊是否正在解散
   */
  isDissolving(chatId: string): boolean {
    return this.dissolvingChats.has(chatId);
  }

  /**
   * 取消解散标记（解散完成后调用）
   */
  unmarkDissolving(chatId: string): void {
    this.dissolvingChats.delete(chatId);
  }

  // 启动时清理无效群
  async cleanUpOnStart(): Promise<void> {
    console.log('[Lifecycle] 正在检查无效群聊...');
    const stats = await this.runCleanupScan();
    console.log(
      `[Lifecycle] 清理统计: scanned=${stats.scannedChats}, disbanded=${stats.disbandedChats}, deletedSession=${stats.deletedSessions}, skippedProtected=${stats.skippedProtectedSessions}, removedOrphanMappings=${stats.removedOrphanMappings}, removedCronJobs=${stats.removedCronJobs}`
    );
    console.log('[Lifecycle] 清理完成');
  }

  async runCleanupScan(): Promise<CleanupStats> {
    const stats: CleanupStats = {
      scannedChats: 0,
      disbandedChats: 0,
      deletedSessions: 0,
      skippedProtectedSessions: 0,
      removedOrphanMappings: 0,
      removedCronJobs: 0,
    };

    const chats = await feishuClient.getUserChats();
    const activeChatIdSet = new Set(chats);

    // 仅处理 Feishu 平台的映射
    const feishuChatIds = chatSessionStore.getChatIdsByPlatform('feishu');

    if (chats.length === 0) {
      console.log('[Lifecycle] 当前未检索到任何群聊，跳过孤儿映射清理');
    } else {
      for (const mappedChatId of feishuChatIds) {
        if (activeChatIdSet.has(mappedChatId)) continue;
        
        // 新增：跳过最近创建的群聊（保护窗口 30 秒），避免飞书 API 同步延迟导致误删
        const session = chatSessionStore.getSession(mappedChatId);
        if (session && session.createdAt) {
          const ageMs = Date.now() - session.createdAt;
          const protectionWindowMs = 30 * 1000;
          if (ageMs < protectionWindowMs) {
            console.log('[Lifecycle] 跳过新创建群聊（保护窗口内）: chat=' + mappedChatId);
            continue;
          }
        }
        
        if (!chatSessionStore.isGroupChatSession(mappedChatId)) {
          continue;
        }
        if (reliabilityConfig.cronOrphanAutoCleanup) {
          const cronCleanup = cleanupRuntimeCronJobsByConversation(getRuntimeCronManager(), 'feishu', mappedChatId);
          stats.removedCronJobs += cronCleanup.removedJobIds.length;
        }
        chatSessionStore.removeSession(mappedChatId);
        stats.removedOrphanMappings += 1;
        console.log(`[Lifecycle] 已移除孤儿映射: chat=${mappedChatId}`);
      }
    }

    for (const chatId of chats) {
      stats.scannedChats += 1;
      await this.checkAndDisbandIfEmpty(chatId, stats);
    }

    return stats;
  }

  // 处理用户退群事件
  async handleMemberLeft(chatId: string, memberId: string): Promise<void> {
    console.log(`[Lifecycle] 用户 ${memberId} 退出群 ${chatId}`);
    
    // 如果群正在解散中（我们主动触发的），跳过检查
    if (this.isDissolving(chatId)) {
      console.log(`[Lifecycle] 群 ${chatId} 正在解散中，跳过成员退群处理`);
      return;
    }
    
    // 群解散后会触发退群事件，但群已不存在，无需检查
    try {
      await this.checkAndDisbandIfEmpty(chatId);
    } catch (error) {
      const errorCode = (error as any)?.response?.data?.code;
      // 232009: 群已解散, 232011: 操作者不在群里
      if (errorCode === 232009 || errorCode === 232011) {
        console.log(`[Lifecycle] 群 ${chatId} 已解散或不可访问，跳过清理`);
      } else {
        throw error;
      }
    }
  }

  // 检查群是否为空，为空则解散
  private async checkAndDisbandIfEmpty(chatId: string, stats?: CleanupStats): Promise<void> {
    let members: string[];
    try {
      members = await feishuClient.getChatMembers(chatId);
    } catch (error) {
      const errorCode = (error as any)?.response?.data?.code;
      // 232009: 群已解散, 232011: 操作者不在群里（用户退群后触发）
      if (errorCode === 232009 || errorCode === 232011) {
        console.log(`[Lifecycle] 群 ${chatId} 已解散或操作者已退出，跳过检查`);
        return;
      }
      throw error;
    }

    console.log(`[Lifecycle] 检查群 ${chatId} 成员数：${members.length}`);

    console.log(`[Lifecycle] 检查群 ${chatId} 成员数: ${members.length}`);

    // 未配置白名单时：只要群里还有任意成员，就不自动解散
    // 仅在成员数为 0 时才执行清理，避免误删仅剩 1 名用户的群
    if (!userConfig.isWhitelistEnabled) {
      if (members.length > 0) {
        console.log(`[Lifecycle] 群 ${chatId} 未启用白名单且仍有成员，跳过解散`);
        return;
      }

      console.log(`[Lifecycle] 群 ${chatId} 未启用白名单且成员为 0，准备解散...`);
      await this.cleanupAndDisband(chatId, stats);
      return;
    }

    // 检查是否有白名单用户在群内
    const hasAllowedUser = members.some(memberId => userConfig.allowedUsers.includes(memberId));
    
    if (hasAllowedUser) {
      console.log(`[Lifecycle] 群 ${chatId} 包含白名单用户，跳过解散检查`);
      return;
    }

    // 二次确认：检查群主是否在白名单中（防止成员列表获取失败导致误删）
    const chatInfo = await feishuClient.getChat(chatId);
    if (chatInfo && userConfig.allowedUsers.includes(chatInfo.ownerId)) {
      console.log(`[Lifecycle] 群 ${chatId} 群主(${chatInfo.ownerId})在白名单中，跳过解散检查`);
      return;
    }
    
    // 如果成员数 <= 1，认为群为空（只有机器人或无人）
    if (members.length <= 1) {
      console.log(`[Lifecycle] 群 ${chatId} 成员不足且无白名单用户，准备解散...`);
      await this.cleanupAndDisband(chatId, stats);
    }
  }

  private async cleanupAndDisband(chatId: string, stats?: CleanupStats): Promise<void> {
    // 1. 清理 OpenCode 会话
    const sessionId = chatSessionStore.getSessionId(chatId);
    if (sessionId) {
      const deleteProtected = chatSessionStore.isSessionDeleteProtected(chatId);
      if (deleteProtected) {
        console.log(`[Lifecycle] 会话删除受保护，跳过删除: ${sessionId}`);
        if (stats) stats.skippedProtectedSessions += 1;
      } else {
        // 尝试删除会话（如果 API 支持）
        try {
          const deleted = await opencodeClient.deleteSession(sessionId);
          if (deleted && stats) {
            stats.deletedSessions += 1;
          }
        } catch (e) {
          console.warn(`[Lifecycle] 删除 OpenCode 会话 ${sessionId} 失败:`, e);
        }
      }
      chatSessionStore.removeSession(chatId);
    }

    if (reliabilityConfig.cronOrphanAutoCleanup) {
      const cronCleanup = cleanupRuntimeCronJobsByConversation(getRuntimeCronManager(), 'feishu', chatId);
      if (stats) {
        stats.removedCronJobs += cronCleanup.removedJobIds.length;
      }
    }

    // 2. 解散飞书群
    try {
      const disbanded = await feishuClient.disbandChat(chatId);
      if (disbanded && stats) {
        stats.disbandedChats += 1;
      }
    } catch (error) {
      const errorCode = (error as any)?.response?.data?.code;
      if (errorCode === 232009) {
        console.log(`[Lifecycle] 群 ${chatId} 已被解散，无需重复操作`);
      } else {
        console.error(`[Lifecycle] 解散群 ${chatId} 失败:`, error);
      }
    }
  }
}

export const lifecycleHandler = new LifecycleHandler();
