// src/feishu/bitable-bootstrap.ts
// Bitable 自动 Bootstrap 流程：首次启动自动创建多维表格

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { bitableClient } from './bitable-client.js';
import {
  BITABLE_SCHEMA_VERSION,
  TASK_FIELDS,
  PROJECT_FIELDS,
  TASK_STATUS_LABELS,
  TASK_PRIORITY_LABELS,
  BLOCKED_REASON_LABELS,
  TASK_TOPIC_LABELS,
} from '../config/bitable-fields.js';
import { ensureTaskTableViews } from './task-table-views.js';

// ===== 状态机类型 =====

export type BootstrapPhase =
  | 'IDLE'
  | 'CHECKING'
  | 'CREATING_APP'
  | 'CREATING_TABLES'
  | 'CREATING_FIELDS'
  | 'CREATING_VIEWS'
  | 'GRANTING_PERMS'
  | 'DONE'
  | 'FAILED';

export interface BitableState {
  // 实例标识（用于验证状态文件归属）
  feishu_app_id: string;
  instance_id: string;
  // 表格标识
  app_token: string;
  task_table_id: string;
  project_table_id: string;
  config_table_id?: string;  // __BridgeConfig 表的 table_id
  // Bootstrap 状态机
  phase: BootstrapPhase;
  created_fields: string[];  // CREATING_FIELDS 阶段的 checkpoint
  // 已授权用户缓存
  granted_users: string[];
  // 元信息
  schema_version: string;
  created_at?: string;  // Bootstrap 首次创建时记录；env var 路径不存在
  updated_at: string;
}

export interface BitableConfig {
  appToken: string;
  taskTableId: string;
  projectTableId: string;
}

// ===== 常量 =====
// 使用模块文件路径定位项目根目录，避免 cwd 在不同启动方式下不一致
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const STATE_FILE = path.join(PROJECT_ROOT, '.bitable-state.json');

// ===== BitableBootstrap 类 =====
export class BitableBootstrap {
  private state: Partial<BitableState> = {};

  constructor(
    private readonly feishuAppId: string,
    private readonly instanceId: string,
  ) {}

  // Task 2: 三层优先级查找链
  async initialize(): Promise<BitableConfig | null> {
    console.log('[Bootstrap] 开始初始化多维表格...');

    // === 优先级 1：env var ===
    const envConfig = this.loadFromEnv();
    if (envConfig) {
      console.log('[Bootstrap] 使用环境变量配置');
      return envConfig;
    }

    // === 优先级 2：本地 state 文件 ===
    const fileState = this.loadState();
    if (fileState) {
      // 验证状态文件归属（feishu_app_id + instance_id 双校验）
      const appIdMismatch = fileState.feishu_app_id && fileState.feishu_app_id !== this.feishuAppId;
      const instanceIdMismatch = fileState.instance_id && fileState.instance_id !== this.instanceId;
      if (appIdMismatch || instanceIdMismatch) {
        console.warn(`[Bootstrap] 状态文件归属不匹配，忽略:`);
        console.warn(`  文件: app=${fileState.feishu_app_id}, instance=${fileState.instance_id}`);
        console.warn(`  当前: app=${this.feishuAppId}, instance=${this.instanceId}`);
        // 归属不对，视为首次启动，走全新 Bootstrap
      } else if (fileState.phase === 'DONE' && fileState.app_token && fileState.task_table_id && fileState.project_table_id) {
        console.log('[Bootstrap] 使用本地缓存配置');
        this.state = fileState;
        return {
          appToken: fileState.app_token,
          taskTableId: fileState.task_table_id,
          projectTableId: fileState.project_table_id,
        };
      } else if (fileState.phase && fileState.phase !== 'IDLE' && fileState.phase !== 'DONE') {
        // === 中断恢复（归属已验证）===
        console.log(`[Bootstrap] 检测到未完成的 Bootstrap（${fileState.phase}），继续执行...`);
        this.state = fileState;
        return this.runBootstrap(true);
      }
    }

    // === 优先级 3：全新 Bootstrap ===
    console.log('[Bootstrap] 未找到已有配置，开始全新初始化...');
    return this.runBootstrap(false);
  }

  private loadFromEnv(): BitableConfig | null {
    const appToken = process.env.BITABLE_APP_TOKEN?.trim();
    const taskTableId = process.env.BITABLE_TASK_TABLE_ID?.trim();
    const projectTableId = process.env.BITABLE_PROJECT_TABLE_ID?.trim();
    if (appToken && taskTableId && projectTableId) {
      return { appToken, taskTableId, projectTableId };
    }
    return null;
  }

  // Task 3b: runBootstrap 实现
  private async runBootstrap(isResume: boolean): Promise<BitableConfig | null> {
    try {
      // ── CREATING_APP ──
      if (!isResume || !this.state.app_token) {
        this.saveState({ phase: 'CREATING_APP' });
        // 飞书 Bitable API 不支持 description 字段，签名改为写入 __BridgeConfig 表
        const app = await bitableClient.createBitableApp('LarkBridge 任务看板');
        if (!app) {
          this.saveState({ phase: 'FAILED' });
          return null;
        }
        this.saveState({
          app_token: app.app_token,
          feishu_app_id: this.feishuAppId,
          instance_id: this.instanceId,
          created_at: new Date().toISOString(),  // 记录首次创建时间
        });
        console.log(`[Bootstrap] 多维表格已创建: ${app.url}`);
      }

      const appToken = this.state.app_token!;

      // ── CREATING_TABLES ──
      if (!isResume || !this.state.task_table_id || !this.state.project_table_id) {
        this.saveState({ phase: 'CREATING_TABLES' });

        // 飞书新建多维表格时会自动创建一张默认数据表（"数据表"）。
        // 飞书不允许删除最后一张表，所以先创建任务表和项目表，再删除默认表。
        const existingTables = await bitableClient.listTables(appToken);
        const existingTableMap = new Map(existingTables.map(t => [t.name, t.table_id]));
        // __temp__ 是 bootstrap 自身在删表前创建的占位表，也需要清理
        const DEFAULT_SHEET_NAMES = new Set(['数据表', 'Sheet1', 'Sheet', 'Table', '__temp__']);

        // 创建任务表（复用已有的，避免重复创建）
        let taskTableId: string;
        if (existingTableMap.has('任务')) {
          taskTableId = existingTableMap.get('任务')!;
          console.log(`[Bootstrap] 任务表已存在，复用: ${taskTableId}`);
          this.saveState({ task_table_id: taskTableId });
        } else {
          const taskTable = await bitableClient.createTable(appToken, '任务', [
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
          if (!taskTable) { this.saveState({ phase: 'FAILED' }); return null; }
          taskTableId = taskTable.table_id;
          this.saveState({ task_table_id: taskTableId });
          console.log(`[Bootstrap] 任务表已创建: ${taskTableId}`);
        }

        // 创建项目表（复用已有的）
        let projectTableId: string;
        if (existingTableMap.has('项目')) {
          projectTableId = existingTableMap.get('项目')!;
          console.log(`[Bootstrap] 项目表已存在，复用: ${projectTableId}`);
          this.saveState({ project_table_id: projectTableId });
        } else {
          // 项目表只带文本字段建表，URL 类型字段在 CREATING_FIELDS 阶段单独添加
          const projectTable = await bitableClient.createTable(appToken, '项目', [
            { field_name: PROJECT_FIELDS.name, type: 1 },
          ]);
          if (!projectTable) { this.saveState({ phase: 'FAILED' }); return null; }
          projectTableId = projectTable.table_id;
          this.saveState({ project_table_id: projectTableId });
          console.log(`[Bootstrap] 项目表已创建: ${projectTableId}`);

          // 飞书建表时会忽略传入的字段名，第一个字段默认叫"多行文本"，需要重命名
          const projectFields = await bitableClient.listFieldsWithId(appToken, projectTableId);
          const defaultField = projectFields.find(f => f.field_name === '多行文本');
          if (defaultField) {
            const renamed = await bitableClient.renameField(appToken, projectTableId, defaultField.field_id, PROJECT_FIELDS.name, 1);
            if (renamed) {
              console.log(`[Bootstrap] 项目表默认字段已重命名为"${PROJECT_FIELDS.name}"`);
            }
          }
        }

        // 两张业务表都就绪后，删除飞书自动生成的默认空数据表
        for (const t of existingTables) {
          if (DEFAULT_SHEET_NAMES.has(t.name)) {
            console.log(`[Bootstrap] 删除默认 Sheet: "${t.name}"`);
            await bitableClient.deleteTable(appToken, t.table_id);
          }
        }
      }

      const taskTableId = this.state.task_table_id!;    // 由 CREATING_TABLES 阶段写入
      const projectTableId = this.state.project_table_id!;

      // ── 清理残留占位表（无论从哪个阶段恢复都执行）──
      const DEFAULT_SHEET_NAMES_CLEANUP = new Set(['数据表', 'Sheet1', 'Sheet', 'Table', '__placeholder__', '__temp__']);
      const allTables = await bitableClient.listTables(appToken);
      for (const t of allTables) {
        if (DEFAULT_SHEET_NAMES_CLEANUP.has(t.name)) {
          console.log(`[Bootstrap] 清理残留默认表: "${t.name}"`);
          await bitableClient.deleteTable(appToken, t.table_id);
        }
      }

      // ── CREATING_FIELDS ──
      this.saveState({ phase: 'CREATING_FIELDS', created_fields: this.state.created_fields ?? [] });
      await this.createRemainingFields(appToken, taskTableId, projectTableId);

      // ── CREATING_VIEWS ──
      this.saveState({ phase: 'CREATING_VIEWS' });
      await this.createTaskTableViews(appToken, taskTableId);

      // ── GRANTING_PERMS ──
      this.saveState({ phase: 'GRANTING_PERMS' });
      await this.grantPermissionsToAllowedUsers(appToken);

      // ── DONE ──
      const config: BitableConfig = { appToken, taskTableId, projectTableId };
      this.saveState({ phase: 'DONE', schema_version: BITABLE_SCHEMA_VERSION });

      const url = `https://feishu.cn/base/${appToken}`;
      console.log(`\n✅ 任务看板已创建：${url}`);
      console.log('ℹ️  建议将以下配置写入 .env：');
      console.log(`   BITABLE_APP_TOKEN=${appToken}`);
      console.log(`   BITABLE_TASK_TABLE_ID=${taskTableId}`);
      console.log(`   BITABLE_PROJECT_TABLE_ID=${projectTableId}\n`);

      return config;
    } catch (err) {
      this.saveState({ phase: 'FAILED' });
      console.error('[Bootstrap] 初始化失败:', err);
      return null;
    }
  }

  // Task 4: 字段批量创建
  private getTaskFieldDefinitions(): Array<{ field_name: string; type: number; property?: Record<string, unknown> }> {
    return [
      // A 组（status/priority/blocked_reason/title 已在建表时创建）
      { field_name: TASK_FIELDS.execution_agent, type: 1 },
      // B 组
      { field_name: TASK_FIELDS.chat_link, type: 15 },  // 15 = URL 类型（已验证）
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

  private getProjectFieldDefinitions(): Array<{ field_name: string; type: number }> {
    return [
      { field_name: PROJECT_FIELDS.project_id, type: 1 },
      { field_name: PROJECT_FIELDS.repo_url, type: 15 },  // 15 = URL 类型（已验证）
      // P2-A: 项目总表扩展字段（必须在 bootstrap 阶段创建，保证 health-check 能通过）
      { field_name: PROJECT_FIELDS.task_table_id, type: 1 },           // 项目专属任务表ID
      { field_name: PROJECT_FIELDS.default_execution_agent, type: 1 }, // 默认执行Agent
      { field_name: PROJECT_FIELDS.workspace_paths, type: 1 },         // 工作目录配置（JSON）
      { field_name: PROJECT_FIELDS.created_at, type: 5 },
      { field_name: PROJECT_FIELDS.updated_at, type: 5 },
    ];
  }

  private async createRemainingFields(
    appToken: string,
    taskTableId: string,
    projectTableId: string,
  ): Promise<void> {
    const createdFields = new Set(this.state.created_fields ?? []);
    const existingTaskFields = new Set(await bitableClient.listFields(appToken, taskTableId));
    const existingProjectFields = new Set(await bitableClient.listFields(appToken, projectTableId));

    const taskFieldDefs = this.getTaskFieldDefinitions();
    for (const f of taskFieldDefs) {
      const key = `task:${f.field_name}`;
      if (createdFields.has(key) || existingTaskFields.has(f.field_name)) continue;
      const ok = await bitableClient.createField(appToken, taskTableId, f.field_name, f.type, f.property);
      if (ok) {
        createdFields.add(key);
        if (createdFields.size % 5 === 0) {
          this.saveState({ created_fields: Array.from(createdFields) });
        }
      }
      await new Promise(r => setTimeout(r, 150));
    }

    const projectFieldDefs = this.getProjectFieldDefinitions();
    for (const f of projectFieldDefs) {
      const key = `project:${f.field_name}`;
      if (createdFields.has(key) || existingProjectFields.has(f.field_name)) continue;
      const ok = await bitableClient.createField(appToken, projectTableId, f.field_name, f.type);
      if (ok) createdFields.add(key);
      await new Promise(r => setTimeout(r, 150));
    }

    this.saveState({ created_fields: Array.from(createdFields) });
    console.log(`[Bootstrap] 字段创建完成，共处理 ${createdFields.size} 个字段`);
  }

  /**
   * 为任务表创建看板视图（按"状态"字段分组），并设置表格视图的字段可见性
   * - 已存在则跳过（幂等）
   * - 失败不阻断 Bootstrap 主流程
   */
  private async createTaskTableViews(appToken: string, taskTableId: string): Promise<void> {
    await ensureTaskTableViews(bitableClient, appToken, taskTableId);
  }

  // Task 5: healthCheck 和权限授权
  async healthCheck(config: BitableConfig): Promise<boolean> {
    console.log('[Bootstrap] 执行健康检查...');
    const { appToken, taskTableId, projectTableId } = config;

    const tables = await bitableClient.listTables(appToken);
    const tableNames = tables.map(t => t.name);
    if (!tableNames.includes('任务') || !tableNames.includes('项目')) {
      console.warn('[Bootstrap] 健康检查：数据表缺失。请删除 .bitable-state.json 后重启服务以触发重新初始化。');
      console.warn(`  当前数据表：[${tableNames.join(', ')}]`);
      return false;
    }

    // P2-A: 检查任务表字段
    const existingTaskFields = new Set(await bitableClient.listFields(appToken, taskTableId));
    const allTaskFieldNames = Object.values(TASK_FIELDS);
    const missingTaskFields = allTaskFieldNames.filter(f => !existingTaskFields.has(f));

    if (missingTaskFields.length > 0) {
      console.log(`[Bootstrap] 任务表发现 ${missingTaskFields.length} 个缺失字段，自动补创...`);
      this.state = { ...this.state, created_fields: [] };
      await this.createRemainingFields(appToken, taskTableId, projectTableId);
    }

    // P2-A: 检查项目表字段（必须包含 P2 扩展字段）
    const existingProjectFields = new Set(await bitableClient.listFields(appToken, projectTableId));
    const allProjectFieldNames = Object.values(PROJECT_FIELDS);
    const missingProjectFields = allProjectFieldNames.filter(f => !existingProjectFields.has(f));

    if (missingProjectFields.length > 0) {
      console.log(`[Bootstrap] 项目表发现 ${missingProjectFields.length} 个缺失字段，自动补创...`);
      console.log(`[Bootstrap] 缺失字段: ${missingProjectFields.join(', ')}`);
      this.state = { ...this.state, created_fields: [] };
      await this.createRemainingFields(appToken, taskTableId, projectTableId);
    }

    const savedVersion = this.state.schema_version;
    if (savedVersion && savedVersion !== BITABLE_SCHEMA_VERSION) {
      // 明确检测到版本落后，执行升级
      console.log(`[Bootstrap] Schema 升级: ${savedVersion} → ${BITABLE_SCHEMA_VERSION}`);
      this.saveState({ schema_version: BITABLE_SCHEMA_VERSION });
    } else if (!savedVersion) {
      // state 为空（如 env var 路径），仅同步内存，不写文件
      this.state.schema_version = BITABLE_SCHEMA_VERSION;
    }

    console.log('[Bootstrap] 健康检查通过 ✅');
    return true;
  }

  private async grantPermissionsToAllowedUsers(appToken: string): Promise<void> {
    const allowedUsers = (process.env.ALLOWED_USERS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (allowedUsers.length === 0) {
      console.log('[Bootstrap] ALLOWED_USERS 未配置，跳过批量授权（宽松模式）');
      return;
    }

    const grantedUsers = new Set(this.state.granted_users ?? []);
    for (const openId of allowedUsers) {
      if (grantedUsers.has(openId)) continue;
      const ok = await bitableClient.grantBitablePermission(appToken, openId);
      if (ok) {
        grantedUsers.add(openId);
        console.log(`[Bootstrap] ✅ 已授权: ${openId}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    this.saveState({ granted_users: Array.from(grantedUsers) });
  }

  async grantPermissionOnFirstInteraction(appToken: string, openId: string): Promise<string | null> {
    const grantedUsers = new Set(this.state.granted_users ?? []);
    if (grantedUsers.has(openId)) return null;
    const ok = await bitableClient.grantBitablePermission(appToken, openId);
    if (ok) {
      grantedUsers.add(openId);
      this.saveState({ granted_users: Array.from(grantedUsers) });
      console.log(`[Bootstrap] 首次交互授权: ${openId}`);
      return `https://feishu.cn/base/${appToken}`;
    }
    return null;
  }

  /**
   * 获取任务看板的访问 URL
   */
  getBitableUrl(): string | null {
    const appToken = this.state.app_token;
    return appToken ? `https://feishu.cn/base/${appToken}` : null;
  }

  /**
   * 是否刚刚全新创建（非复用已有配置）
   * created_at 只在 runBootstrap 全新创建时写入
   */
  /**
   * 从 state 文件加载状态（用于 env var 路径下检查 isNewlyCreated）
   */
  loadStateForNotification(): void {
    const fileState = this.loadState();
    if (fileState) {
      this.state = { ...this.state, ...fileState };
    }
  }

  isNewlyCreated(): boolean {
    return !!this.state.created_at &&
      Date.now() - new Date(this.state.created_at).getTime() < 10 * 60_000;  // 10 分钟窗口
  }

  loadState(): Partial<BitableState> | null {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        return JSON.parse(raw) as Partial<BitableState>;
      }
    } catch (err) {
      console.warn('[Bootstrap] 状态文件损坏，将重新初始化:', err);
      // 备份损坏的文件以便排查
      try {
        const backupPath = `${STATE_FILE}.broken-${Date.now()}`;
        fs.renameSync(STATE_FILE, backupPath);
        console.warn(`[Bootstrap] 损坏文件已备份至: ${backupPath}`);
      } catch {
        // 备份失败不阻断流程
      }
    }
    return null;
  }

  saveState(patch: Partial<BitableState>): void {
    const merged = { ...this.state, ...patch, updated_at: new Date().toISOString() };
    this.state = merged;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Bootstrap] 保存状态文件失败:', err);
    }
  }
}

const _feishuAppId = process.env.FEISHU_APP_ID ?? '';
if (!_feishuAppId) {
  console.warn('[Bootstrap] FEISHU_APP_ID 未配置，Bootstrap 签名将使用空字符串（多实例隔离无效）');
}
export const bitableBootstrap = new BitableBootstrap(
  _feishuAppId,
  process.env.BRIDGE_INSTANCE_ID ?? 'default',
);
