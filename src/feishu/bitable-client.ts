// src/feishu/bitable-client.ts
import { feishuClient } from './client.js';
import {
  PROJECT_FIELDS,
  TASK_FIELDS,
  TASK_STATUS_LABELS,
  BLOCKED_REASON_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_TOPIC_LABELS,
  type TaskStatus,
  type BlockedReason,
  type TaskTopic,
  type TaskPriority,
} from '../config/bitable-fields.js';
import type { Task, Project, CreateTaskInput, TaskFilter } from '../types/task.js';
import { ensureTaskTableViews } from './task-table-views.js';

interface BitableConfig {
  appToken: string;
  projectTableId: string;
  taskTableId: string;
}

class BitableClient {
  private config: BitableConfig | null = null;
  private tokenCache: { token: string; expiresAt: number } | null = null;

  /**
   * 直接用 fetch 获取 tenant_access_token（不依赖 SDK，Bootstrap 阶段安全可用）
   * 带重试逻辑处理网络波动
   */
  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }

    const appId = process.env.FEISHU_APP_ID ?? '';
    const appSecret = process.env.FEISHU_APP_SECRET ?? '';
    
    // 重试逻辑：最多 3 次
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8_000);
      
      try {
        const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        });
        const data = await resp.json() as { code: number; tenant_access_token: string; expire: number };
        if (data.code !== 0) throw new Error(`获取 token 失败：${data.code}`);
        this.tokenCache = { token: data.tenant_access_token, expiresAt: now + data.expire * 1000 };
        return data.tenant_access_token;
      } catch (error) {
        clearTimeout(timeoutId);
        if ((error as Error).name === 'AbortError') {
          console.error(`[Bitable] 获取 token 超时 (尝试 ${attempt}/${maxRetries})`);
        } else if ((error as Error).message.includes('ECONNRESET') || (error as Error).message.includes('network')) {
          console.warn(`[Bitable] 获取 token 网络错误 (尝试 ${attempt}/${maxRetries}):`, (error as Error).message);
        } else {
          throw error; // 非网络错误，直接抛出
        }
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500 * attempt)); // 指数退避
          continue;
        }
        
        throw new Error('获取 Bitable token 失败，已重试 3 次');
      }
    }
    
    throw new Error('获取 Bitable token 失败');
  }

  /**
   * 直接用 fetch 调用飞书 REST API（不依赖 SDK，Bootstrap 阶段安全可用）
   */
  private async apiFetch(path: string, opts: RequestInit = {}, retries = 1): Promise<Record<string, unknown>> {
    console.log(`[Bitable] API 调用开始: ${path}, retries=${retries}`);
    const token = await this.getToken();
    
    const fetchWithTimeout = () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      return fetch(`https://open.feishu.cn/open-apis${path}`, {
        ...opts,
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(opts.headers as Record<string, string> ?? {}),
        },
      })
        .then(async resp => { 
          clearTimeout(timeoutId); 
          console.log(`[Bitable] API 响应: ${path}, status=${resp.status}`);
          return resp; 
        })
        .catch(err => { clearTimeout(timeoutId); throw err; });
    };

    const timeoutPromise = new Promise<Response>((_, reject) => {
      setTimeout(() => reject(new Error('API 请求超时')), 12_000);
    });

    try {
      const resp = await Promise.race([fetchWithTimeout(), timeoutPromise]);
      if (!('json' in resp)) throw new Error('fetch 返回非 Response 对象');
      const result = await resp.json() as Record<string, unknown>;
      console.log(`[Bitable] API 结果: ${path}, code=${(result as Record<string, unknown>).code}`);
      return result;
    } catch (error) {
      const err = error as Error;
      if (err.name === 'AbortError' || err.message === 'API 请求超时') {
        console.error(`[Bitable] API 请求超时: ${path}`);
        if (retries > 0) {
          console.warn(`[Bitable] 重试请求 (${retries}): ${path}`);
          return this.apiFetch(path, opts, retries - 1);
        }
        return { code: -1, msg: 'timeout' };
      }
      console.error(`[Bitable] API 请求异常: ${path}`, err);
      throw err;
    }
  }

  configure(config: BitableConfig): void {
    this.config = config;
    const tokenPreview = config.appToken.length > 8 
      ? config.appToken.slice(0, 8) + '...' 
      : config.appToken;
    console.log(`[Bitable] 已配置多维表格: app=${tokenPreview}`);
  }

  getConfig(): BitableConfig | null {
    return this.config;
  }

  private ensureConfig(): BitableConfig {
    if (!this.config) {
      throw new Error('Bitable 未配置，请先调用 configure()');
    }
    return this.config;
  }

  // ===== Project 表操作 =====

  async createProject(name: string, repoUrl?: string): Promise<Project | null> {
    const config = this.ensureConfig();
    try {
      const now = Date.now();
      const fields: Record<string, unknown> = { 
        [PROJECT_FIELDS.name]: name,
        [PROJECT_FIELDS.created_at]: now,
        [PROJECT_FIELDS.updated_at]: now,
      };
      if (repoUrl) fields[PROJECT_FIELDS.repo_url] = { link: repoUrl, text: repoUrl };
      const result = await this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${config.projectTableId}/records?user_id_type=open_id`, {
        method: 'POST', body: JSON.stringify({ fields }),
      });
      if ((result.code as number) !== 0) { console.error(`[Bitable] 创建项目失败: ${result.msg}`); return null; }
      return this.parseProjectRecord((result.data as Record<string, unknown>)?.record as Record<string, unknown>);
    } catch (error) {
      console.error('[Bitable] 创建项目异常:', error);
      return null;
    }
  }

  async findProjectById(projectId: string): Promise<Project | null> {
    const config = this.ensureConfig();
    try {
      // project_id 就是飞书的 record_id，直接通过记录 API 获取
      const result = await this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${config.projectTableId}/records/${projectId}?user_id_type=open_id`, {
        method: 'GET',
      });
      if ((result.code as number) !== 0) {
        console.error(`[Bitable] 查找项目失败: ${result.msg}`);
        return null;
      }
      const record = (result.data as Record<string, unknown>)?.record as Record<string, unknown>;
      if (!record) return null;
      return this.parseProjectRecord(record);
    } catch (error) {
      console.error('[Bitable] 按 ID 查找项目异常:', error);
      return null;
    }
  }

  async findProjectByName(name: string): Promise<Project | null> {
    const config = this.ensureConfig();
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${config.projectTableId}/records/search?user_id_type=open_id`, {
        method: 'POST', body: JSON.stringify({ field_names: Object.values(PROJECT_FIELDS), filter: { conditions: [{ field_name: PROJECT_FIELDS.name, operator: 'is', value: [name] }], conjunction: 'and' }, automatic_fields: false }),
      });
      const items = ((result.data as Record<string, unknown>)?.items as unknown[]) ?? [];
      if ((result.code as number) !== 0 || !items.length) return null;
      return this.parseProjectRecord(items[0] as Record<string, unknown>);
    } catch (error) {
      console.error('[Bitable] 查找项目异常:', error);
      return null;
    }
  }

  async findOrCreateProject(name: string, repoUrl?: string): Promise<Project | null> {
    const existing = await this.findProjectByName(name);
    if (existing) return existing;
    return this.createProject(name, repoUrl);
  }

  private getProjectTaskTableName(projectName: string): string {
    return `${projectName}任务`;
  }

  private buildBitableTableUrl(appToken: string, tableId: string): string {
    return `https://feishu.cn/base/${appToken}?table=${tableId}`;
  }

  private parseUrlFieldLink(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const link = (value as Record<string, unknown>).link;
    if (typeof link !== 'string') {
      return null;
    }

    const normalized = link.trim();
    return normalized || null;
  }

  private isValidTableId(tableId: string | null): tableId is string {
    return typeof tableId === 'string' && /^tbl[a-zA-Z0-9]+$/.test(tableId);
  }

  private parseTaskTableId(value: string | null): string | null {
    if (!value) {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    try {
      const url = new URL(normalized);
      const tableId = url.searchParams.get('table')?.trim();
      if (tableId) {
        return tableId;
      }
    } catch {
      // 非 URL，按原始 table_id 处理
    }

    return this.isValidTableId(normalized) ? normalized : null;
  }

  private async persistProjectTaskTableId(projectId: string, taskTableId: string): Promise<boolean> {
    const config = this.ensureConfig();
    const taskTableLink = this.buildBitableTableUrl(config.appToken, taskTableId);
    const updateResult = await this.apiFetch(
      `/bitable/v1/apps/${config.appToken}/tables/${config.projectTableId}/records/${projectId}?user_id_type=open_id`,
        {
          method: 'PUT',
          body: JSON.stringify({
            fields: {
            [PROJECT_FIELDS.task_table_id]: { link: taskTableLink, text: '打开任务表' },
            [PROJECT_FIELDS.updated_at]: Date.now(),
          },
        }),
      }
    );

    if ((updateResult.code as number) !== 0) {
      console.error(`[Bitable] 更新项目任务表ID失败: ${updateResult.msg}`);
      return false;
    }

    console.log(`[Bitable] 项目任务表ID已持久化: ${taskTableId}`);
    return true;
  }

  private async findReusableProjectTaskTable(projectName: string): Promise<string | null> {
    const config = this.ensureConfig();
    const expectedTableName = this.getProjectTaskTableName(projectName);
    const tables = await this.listTables(config.appToken);
    const matchedTable = tables.find(table => table.name === expectedTableName);
    return matchedTable?.table_id ?? null;
  }

  /**
   * P2: 为项目创建专属任务表（惰性创建）
   * 创建成功后会更新项目记录的 task_table_id 字段
   */
  async createProjectTaskTable(projectId: string, projectName: string): Promise<string | null> {
    const config = this.ensureConfig();
    try {
      const existingTableId = await this.findReusableProjectTaskTable(projectName);
      if (existingTableId) {
        console.log(`[Bitable] 项目 "${projectName}" 复用已有任务表: ${existingTableId}`);
        const persisted = await this.persistProjectTaskTableId(projectId, existingTableId);
        return persisted ? existingTableId : null;
      }

      // 1. 创建任务表，使用项目名作为表名
      const tableName = this.getProjectTaskTableName(projectName);
      const taskTable = await this.createTable(config.appToken, tableName, [
        { field_name: TASK_FIELDS.title, type: 1 },
        {
          field_name: TASK_FIELDS.status, type: 3,
          property: { options: Object.values(TASK_STATUS_LABELS).map((name, i) => ({ name, color: i })) },
        },
        {
          field_name: TASK_FIELDS.priority, type: 3,
          property: { options: Object.values(TASK_PRIORITY_LABELS).map((name, i) => ({ name, color: i })) },
        },
        {
          field_name: TASK_FIELDS.blocked_reason, type: 3,
          property: { options: Object.values(BLOCKED_REASON_LABELS).map((name, i) => ({ name, color: i })) },
        },
      ]);

      if (!taskTable) {
        console.error(`[Bitable] 为项目 "${projectName}" 创建任务表失败`);
        return null;
      }

      const taskTableId = taskTable.table_id;
      console.log(`[Bitable] 项目 "${projectName}" 任务表已创建: ${taskTableId}`);

      // 2. 补充创建所有任务字段
      const existingFields = new Set(await this.listFields(config.appToken, taskTableId));
      const taskFieldDefs = this.getProjectTaskFieldDefinitions();

      for (const f of taskFieldDefs) {
        if (existingFields.has(f.field_name)) continue;
        await this.createField(config.appToken, taskTableId, f.field_name, f.type, f.property);
        await new Promise(r => setTimeout(r, 150)); // 避免QPS限制
      }

      await ensureTaskTableViews(this, config.appToken, taskTableId);

      // 4. 更新项目记录的 task_table_id（写回失败视为真实失败，但后续调用会优先复用已有表）
      const persisted = await this.persistProjectTaskTableId(projectId, taskTableId);
      if (!persisted) {
        // P2-A: task_table_id 写回失败是真实失败，返回 null 触发 fallback 到全局表
        // 但下次会优先复用已存在的同名项目表，避免重复创建孤儿表
        return null;
      }

      console.log(`[Bitable] 项目 "${projectName}" 任务表已完成绑定: ${taskTableId}`);
      return taskTableId;
    } catch (error) {
      console.error('[Bitable] 创建项目任务表异常:', error);
      return null;
    }
  }

  /**
   * P2-A: 获取或创建项目的专属任务表（带 fallback 语义）
   *
   * Fallback 语义：
   * 1. 项目已有 task_table_id → 返回该 ID（路由到项目专属表）
   * 2. 无 task_table_id 但已存在同名专属表 → 优先复用并尝试回填
   * 3. 无 task_table_id 且惰性创建成功 → 返回新表 ID（路由到项目专属表）
   * 4. 无 task_table_id 且专属表最终不可用 → 返回 null（fallback 到全局任务表）
   *
   * 注意：createProjectTaskTable 的写回失败仍被视为真实失败，会返回 null
   * 触发 fallback；但后续调用会先查找并复用同名表，避免重复创建孤儿表。
   */
  async getOrCreateProjectTaskTable(project: Project): Promise<string | null> {
    // 已有任务表ID，直接返回
    if (this.isValidTableId(project.task_table_id)) {
      return project.task_table_id;
    }

    if (project.task_table_id) {
      console.warn(`[Bitable] 项目 "${project.name}" 任务表标识无效，将尝试重新发现或回退: ${project.task_table_id}`);
    }

    const reusableTableId = await this.findReusableProjectTaskTable(project.name);
    if (reusableTableId) {
      console.log(`[Bitable] 项目 "${project.name}" 检测到可复用任务表: ${reusableTableId}`);
      const persisted = await this.persistProjectTaskTableId(project.project_id, reusableTableId);
      if (persisted) {
        return reusableTableId;
      }
      console.warn(`[Bitable] 项目 "${project.name}" 已找到可复用任务表，但写回失败，将 fallback 到全局表`);
      return null;
    }

    // 惰性创建
    console.log(`[Bitable] 项目 "${project.name}" 无专属任务表，开始惰性创建...`);
    const tableId = await this.createProjectTaskTable(project.project_id, project.name);

    if (tableId) {
      console.log(`[Bitable] 项目 "${project.name}" 专属任务表就绪: ${tableId}`);
    } else {
      console.warn(`[Bitable] 项目 "${project.name}" 专属任务表创建失败，将 fallback 到全局表`);
    }

    return tableId;
  }

  /**
   * P2: 获取所有项目列表（含任务表ID）
   */
  async listAllProjectsWithTaskTables(): Promise<Project[]> {
    const config = this.ensureConfig();
    try {
      const result = await this.apiFetch(
        `/bitable/v1/apps/${config.appToken}/tables/${config.projectTableId}/records/search?user_id_type=open_id`,
        {
          method: 'POST',
          body: JSON.stringify({
            field_names: Object.values(PROJECT_FIELDS),
            automatic_fields: true,
          }),
        }
      );
      const items = ((result.data as Record<string, unknown>)?.items as unknown[]) ?? [];
      if ((result.code as number) !== 0) return [];
      return items
        .map(item => this.parseProjectRecord(item as Record<string, unknown>))
        .filter((p): p is Project => p !== null);
    } catch (error) {
      console.error('[Bitable] 获取项目列表异常:', error);
      return [];
    }
  }

  /**
   * P2: 获取所有带有任务表的项目（用于跨表搜索）
   */
  async getProjectsWithTaskTables(): Promise<Array<{ projectId: string; projectName: string; taskTableId: string }>> {
    const projects = await this.listAllProjectsWithTaskTables();
    return projects
      .filter(p => p.task_table_id !== null)
      .map(p => ({
        projectId: p.project_id,
        projectName: p.name,
        taskTableId: p.task_table_id!,
      }));
  }

  /**
   * 项目任务表的字段定义（复用全局任务表结构）
   */
  private getProjectTaskFieldDefinitions(): Array<{ field_name: string; type: number; property?: Record<string, unknown> }> {
    // 与全局任务表保持一致的字段结构
    return [
      // A 组（status/priority/blocked_reason/title 已在建表时创建）
      { field_name: TASK_FIELDS.execution_agent, type: 1 },
      // B 组
      { field_name: TASK_FIELDS.chat_link, type: 15 },
      { field_name: TASK_FIELDS.description, type: 1 },
      { field_name: TASK_FIELDS.workspace_path, type: 1 },
      // C 组
      { field_name: TASK_FIELDS.started_at, type: 5 },
      { field_name: TASK_FIELDS.done_at, type: 5 },
      { field_name: TASK_FIELDS.created_at, type: 5 },
      { field_name: TASK_FIELDS.closed_at, type: 5 },
      { field_name: TASK_FIELDS.status_updated_at, type: 5 },
      { field_name: TASK_FIELDS.unblocked_at, type: 5 },
      { field_name: TASK_FIELDS.updated_at, type: 5 },
      // D 组
      { field_name: TASK_FIELDS.deliverable_summary, type: 1 },
      // E 组
      { field_name: TASK_FIELDS.task_id, type: 1 },
      { field_name: TASK_FIELDS.project_id, type: 1 },
      { field_name: TASK_FIELDS.chat_id, type: 1 },
      { field_name: TASK_FIELDS.opencode_session_id, type: 1 },
      { field_name: TASK_FIELDS.creator_open_id, type: 1 },
      { field_name: TASK_FIELDS.archived, type: 7 },
      { field_name: TASK_FIELDS.archived_at, type: 5 },
    ];
  }

  /**
   * 获取所有项目列表
   */
  async listAllProjects(): Promise<Project[]> {
    const config = this.ensureConfig();
    try {
      const result = await this.apiFetch(
        `/bitable/v1/apps/${config.appToken}/tables/${config.projectTableId}/records/search?user_id_type=open_id`,
        {
          method: 'POST',
          body: JSON.stringify({
            field_names: Object.values(PROJECT_FIELDS),
            automatic_fields: true,
          }),
        }
      );
      const items = ((result.data as Record<string, unknown>)?.items as unknown[]) ?? [];
      if ((result.code as number) !== 0) return [];
      return items
        .map(item => this.parseProjectRecord(item as Record<string, unknown>))
        .filter((p): p is Project => p !== null);
    } catch (error) {
      console.error('[Bitable] 获取项目列表异常:', error);
      return [];
    }
  }

  // ===== Task 表操作 =====

  /**
   * P2-A: 创建新任务，支持项目专属任务表路由（含明确 fallback 语义）
   *
   * 路由策略：
   * 1. 未指定项目 → 使用全局任务表（向后兼容）
   * 2. 指定项目且项目有 task_table_id → 路由到项目专属表
   * 3. 指定项目但无 task_table_id → 惰性创建，成功则路由到项目专属表
   * 4. 指定项目但惰性创建失败 → FALLBACK 到全局任务表（保证任务不丢失）
   *
   * Fallback 到全局表的场景：
   * - 项目创建任务表 API 调用失败
   * - 任务表字段创建失败
   * - 项目记录 task_table_id 写回失败（真实失败，不静默成功）
   */
  async createTask(input: CreateTaskInput, sessionId: string, chatId: string): Promise<Task | null> {
    const config = this.ensureConfig();

    let project: Project | null = null;
    let targetTableId: string = config.taskTableId; // 默认使用全局表（向后兼容 fallback）
    let routingReason = '未指定项目，使用全局表';

    // P2-A: 项目路由逻辑（带明确 fallback 语义）
    if (input.project_id || input.project_name) {
      if (input.project_id) {
        project = await this.findProjectById(input.project_id);
      }

      if (!project && input.project_name) {
        project = await this.findOrCreateProject(input.project_name);
      }

    if (project) {
      // 获取或创建项目专属任务表
      const projectTaskTableId = await this.getOrCreateProjectTaskTable(project);
        if (projectTaskTableId) {
          targetTableId = projectTaskTableId;
          routingReason = `项目 "${project.name}" 专属表`;
        } else {
          // P2-A: 明确 fallback 语义 - 惰性创建失败时使用全局表
          routingReason = `项目 "${project.name}" 专属表创建失败，fallback 到全局表`;
          console.warn(`[Bitable] ${routingReason}`);
        }
      } else {
        const requestedProjectRef = input.project_id ?? input.project_name;
        routingReason = `项目 "${requestedProjectRef}" 查找/创建失败，使用全局表`;
        console.warn(`[Bitable] ${routingReason}`);
      }
    }

    console.log(`[Bitable] 任务路由: ${routingReason} (表: ${targetTableId})`);

    // 飞书 Bitable 字段格式规则：
    // - 日期字段：毫秒级时间戳数字（不是 ISO 字符串）
    // - 人员字段：[{id: "open_id"}] 数组
    // - URL 字段：{link: "url", text: "显示文字"} 对象
    // - 单选字段：直接写选项文本字符串
    const nowMs = Date.now();
    // 飞书 AppLink 打开群聊的正确参数是 openChatId（官方文档确认）
    const chatLink = `https://applink.feishu.cn/client/chat/open?openChatId=${chatId}`;

    // P2-A: execution_agent 优先级：显式传入 > 项目配置 > 'default'
    const executionAgent = input.execution_agent
      ?? project?.default_execution_agent
      ?? 'default';

    const fields: Record<string, unknown> = {
      [TASK_FIELDS.title]: input.title,
      [TASK_FIELDS.status]: TASK_STATUS_LABELS.TODO,
      [TASK_FIELDS.priority]: TASK_PRIORITY_LABELS.medium,
      [TASK_FIELDS.execution_agent]: executionAgent,
      [TASK_FIELDS.chat_link]: { link: chatLink, text: '打开群聊' },  // URL 字段
      [TASK_FIELDS.workspace_path]: input.workspace_path,
      [TASK_FIELDS.created_at]: nowMs,           // 毫秒时间戳
      [TASK_FIELDS.status_updated_at]: nowMs,    // 毫秒时间戳
      [TASK_FIELDS.updated_at]: nowMs,           // 毫秒时间戳
      [TASK_FIELDS.chat_id]: chatId,
      [TASK_FIELDS.opencode_session_id]: sessionId,
      [TASK_FIELDS.creator_open_id]: input.creator_open_id,
      [TASK_FIELDS.archived]: false,
    };

    if (input.description) {
      fields[TASK_FIELDS.description] = input.description;
    }
    if (project) {
      fields[TASK_FIELDS.project_id] = project.project_id;
    }

    try {
      const createRecord = (tableId: string) => this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${tableId}/records?user_id_type=open_id`, {
        method: 'POST', body: JSON.stringify({ fields }),
      });

      let result = await createRecord(targetTableId);
      if ((result.code as number) !== 0) {
        console.error(`[Bitable] 创建任务失败: code=${result.code}, msg=${result.msg}`);

        if (targetTableId !== config.taskTableId) {
          console.warn(`[Bitable] 项目专属表写入失败，fallback 到全局表重试: ${targetTableId}`);
          targetTableId = config.taskTableId;
          routingReason = `项目表写入失败，fallback 到全局表`;
          console.warn(`[Bitable] ${routingReason}`);
          result = await createRecord(targetTableId);
        }

        if ((result.code as number) !== 0) {
          console.error(`[Bitable] fallback 后创建任务仍失败: code=${result.code}, msg=${result.msg}`);
          return null;
        }
      }

      console.log(`[Bitable] 创建任务成功: ${input.title} (表: ${targetTableId})`);
      return this.parseTaskRecord((result.data as Record<string, unknown>)?.record as Record<string, unknown>);
    } catch (error) {
      console.error('[Bitable] 创建任务异常:', JSON.stringify(error, null, 2));
      return null;
    }
  }

  /**
   * P2: 在指定表中查找任务
   */
  async findTaskByChatIdInTable(tableId: string, chatId: string): Promise<Task | null> {
    const config = this.ensureConfig();
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${tableId}/records/search?user_id_type=open_id`, {
        method: 'POST', body: JSON.stringify({ field_names: Object.values(TASK_FIELDS), filter: { conditions: [{ field_name: TASK_FIELDS.chat_id, operator: 'is', value: [chatId] }], conjunction: 'and' }, automatic_fields: false }),
      });
      const items = ((result.data as Record<string, unknown>)?.items as unknown[]) ?? [];
      if ((result.code as number) !== 0 || !items.length) return null;
      return this.parseTaskRecord(items[0] as Record<string, unknown>);
    } catch (error) {
      console.error(`[Bitable] 在表 ${tableId} 查找任务异常:`, error);
      return null;
    }
  }

  /**
   * P2: 在指定表中按session查找任务
   */
  async findTaskBySessionIdInTable(tableId: string, sessionId: string): Promise<Task | null> {
    const config = this.ensureConfig();
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${tableId}/records/search?user_id_type=open_id`, {
        method: 'POST', body: JSON.stringify({ field_names: Object.values(TASK_FIELDS), filter: { conditions: [{ field_name: TASK_FIELDS.opencode_session_id, operator: 'is', value: [sessionId] }], conjunction: 'and' }, automatic_fields: false }),
      });
      const items = ((result.data as Record<string, unknown>)?.items as unknown[]) ?? [];
      if ((result.code as number) !== 0 || !items.length) {
        return null;
      }

      return this.parseTaskRecord(items[0] as Record<string, unknown>);
    } catch (error) {
      console.error(`[Bitable] 在表 ${tableId} 按session查找任务异常:`, error);
      return null;
    }
  }

  async findTaskBySessionId(sessionId: string): Promise<Task | null> {
    const config = this.ensureConfig();

    // P2: 先搜索全局表（向后兼容）
    const globalResult = await this.findTaskBySessionIdInTable(config.taskTableId, sessionId);
    if (globalResult) return globalResult;

    // P2: 再搜索所有项目专属任务表
    const projects = await this.getProjectsWithTaskTables();
    for (const project of projects) {
      const task = await this.findTaskBySessionIdInTable(project.taskTableId, sessionId);
      if (task) {
        console.log(`[Bitable] 在项目 "${project.projectName}" 表中找到任务`);
        return task;
      }
    }

    return null;
  }

  /**
   * P2: 跨表查找任务（按chatId）
   * 优先搜索全局表，再搜索所有项目专属任务表
   */
  async findTaskByChatId(chatId: string): Promise<Task | null> {
    const config = this.ensureConfig();

    // P2: 先搜索全局表（向后兼容）
    const globalResult = await this.findTaskByChatIdInTable(config.taskTableId, chatId);
    if (globalResult) return globalResult;

    // P2: 再搜索所有项目专属任务表
    const projects = await this.getProjectsWithTaskTables();
    for (const project of projects) {
      const task = await this.findTaskByChatIdInTable(project.taskTableId, chatId);
      if (task) {
        console.log(`[Bitable] 在项目 "${project.projectName}" 表中找到任务`);
        return task;
      }
    }

    return null;
  }

  async updateTaskStatus(recordId: string, status: TaskStatus, extraFields: Record<string, unknown> = {}): Promise<boolean> {
    const config = this.ensureConfig();
    const nowMs = Date.now();

    // P2: 查找任务所在的表
    const location = await this.findTaskTableForUpdate(recordId);
    const targetTableId = location?.tableId ?? config.taskTableId;

    // 针对 1254045 乐观锁冲突的重试逻辑
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 将英文字段名映射为中文字段名
        const mappedExtraFields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(extraFields)) {
          const chineseFieldName = TASK_FIELDS[key as keyof typeof TASK_FIELDS];
          if (chineseFieldName) {
            mappedExtraFields[chineseFieldName] = value;
          } else {
            // 如果 TASK_FIELDS 中没有，直接使用原值（兼容直接传中文名的情况）
            mappedExtraFields[key] = value;
          }
        }

        const result = await this.apiFetch(
          `/bitable/v1/apps/${config.appToken}/tables/${targetTableId}/records/${recordId}?user_id_type=open_id`,
          { method: 'PUT', body: JSON.stringify({ fields: { [TASK_FIELDS.status]: TASK_STATUS_LABELS[status], [TASK_FIELDS.status_updated_at]: nowMs, [TASK_FIELDS.updated_at]: nowMs, ...mappedExtraFields } }) }
        );
        
        if ((result.code as number) !== 0) {
          // 1254045 = 乐观锁冲突，需要重试
          if ((result.code as number) === 1254045) {
            if (attempt < maxRetries) {
              console.warn(`[Bitable] 更新任务状态遇到乐观锁冲突 (1254045)，重试 (${attempt}/${maxRetries}): ${recordId}`);
              await new Promise(resolve => setTimeout(resolve, 300 * attempt)); // 指数退避
              continue;
            }
            console.error(`[Bitable] 更新任务状态失败：乐观锁冲突，重试 ${maxRetries} 次后仍失败`);
            return false;
          }
          console.error(`[Bitable] 更新任务状态失败：${result.msg}`);
          return false;
        }
        
        console.log(`[Bitable] 更新任务状态：${recordId} -> ${status}`);
        return true;
      } catch (error) {
        console.error('[Bitable] 更新任务状态异常:', error);
        return false;
      }
    }
    
    return false;
  }

  /**
   * P2: 查找任务所在的表（用于更新时确定目标表）
   * 返回 { tableId, task } 或 null
   */
  async findTaskTableForUpdate(recordId: string): Promise<{ tableId: string; task: Task } | null> {
    const config = this.ensureConfig();

    // 1. 先检查全局表
    try {
      const result = await this.apiFetch(
        `/bitable/v1/apps/${config.appToken}/tables/${config.taskTableId}/records/${recordId}?user_id_type=open_id`,
        { method: 'GET' }
      );
      if ((result.code as number) === 0) {
        const record = (result.data as Record<string, unknown>)?.record as Record<string, unknown>;
        if (record) {
          const task = this.parseTaskRecord(record);
          if (task) return { tableId: config.taskTableId, task };
        }
      }
    } catch {
      // 全局表未找到，继续搜索项目表
    }

    // 2. 搜索所有项目专属任务表
    const projects = await this.getProjectsWithTaskTables();
    for (const project of projects) {
      try {
        const result = await this.apiFetch(
          `/bitable/v1/apps/${config.appToken}/tables/${project.taskTableId}/records/${recordId}?user_id_type=open_id`,
          { method: 'GET' }
        );
        if ((result.code as number) === 0) {
          const record = (result.data as Record<string, unknown>)?.record as Record<string, unknown>;
          if (record) {
            const task = this.parseTaskRecord(record);
            if (task) return { tableId: project.taskTableId, task };
          }
        }
      } catch {
        // 当前项目表未找到，继续下一个
      }
    }

    return null;
  }

  async updateTaskFields(
    recordId: string,
    fields: Partial<Record<keyof typeof TASK_FIELDS, string | number | boolean | null>>
  ): Promise<boolean> {
    const config = this.ensureConfig();

    // P2: 查找任务所在的表
    const location = await this.findTaskTableForUpdate(recordId);
    const targetTableId = location?.tableId ?? config.taskTableId;

    // 将英文字段名（keyof TASK_FIELDS）映射为飞书中文字段名（TASK_FIELDS[key]）
    const filteredFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== null && value !== undefined) {
        const chineseFieldName = TASK_FIELDS[key as keyof typeof TASK_FIELDS];
        if (chineseFieldName) {
          filteredFields[chineseFieldName] = value;
        }
      }
    }
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${targetTableId}/records/${recordId}?user_id_type=open_id`, {
        method: 'PUT', body: JSON.stringify({ fields: { ...filteredFields, [TASK_FIELDS.updated_at]: Date.now() } }),
      });
      return (result.code as number) === 0;
    } catch (error) {
      console.error('[Bitable] 更新任务字段异常:', error);
      return false;
    }
  }

  async setBlocked(recordId: string, reason: BlockedReason): Promise<boolean> {
    const config = this.ensureConfig();
    const nowMs = Date.now();

    // P2: 查找任务所在的表
    const location = await this.findTaskTableForUpdate(recordId);
    const targetTableId = location?.tableId ?? config.taskTableId;

    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${targetTableId}/records/${recordId}?user_id_type=open_id`, {
        method: 'PUT', body: JSON.stringify({ fields: { [TASK_FIELDS.status]: TASK_STATUS_LABELS.BLOCKED, [TASK_FIELDS.blocked_reason]: BLOCKED_REASON_LABELS[reason], [TASK_FIELDS.status_updated_at]: nowMs, [TASK_FIELDS.updated_at]: nowMs } }),
      });
      if ((result.code as number) === 0) console.log(`[Bitable] 设置任务阻塞: ${recordId} -> ${reason}`);
      return (result.code as number) === 0;
    } catch (error) {
      console.error('[Bitable] 设置任务阻塞异常:', error);
      return false;
    }
  }

  async clearBlocked(recordId: string): Promise<boolean> {
    const config = this.ensureConfig();
    const nowMs = Date.now();

    // P2: 查找任务所在的表
    const location = await this.findTaskTableForUpdate(recordId);
    const targetTableId = location?.tableId ?? config.taskTableId;

    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${targetTableId}/records/${recordId}?user_id_type=open_id`, {
        method: 'PUT', body: JSON.stringify({ fields: { [TASK_FIELDS.status]: TASK_STATUS_LABELS.IN_PROGRESS, [TASK_FIELDS.unblocked_at]: nowMs, [TASK_FIELDS.status_updated_at]: nowMs, [TASK_FIELDS.updated_at]: nowMs } }),
      });
      if ((result.code as number) === 0) console.log(`[Bitable] 清除任务阻塞: ${recordId}`);
      return (result.code as number) === 0;
    } catch (error) {
      console.error('[Bitable] 清除任务阻塞异常:', error);
      return false;
    }
  }

  async listTasksFromTable(tableId: string, filter?: TaskFilter): Promise<Task[]> {
    const config = this.ensureConfig();
    const conditions: Array<{ field_name: string; operator: string; value: string[] }> = [];
    if (filter?.archived !== undefined) {
      conditions.push({ field_name: TASK_FIELDS.archived, operator: 'is', value: [String(filter.archived)] });
    }
    if (filter?.project_id) {
      conditions.push({ field_name: TASK_FIELDS.project_id, operator: 'is', value: [filter.project_id] });
    }
    if (filter?.creator_open_id) {
      conditions.push({ field_name: TASK_FIELDS.creator_open_id, operator: 'is', value: [filter.creator_open_id] });
    }
    const searchData: Record<string, unknown> = { field_names: Object.values(TASK_FIELDS), automatic_fields: false };
    if (conditions.length > 0) searchData.filter = { conditions, conjunction: 'and' };
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${config.appToken}/tables/${tableId}/records/search?user_id_type=open_id`, {
        method: 'POST', body: JSON.stringify(searchData),
      });
      const items = ((result.data as Record<string, unknown>)?.items as unknown[]) ?? [];
      if ((result.code as number) !== 0) return [];
      return items.map(item => this.parseTaskRecord(item as Record<string, unknown>)).filter((t): t is Task => t !== null);
    } catch (error) {
      console.error(`[Bitable] 从表 ${tableId} 列出任务异常:`, error);
      return [];
    }
  }

  /**
   * P2: 列出所有任务（跨全局表和项目专属表）
   */
  async listTasks(filter?: TaskFilter): Promise<Task[]> {
    const config = this.ensureConfig();
    const allTasks: Task[] = [];

    // 1. 从全局表获取任务
    const globalTasks = await this.listTasksFromTable(config.taskTableId, filter);
    allTasks.push(...globalTasks);

    // 2. 从所有项目专属任务表获取任务
    const projects = await this.getProjectsWithTaskTables();
    for (const project of projects) {
      const projectTasks = await this.listTasksFromTable(project.taskTableId, filter);
      allTasks.push(...projectTasks);
    }

    return allTasks;
  }

  // ===== 解析方法 =====

  private parseProjectRecord(record: { record_id?: string; fields?: Record<string, unknown> } | undefined): Project | null {
    if (!record || !record.record_id || !record.fields) return null;
    const f = record.fields;
    // 解析 repo_url：飞书返回 {link: string, text: string} 对象格式
    let repoUrl: string | null = null;
    const repoUrlField = f[PROJECT_FIELDS.repo_url];
    if (repoUrlField) {
      if (typeof repoUrlField === 'object' && repoUrlField !== null && 'link' in repoUrlField) {
        repoUrl = String((repoUrlField as Record<string, unknown>).link ?? '');
      } else {
        repoUrl = String(repoUrlField);
      }
    }

     // P2: 项目表中持久化的是任务表链接，这里优先从 URL link 解析回内部 table_id
     const taskTableField = f[PROJECT_FIELDS.task_table_id];
     const taskTableLink = this.parseUrlFieldLink(taskTableField);
     const taskTableRaw = taskTableLink ?? this.parseNullableTextField(taskTableField);
     const taskTableId = this.parseTaskTableId(taskTableRaw);

    // P2: 解析默认执行Agent
    const defaultExecutionAgent = this.parseNullableTextField(f[PROJECT_FIELDS.default_execution_agent]);

    // P2: 解析工作目录配置（JSON数组字符串）
    let workspacePaths: string[] | null = null;
    const workspacePathsField = f[PROJECT_FIELDS.workspace_paths];
    if (workspacePathsField) {
      const pathsText = this.parseNullableTextField(workspacePathsField);
      if (pathsText) {
        try {
          const parsed = JSON.parse(pathsText) as unknown;
          if (Array.isArray(parsed)) {
            workspacePaths = parsed.filter((item): item is string => typeof item === 'string');
          }
        } catch {
          // JSON解析失败，忽略
        }
      }
    }

    return {
      project_id: record.record_id,
      name: this.parseTextField(f[PROJECT_FIELDS.name]),
      repo_url: repoUrl,
      task_table_id: taskTableId,
      default_execution_agent: defaultExecutionAgent,
      workspace_paths: workspacePaths,
      created_at: this.parseDate(f[PROJECT_FIELDS.created_at]),
      updated_at: this.parseDate(f[PROJECT_FIELDS.updated_at]),
    };
  }

  /**
   * 飞书文本字段返回富文本数组 [{text: '...', type: 'text'}]，提取纯文本
   */
  private parseTextField(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((v: Record<string, unknown>) => v.text ?? '').join('');
    return String(value);
  }

  private parseNullableTextField(value: unknown): string | null {
    if (!value) return null;
    const text = this.parseTextField(value);
    return text || null;
  }

  private parseTaskRecord(record: { record_id?: string; fields?: Record<string, unknown> } | undefined): Task | null {
    if (!record || !record.record_id || !record.fields) return null;
    const f = record.fields;
    
    return {
      task_id: record.record_id,
      title: this.parseTextField(f[TASK_FIELDS.title]),
      status: this.parseStatus(f[TASK_FIELDS.status]),
      priority: this.parsePriority(f[TASK_FIELDS.priority]),
      blocked_reason: this.parseBlockedReason(f[TASK_FIELDS.blocked_reason]),
      execution_agent: this.parseTextField(f[TASK_FIELDS.execution_agent]),
      
      chat_link: this.parseTextField(f[TASK_FIELDS.chat_link]),
      description: this.parseNullableTextField(f[TASK_FIELDS.description]),
      workspace_path: this.parseTextField(f[TASK_FIELDS.workspace_path]),
      
      started_at: this.parseNullableDate(f[TASK_FIELDS.started_at]),
      done_at: this.parseNullableDate(f[TASK_FIELDS.done_at]),
      created_at: this.parseDate(f[TASK_FIELDS.created_at]),
      closed_at: this.parseNullableDate(f[TASK_FIELDS.closed_at]),
      status_updated_at: this.parseDate(f[TASK_FIELDS.status_updated_at]),
      unblocked_at: this.parseNullableDate(f[TASK_FIELDS.unblocked_at]),
      updated_at: this.parseDate(f[TASK_FIELDS.updated_at]),
      
      deliverable_summary: this.parseNullableTextField(f[TASK_FIELDS.deliverable_summary]),
      
      project_id: this.parseNullableTextField(f[TASK_FIELDS.project_id]),
      chat_id: this.parseTextField(f[TASK_FIELDS.chat_id]),
      opencode_session_id: this.parseTextField(f[TASK_FIELDS.opencode_session_id]),
      creator_open_id: this.parseTextField(f[TASK_FIELDS.creator_open_id]),
      archived: Boolean(f[TASK_FIELDS.archived]),
      archived_at: this.parseNullableDate(f[TASK_FIELDS.archived_at]),
    } as Task;
  }

  private parseDate(value: unknown): Date {
    if (!value) return new Date();
    if (typeof value === 'number') return new Date(value);
    if (typeof value === 'string') return new Date(value);
    return new Date();
  }

  private parseNullableDate(value: unknown): Date | null {
    if (!value) return null;
    if (typeof value === 'number') return new Date(value);
    if (typeof value === 'string') return new Date(value);
    return null;
  }

  private parseNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  private parseStatus(value: unknown): TaskStatus {
    if (!value || typeof value !== 'string') return 'TODO';
    const label = value.trim();
    for (const [key, val] of Object.entries(TASK_STATUS_LABELS)) {
      if (val === label) return key as TaskStatus;
    }
    return 'TODO';
  }

  private parsePriority(value: unknown): TaskPriority {
    if (!value || typeof value !== 'string') return 'medium';
    const label = value.trim();
    for (const [key, val] of Object.entries(TASK_PRIORITY_LABELS)) {
      if (val === label) return key as TaskPriority;
    }
    return 'medium';
  }

  private parseBlockedReason(value: unknown): BlockedReason | null {
    if (!value || typeof value !== 'string') return null;
    const label = value.trim();
    for (const [key, val] of Object.entries(BLOCKED_REASON_LABELS)) {
      if (val === label) return key as BlockedReason;
    }
    return null;
  }

  private parseTopic(value: unknown): TaskTopic | null {
    if (!value || typeof value !== 'string') return null;
    const label = value.trim();
    for (const [key, val] of Object.entries(TASK_TOPIC_LABELS)) {
      if (val === label) return key as TaskTopic;
    }
    return null;
  }

  // ===== Bootstrap 专用 API =====

  /**
   * 创建多维表格应用（直接 fetch，Bootstrap 阶段安全可用）
   */
  async createBitableApp(name: string): Promise<{ app_token: string; url: string } | null> {
    try {
      // folder_token 必须显式传空字符串才能创建在根目录，不传时飞书返回 1255002
      const result = await this.apiFetch('/bitable/v1/apps', {
        method: 'POST',
        body: JSON.stringify({ name, folder_token: '' }),
      });
      if ((result.code as number) !== 0) {
        console.error(`[Bitable] 创建多维表格失败: code=${result.code}, msg=${result.msg}`);
        return null;
      }
      const app = (result.data as Record<string, unknown>)?.app as Record<string, unknown>;
      if (!app?.app_token) { console.error('[Bitable] 创建多维表格返回空 app_token'); return null; }
      return { app_token: app.app_token as string, url: `https://feishu.cn/base/${app.app_token}` };
    } catch (error: unknown) {
      console.error('[Bitable] 创建多维表格异常:', JSON.stringify(error, null, 2));
      return null;
    }
  }

  /**
   * 创建数据表（直接 fetch，Bootstrap 阶段安全可用）
   */
  async createTable(
    appToken: string,
    tableName: string,
    fields?: Array<{ field_name: string; type: number; property?: Record<string, unknown> }>
  ): Promise<{ table_id: string } | null> {
    try {
      const tableBody: Record<string, unknown> = { name: tableName };
      if (fields && fields.length > 0) tableBody.fields = fields;
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables`, {
        method: 'POST',
        body: JSON.stringify({ table: tableBody }),
      });
      if ((result.code as number) !== 0) {
        console.error('[Bitable] 创建数据表失败:', result.msg);
        return null;
      }
      const tableId = (result.data as Record<string, unknown>)?.table_id as string;
      if (!tableId) { console.error('[Bitable] 创建数据表返回空 table_id'); return null; }
      return { table_id: tableId };
    } catch (error) {
      console.error('[Bitable] 创建数据表异常:', error);
      return null;
    }
  }

  /**
   * 重命名字段（直接 fetch，Bootstrap 阶段安全可用）
   */
  async renameField(
    appToken: string,
    tableId: string,
    fieldId: string,
    newName: string,
    fieldType: number,
  ): Promise<boolean> {
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`, {
        method: 'PUT',
        body: JSON.stringify({ field_name: newName, type: fieldType }),
      });
      if ((result.code as number) !== 0) {
        console.error(`[Bitable] 重命名字段失败: ${result.msg}`);
        return false;
      }
      return true;
    } catch (error) {
      console.error('[Bitable] 重命名字段异常:', error);
      return false;
    }
  }

  /**
   * 创建字段（直接 fetch，Bootstrap 阶段安全可用）
   */
  async createField(
    appToken: string,
    tableId: string,
    fieldName: string,
    fieldType: number,
    property?: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const body: Record<string, unknown> = { field_name: fieldName, type: fieldType };
      if (property) body.property = property;
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if ((result.code as number) !== 0) {
        console.error(`[Bitable] 创建字段 "${fieldName}" 失败:`, result.msg);
        return false;
      }
      return true;
    } catch (error) {
      console.error(`[Bitable] 创建字段 "${fieldName}" 异常:`, error);
      return false;
    }
  }

  /**
   * 列出数据表中的所有字段名（直接 fetch，Bootstrap 阶段安全可用）
   */
  async listFields(appToken: string, tableId: string): Promise<string[]> {
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
      const items = (result.data as Record<string, unknown>)?.items as Array<{ field_name?: string }> ?? [];
      return items.map(f => f.field_name).filter((name): name is string => !!name);
    } catch (error) {
      console.error('[Bitable] 列出字段异常:', error);
      return [];
    }
  }

  /**
   * 列出多维表格中的所有数据表（直接 fetch）
   */
  async listTables(appToken: string): Promise<Array<{ table_id: string; name: string }>> {
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables`);
      const items = (result.data as Record<string, unknown>)?.items as Array<{ table_id?: string; name?: string }> ?? [];
      return items.filter(t => t.table_id && t.name).map(t => ({ table_id: t.table_id!, name: t.name! }));
    } catch (error) {
      console.error('[Bitable] 列出数据表异常:', error);
      return [];
    }
  }

  /**
   * 删除数据表（直接 fetch）
   */
  async deleteTable(appToken: string, tableId: string): Promise<boolean> {
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}`, { method: 'DELETE' });
      return (result.code as number) === 0;
    } catch (error) {
      console.error('[Bitable] 删除数据表异常:', error);
      return false;
    }
  }

  /**
   * 创建数据表视图（直接 fetch）
   */
  async createView(
    appToken: string,
    tableId: string,
    viewName: string,
    viewType: 'grid' | 'kanban' | 'gallery' | 'gantt',
  ): Promise<{ view_id: string } | null> {
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/views`, {
        method: 'POST',
        body: JSON.stringify({ view_name: viewName, view_type: viewType }),
      });
      if ((result.code as number) !== 0) {
        console.error(`[Bitable] 创建视图 "${viewName}" 失败:`, result.msg);
        return null;
      }
      const viewId = ((result.data as Record<string, unknown>)?.view as Record<string, unknown>)?.view_id as string;
      if (!viewId) { console.error('[Bitable] 创建视图返回空 view_id'); return null; }
      return { view_id: viewId };
    } catch (error) {
      console.error(`[Bitable] 创建视图 "${viewName}" 异常:`, error);
      return null;
    }
  }

  /**
   * 获取数据表中已有的视图列表（直接 fetch）
   */
  async listViews(appToken: string, tableId: string): Promise<Array<{ view_id: string; view_name: string; view_type: string }>> {
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/views`);
      const items = (result.data as Record<string, unknown>)?.items as Array<{ view_id?: string; view_name?: string; view_type?: string }> ?? [];
      return items.filter(v => v.view_id && v.view_name).map(v => ({ view_id: v.view_id!, view_name: v.view_name!, view_type: v.view_type ?? '' }));
    } catch (error) {
      console.error('[Bitable] 列出视图异常:', error);
      return [];
    }
  }

  /**
   * 获取字段列表（含 field_id，直接 fetch）
   */
  async listFieldsWithId(appToken: string, tableId: string): Promise<Array<{ field_id: string; field_name: string }>> {
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
      const items = (result.data as Record<string, unknown>)?.items as Array<{ field_id?: string; field_name?: string }> ?? [];
      return items.filter(f => f.field_id && f.field_name).map(f => ({ field_id: f.field_id!, field_name: f.field_name! }));
    } catch (error) {
      console.error('[Bitable] 列出字段（含ID）异常:', error);
      return [];
    }
  }

  /**
   * 设置看板视图的分组字段
   * 经实测：PATCH 视图时传 property.group_fields 即可
   */
  /**
   * 设置视图的隐藏字段（直接 fetch）
   */
  async setViewHiddenFields(
    appToken: string,
    tableId: string,
    viewId: string,
    hiddenFieldIds: string[],
  ): Promise<boolean> {
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/views/${viewId}`, {
        method: 'PATCH',
        body: JSON.stringify({ property: { hidden_fields: hiddenFieldIds } }),
      });
      if ((result.code as number) !== 0) {
        console.warn(`[Bitable] 设置视图隐藏字段失败:`, result.msg);
        return false;
      }
      return true;
    } catch (error) {
      console.warn('[Bitable] 设置视图隐藏字段异常:', error);
      return false;
    }
  }

  async setKanbanGroupField(
    appToken: string,
    tableId: string,
    viewId: string,
    groupFieldId: string,
  ): Promise<boolean> {
    try {
      const result = await this.apiFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/views/${viewId}`, {
        method: 'PATCH',
        body: JSON.stringify({ view_name: '状态看板', property: { group_fields: [{ field_id: groupFieldId }] } }),
      });
      if ((result.code as number) !== 0) {
        console.warn(`[Bitable] 设置看板分组字段失败:`, result.msg);
        return false;
      }
      return true;
    } catch (error) {
      console.warn('[Bitable] 设置看板分组字段异常:', error);
      return false;
    }
  }

  /**
   * 授予用户多维表格编辑权限（直接 fetch）
   */
  async grantBitablePermission(appToken: string, openId: string): Promise<boolean> {
    try {
      const result = await this.apiFetch(`/drive/v1/permissions/${appToken}/members?type=bitable&need_notification=false`, {
        method: 'POST',
        body: JSON.stringify({ member_type: 'openid', member_id: openId, perm: 'edit', type: 'user' }),
      });
      if ((result.code as number) !== 0) {
        console.warn(`[Bitable] 授权用户 ${openId} 失败: ${result.msg}`);
        return false;
      }
      return true;
    } catch (error) {
      console.warn(`[Bitable] 授权用户 ${openId} 异常:`, error);
      return false;
    }
  }
}

export const bitableClient = new BitableClient();
