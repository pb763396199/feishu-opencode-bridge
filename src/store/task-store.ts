// src/store/task-store.ts
// 任务缓存与状态管理

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { bitableClient } from '../feishu/bitable-client.js';
import type { Task, CreateTaskInput, TaskFilter } from '../types/task.js';
import type { TaskStatus, BlockedReason, TaskPriority } from '../config/bitable-fields.js';

interface TaskStoreData {
  tasks: Record<string, Task>;  // chat_id -> Task
  lastSync: number;
}

// ESM 模式下使用 fileURLToPath 定位项目根目录，避免 cwd 不一致
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_FILE = path.join(__dirname, '../../.task-store.json');
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 分钟缓存

class TaskStore {
  private cache: Map<string, Task> = new Map();  // chat_id -> Task
  private cacheTimestamps: Map<string, number> = new Map();  // chat_id -> 缓存时间戳
  private lastSync: number = 0;
  private diskCache: Set<string> | null = null;  // 懒加载的磁盘 chat_id 集合，用于 isTaskChat 回退

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const content = fs.readFileSync(STORE_FILE, 'utf-8');
        const data = JSON.parse(content) as TaskStoreData;

        for (const [chatId, task] of Object.entries(data.tasks)) {
          this.cache.set(chatId, this.deserializeTask(task));
          this.cacheTimestamps.set(chatId, Date.now()); // 加载时设置时间戳
        }

        this.lastSync = data.lastSync || 0;
        console.log(`[TaskStore] 已加载 ${this.cache.size} 个任务缓存`);
      }
    } catch (error) {
      console.error('[TaskStore] 加载缓存失败:', error);
    }
  }

  private saveToDisk(): void {
    try {
      const data: TaskStoreData = {
        tasks: Object.fromEntries(this.cache),
        lastSync: Date.now(),
      };
      fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
      // 保存后使磁盘缓存回退失效，下次 isTaskChat 调用时重新加载
      this.diskCache = null;
    } catch (error) {
      console.error('[TaskStore] 保存缓存失败:', error);
    }
  }

  private deserializeTask(raw: Task): Task {
    const legacy = raw as unknown as {
      assignee?: string;
      hidden?: boolean;
      archived?: boolean;
      archived_at?: Date | string | number | null;
    };

    return {
      ...raw,
      execution_agent: raw.execution_agent ?? legacy.assignee ?? 'default',
      created_at: new Date(raw.created_at),
      started_at: raw.started_at ? new Date(raw.started_at) : null,
      done_at: raw.done_at ? new Date(raw.done_at) : null,
      closed_at: raw.closed_at ? new Date(raw.closed_at) : null,
      status_updated_at: new Date(raw.status_updated_at),
      unblocked_at: raw.unblocked_at ? new Date(raw.unblocked_at) : null,
      archived: raw.archived ?? legacy.hidden ?? false,
      archived_at: (raw.archived_at ?? legacy.archived_at) ? new Date((raw.archived_at ?? legacy.archived_at) as string | number | Date) : null,
      updated_at: new Date(raw.updated_at),
    };
  }

  // ===== 核心操作 =====

  /**
   * 更新缓存（同时更新时间戳）
   */
  private updateCache(chatId: string, task: Task): void {
    this.cache.set(chatId, task);
    this.cacheTimestamps.set(chatId, Date.now());
  }

  /**
   * 按 chat_id 获取任务
   */
  async getTaskByChatId(chatId: string): Promise<Task | null> {
    // 1. 检查缓存
    const cached = this.cache.get(chatId);
    const cachedAt = this.cacheTimestamps.get(chatId);
    if (cached && cachedAt) {
      // 检查单个缓存项是否过期
      if (Date.now() - cachedAt < CACHE_TTL_MS) {
        return cached;
      }
      // 缓存过期，删除
      this.cache.delete(chatId);
      this.cacheTimestamps.delete(chatId);
    }

    // 2. 从 Bitable 查询
    const task = await bitableClient.findTaskByChatId(chatId);
    if (task) {
      this.updateCache(chatId, task);
      this.saveToDisk();
    }
    return task;
  }

  /**
   * 按 opencode_session_id 获取任务
   */
  async getTaskBySessionId(sessionId: string): Promise<Task | null> {
    // 遍历缓存查找（同时检查 TTL）
    for (const [chatId, task] of this.cache.entries()) {
      if (task.opencode_session_id === sessionId) {
        const cachedAt = this.cacheTimestamps.get(chatId);
        // 检查缓存是否有效
        if (cachedAt && Date.now() - cachedAt < CACHE_TTL_MS) {
          return task;
        }
        // 缓存过期，删除
        this.cache.delete(chatId);
        this.cacheTimestamps.delete(chatId);
        break;
      }
    }

    // 从 Bitable 查询
    const task = await bitableClient.findTaskBySessionId(sessionId);
    if (task) {
      this.updateCache(task.chat_id, task);
      this.saveToDisk();
    }
  return task;
}

/**
 * 直接从 Bitable 查询（绕过缓存获取权威状态）
 */
async getTaskByChatIdFromSource(chatId: string): Promise<Task | null> {
  return await bitableClient.findTaskByChatId(chatId); // 现有方法本身就不走缓存
}

/**
 * 创建新任务
   */
  /**
   * 预注册任务群（Bitable 写入前先标记，确保 isTaskChat 立刻生效）
   * Bitable 写入成功后 createTask 会用完整 Task 覆盖此占位符
   */
  registerTaskChat(chatId: string, input: CreateTaskInput, sessionId: string): void {
    const now = new Date();
    const placeholder: Task = {
      task_id: `local_${chatId}`,
      chat_id: chatId,
      opencode_session_id: sessionId,
      title: input.title,
      description: input.description ?? null,
      workspace_path: input.workspace_path,
      creator_open_id: input.creator_open_id,
      status: 'TODO',
      priority: 'medium',
      blocked_reason: null,
      execution_agent: 'default',
      chat_link: '',
      started_at: null,
      done_at: null,
      created_at: now,
      closed_at: null,
      status_updated_at: now,
      unblocked_at: null,
      updated_at: now,
      deliverable_summary: null,
      project_id: null,
      archived: false,
      archived_at: null,
    };
    this.updateCache(chatId, placeholder);
    this.saveToDisk();
    console.log(`[TaskStore] 已预注册任务群: ${chatId}`);
  }

  async createTask(input: CreateTaskInput, sessionId: string, chatId: string): Promise<Task | null> {
    const task = await bitableClient.createTask(input, sessionId, chatId);
    if (task) {
      this.updateCache(chatId, task);
      this.saveToDisk();
    }
    return task;
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(chatId: string, status: TaskStatus): Promise<boolean> {
    const task = await this.getTaskByChatId(chatId);
    if (!task) return false;

    // IN_PROGRESS 时同时写入 started_at（首次进入时）
    const extraFields: Record<string, unknown> = {};
    if (status === 'IN_PROGRESS' && !task.started_at) {
      extraFields['started_at'] = Date.now();  // 使用英文字段名，updateTaskStatus 内部会映射
    }

    const success = await bitableClient.updateTaskStatus(task.task_id, status, extraFields);
    if (success) {
      task.status = status;
      task.status_updated_at = new Date();
      task.updated_at = new Date();
      if (status === 'IN_PROGRESS' && !task.started_at) {
        task.started_at = new Date();
      }
      this.updateCache(chatId, task);
      this.saveToDisk();
    }
    return success;
  }

  /**
   * 设置任务为阻塞状态
   */
  async setBlocked(chatId: string, reason: BlockedReason): Promise<boolean> {
    const task = await this.getTaskByChatId(chatId);
    if (!task) return false;

    const success = await bitableClient.setBlocked(task.task_id, reason);
    if (success) {
      task.status = 'BLOCKED';
      task.blocked_reason = reason;
      task.status_updated_at = new Date();
      this.updateCache(chatId, task);
      this.saveToDisk();
    }
    return success;
  }

  /**
   * 标记任务为待验收（In Review）
   */
  async setInReview(chatId: string): Promise<boolean> {
    return this.updateTaskStatus(chatId, 'IN_REVIEW');
  }

  /**
   * 清除任务阻塞状态
   */
  async clearBlocked(chatId: string): Promise<boolean> {
    const task = await this.getTaskByChatId(chatId);
    if (!task) return false;

    const success = await bitableClient.clearBlocked(task.task_id);
    if (success) {
      task.status = 'IN_PROGRESS';
      task.blocked_reason = null;
      task.unblocked_at = new Date();
      task.status_updated_at = new Date();
      this.updateCache(chatId, task);
      this.saveToDisk();
    }
    return success;
  }

  /**
   * 标记任务完成
   */
  async markDone(chatId: string): Promise<boolean> {
    const task = await this.getTaskByChatId(chatId);
    if (!task) return false;

    // 飞书日期字段要求毫秒级时间戳，不能用 ISO 字符串
    const success = await bitableClient.updateTaskFields(task.task_id, {
      done_at: Date.now(),
    });

    if (success) {
      await this.updateTaskStatus(chatId, 'DONE');
    }
    return success;
  }

  /**
   * 更新任务完成摘要
   */
  async updateDeliverableSummary(chatId: string, summary: string): Promise<boolean> {
    const task = await this.getTaskByChatId(chatId);
    if (!task) return false;

    const trimmed = summary.trim();
    if (!trimmed) return false;

    const success = await bitableClient.updateTaskFields(task.task_id, {
      deliverable_summary: trimmed,
    });
    if (success) {
      task.deliverable_summary = trimmed;
      task.updated_at = new Date();
      this.updateCache(chatId, task);
      this.saveToDisk();
    }
    return success;
  }

  /**
   * 标记任务取消
   */
  async markCancelled(chatId: string): Promise<boolean> {
    const task = await this.getTaskByChatId(chatId);
    if (!task) return false;

    const success = true;
    if (success) {
      await this.updateTaskStatus(chatId, 'CANCELLED');
    }
    return success;
  }

  /**
   * 更新任务通用字段
   */
  async updateTaskFields(
    chatId: string,
    fields: Partial<Record<keyof Task, string | number | boolean | null>>
  ): Promise<boolean> {
    const task = await this.getTaskByChatId(chatId);
    if (!task) return false;

    const success = await bitableClient.updateTaskFields(task.task_id, fields as Record<string, string | number | boolean | null>);
    if (success) {
      // 更新缓存 - 类型安全地更新字段
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'title') task.title = value as string;
        else if (key === 'description') task.description = value as string | null;
        else if (key === 'status') task.status = value as TaskStatus;
        else if (key === 'priority') task.priority = value as TaskPriority;
        else if (key === 'execution_agent') task.execution_agent = value as string;
        else if (key === 'project_id') task.project_id = value as string | null;
        else if (key === 'archived') task.archived = value as boolean;
        else if (key === 'archived_at') task.archived_at = value ? new Date(value as number | string) : null;
        else if (key === 'opencode_session_id') task.opencode_session_id = value as string;
        else if (key === 'deliverable_summary') task.deliverable_summary = value as string | null;
        // 其他字段按需添加
      }
      task.updated_at = new Date();
      this.updateCache(chatId, task);
      this.saveToDisk();
    }
    return success;
  }

  /**
   * 列出任务
   */
  async listTasks(filter?: TaskFilter): Promise<Task[]> {
    const tasks = await bitableClient.listTasks(filter);
    // 更新缓存
    for (const task of tasks) {
      this.updateCache(task.chat_id, task);
    }
    this.saveToDisk();
    return tasks;
  }

  // ===== 辅助方法 =====

  /**
   * 懒加载磁盘持久化文件中的 chat_id 集合
   * 用于 isTaskChat 在内存缓存未命中时的回退检查
   */
  private loadDiskCacheIfNeeded(): Set<string> {
    if (this.diskCache !== null) {
      return this.diskCache;
    }

    this.diskCache = new Set<string>();
    try {
      if (fs.existsSync(STORE_FILE)) {
        const content = fs.readFileSync(STORE_FILE, 'utf-8');
        const data = JSON.parse(content) as TaskStoreData;
        for (const chatId of Object.keys(data.tasks || {})) {
          this.diskCache.add(chatId);
        }
      }
    } catch (error) {
      console.error('[TaskStore] 加载磁盘缓存回退失败:', error);
      // 保持空集合，后续会重试
    }
    return this.diskCache;
  }

  /**
   * 检查是否为任务群
   * 优先检查内存缓存；若未命中则回退检查磁盘持久化文件
   */
  isTaskChat(chatId: string): boolean {
    // 1. 首先检查内存缓存
    if (this.cache.has(chatId)) {
      return true;
    }

    // 2. 内存未命中时，回退检查磁盘持久化文件
    // 这确保了即使内存缓存丢失（重启、TTL 过期等），已持久化的任务群仍能被识别
    const diskCache = this.loadDiskCacheIfNeeded();
    return diskCache.has(chatId);
  }

  /**
   * 获取所有任务群 chat_id
   */
  getAllTaskChatIds(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 使缓存失效
   */
  invalidateCache(chatId: string): void {
    this.cache.delete(chatId);
    this.saveToDisk();
  }

  /**
   * 强制刷新缓存
   */
  async refreshCache(chatId: string): Promise<Task | null> {
    this.cache.delete(chatId);
    return this.getTaskByChatId(chatId);
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { count: number; lastSync: number } {
    return {
      count: this.cache.size,
      lastSync: this.lastSync,
    };
  }
}

export const taskStore = new TaskStore();
