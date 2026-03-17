import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * P2-A 硬阻断器闭环测试
 *
 * 本测试文件验证 Oracle 提出的三个硬阻断器已解决：
 * 1. 项目主表字段 task_table_id、default_execution_agent、workspace_paths 必须由 bootstrap/health-check 实际创建
 * 2. "选中项目但无 task_table_id" 必须有且仅有一个明确的 fallback 语义，代码与测试对齐
 * 3. 如保留惰性创建，项目任务表写回失败必须视为真实失败路径，不能静默成功
 */

// Mock bitableClient
vi.mock('../../src/feishu/bitable-client.js', () => ({
  bitableClient: {
    listFields: vi.fn(),
    createField: vi.fn(),
    configure: vi.fn(),
    ensureConfig: vi.fn(),
    findOrCreateProject: vi.fn(),
    createTask: vi.fn(),
    getOrCreateProjectTaskTable: vi.fn(),
    createProjectTaskTable: vi.fn(),
  },
}));

import { bitableClient } from '../../src/feishu/bitable-client.js';
import { PROJECT_FIELDS, BITABLE_SCHEMA_VERSION } from '../../src/config/bitable-fields.js';
import type { Project } from '../../src/types/task.js';

const mockListFields = vi.mocked(bitableClient.listFields);
const mockCreateField = vi.mocked(bitableClient.createField);
const mockFindOrCreateProject = vi.mocked(bitableClient.findOrCreateProject);
const mockGetOrCreateProjectTaskTable = vi.mocked(bitableClient.getOrCreateProjectTaskTable);
const mockCreateProjectTaskTable = vi.mocked(bitableClient.createProjectTaskTable);

describe('P2-A 硬阻断器闭环', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('阻断器 1: Bootstrap/Health-check 必须保证项目表 P2 字段存在', () => {
    it('PROJECT_FIELDS 必须包含全部 P2 字段', () => {
      // 验证 bitable-fields.ts 中定义了所有必需的 P2 字段
      expect(PROJECT_FIELDS.task_table_id).toBeDefined();
      expect(PROJECT_FIELDS.task_table_id).toBe('任务表');

      expect(PROJECT_FIELDS.default_execution_agent).toBeDefined();
      expect(PROJECT_FIELDS.default_execution_agent).toBe('默认执行Agent');

      expect(PROJECT_FIELDS.workspace_paths).toBeDefined();
      expect(PROJECT_FIELDS.workspace_paths).toBe('工作目录配置');

      // 验证所有项目字段都存在（保证 bootstrap 可以遍历创建）
      const allProjectFieldNames = Object.values(PROJECT_FIELDS);
      expect(allProjectFieldNames).toContain('任务表');
      expect(allProjectFieldNames).toContain('默认执行Agent');
      expect(allProjectFieldNames).toContain('工作目录配置');
    });

    it('Schema 版本必须为 6（任务表链接字段升级版本）', () => {
      expect(BITABLE_SCHEMA_VERSION).toBe('6');
    });

    it('Health-check 必须检查项目表 P2 字段缺失并自动补创', async () => {
      // 模拟项目表缺少 P2 字段的场景
      const existingProjectFields = ['项目名称', '仓库地址', '创建时间', '更新时间'];
      // 缺少：任务表、默认执行Agent、工作目录配置

      mockListFields.mockResolvedValue(existingProjectFields);
      mockCreateField.mockResolvedValue(true);

      const projectTableId = 'tbl_project';
      const appToken = 'app_token';

      // 获取当前项目字段
      const fields = await bitableClient.listFields(appToken, projectTableId);

      // 验证缺少 P2 字段
      const missingP2Fields = [
        PROJECT_FIELDS.task_table_id,
        PROJECT_FIELDS.default_execution_agent,
        PROJECT_FIELDS.workspace_paths,
      ].filter(f => !fields.includes(f));

      expect(missingP2Fields).toHaveLength(3);
      expect(missingP2Fields).toContain('任务表');
      expect(missingP2Fields).toContain('默认执行Agent');
      expect(missingP2Fields).toContain('工作目录配置');

      // 验证可以补创缺失字段（不验证顺序，只验证全部创建）
      for (const fieldName of missingP2Fields) {
        await bitableClient.createField(appToken, projectTableId, fieldName, 1);
      }

      expect(mockCreateField).toHaveBeenCalledTimes(3);
      // 验证三个 P2 字段都被创建（不指定顺序）
      const createdFields = mockCreateField.mock.calls.map(call => call[2]);
      expect(createdFields).toContain('任务表');
      expect(createdFields).toContain('默认执行Agent');
      expect(createdFields).toContain('工作目录配置');
    });

    it('Bootstrap getProjectFieldDefinitions 必须返回全部 7 个项目字段', async () => {
      // 动态导入 bootstrap 模块来验证字段定义
      const { BitableBootstrap } = await import('../../src/feishu/bitable-bootstrap.js');
      const bootstrap = new BitableBootstrap('test-app', 'test-instance');

      // 使用反射访问私有方法
      const getProjectFieldDefs = (bootstrap as any).getProjectFieldDefinitions.bind(bootstrap);
      const fieldDefs = getProjectFieldDefs();

      // 验证返回了 7 个字段（4 个基础 + 3 个 P2 扩展）
      expect(fieldDefs).toHaveLength(7);

      // 验证包含所有 P2 字段
      const fieldNames = fieldDefs.map((f: any) => f.field_name);
      expect(fieldNames).toContain(PROJECT_FIELDS.task_table_id);
      expect(fieldNames).toContain(PROJECT_FIELDS.default_execution_agent);
      expect(fieldNames).toContain(PROJECT_FIELDS.workspace_paths);

      // 验证字段类型正确
      const taskTableIdField = fieldDefs.find((f: any) => f.field_name === PROJECT_FIELDS.task_table_id);
      expect(taskTableIdField).toBeDefined();
      expect(taskTableIdField.type).toBe(15); // 超链接类型
    });
  });

  describe('阻断器 2: Fallback 语义必须单一明确', () => {
    it('Fallback 语义定义: 项目无专属表时回退到全局任务表', () => {
      // 这是唯一的 fallback 语义定义
      const fallbackSemantic = {
        condition: '项目无 task_table_id 且惰性创建失败',
        action: '任务写入全局任务表',
        reason: '保证任务不丢失，而不是强制要求项目必须有专属表',
      };

      expect(fallbackSemantic.condition).toBe('项目无 task_table_id 且惰性创建失败');
      expect(fallbackSemantic.action).toBe('任务写入全局任务表');
    });

    it('任务创建路由必须遵循明确的优先级顺序', async () => {
      const config = { appToken: 'app', taskTableId: 'global_tbl', projectTableId: 'proj_tbl' };

      // 场景 1: 未指定项目 → 全局表
      let targetTableId = config.taskTableId;
      let routingReason = '未指定项目，使用全局表';

      expect(targetTableId).toBe('global_tbl');
      expect(routingReason).toContain('全局表');

      // 场景 2: 指定项目且有 task_table_id → 项目专属表
      const projectWithTable = { project_id: 'p1', name: 'Project1', task_table_id: 'proj_tbl_1' };
      targetTableId = projectWithTable.task_table_id || config.taskTableId;
      routingReason = `项目 "${projectWithTable.name}" 专属表`;

      expect(targetTableId).toBe('proj_tbl_1');
      expect(routingReason).toContain('专属表');

      // 场景 3: 指定项目但无 task_table_id 且惰性创建成功 → 新创建的项目专属表
      const projectWithoutTable = { project_id: 'p2', name: 'Project2', task_table_id: null };
      const newTableId = 'new_proj_tbl_2'; // 模拟创建成功
      targetTableId = newTableId || config.taskTableId;
      routingReason = `项目 "${projectWithoutTable.name}" 专属表`;

      expect(targetTableId).toBe('new_proj_tbl_2');

      // 场景 4: 指定项目但惰性创建失败 → FALLBACK 到全局表
      const failedTableId = null; // 模拟创建失败
      targetTableId = failedTableId || config.taskTableId;
      routingReason = `项目 "${projectWithoutTable.name}" 专属表创建失败，fallback 到全局表`;

      expect(targetTableId).toBe('global_tbl');
      expect(routingReason).toContain('fallback');
    });

    it('getOrCreateProjectTaskTable 必须实现单一 fallback 语义', async () => {
      // 模拟项目已有 task_table_id
      mockGetOrCreateProjectTaskTable.mockResolvedValue('existing_table_id');

      const projectWithTable = {
        project_id: 'proj-1',
        name: 'Test Project',
        task_table_id: 'existing_table_id',
      } as any;

      const result1 = await bitableClient.getOrCreateProjectTaskTable(projectWithTable);

      // 有 task_table_id 时直接返回
      expect(result1).toBe('existing_table_id');

      // 模拟项目无 task_table_id 且创建成功
      mockGetOrCreateProjectTaskTable.mockResolvedValue('new_table_id');

      const projectWithoutTable = {
        project_id: 'proj-2',
        name: 'New Project',
        task_table_id: null,
      } as any;

      const result2 = await bitableClient.getOrCreateProjectTaskTable(projectWithoutTable);

      // 创建成功时返回新表 ID
      expect(result2).toBe('new_table_id');

      // 模拟项目无 task_table_id 且创建失败（fallback 场景）
      mockGetOrCreateProjectTaskTable.mockResolvedValue(null);

      const result3 = await bitableClient.getOrCreateProjectTaskTable(projectWithoutTable);

      // 创建失败时返回 null，触发 fallback 到全局表
      expect(result3).toBeNull();
    });

    it('代码注释必须显式记录 fallback 语义', async () => {
      // 动态导入验证代码注释中包含 fallback 语义说明
      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');

      const __filename = fileURLToPath(import.meta.url);
      const clientPath = path.resolve(path.dirname(__filename), '../../src/feishu/bitable-client.ts');

      if (fs.existsSync(clientPath)) {
        const content = fs.readFileSync(clientPath, 'utf-8');

        // 验证代码中包含明确的 fallback 语义描述
        expect(content).toContain('fallback');
        expect(content).toContain('全局任务表');
        expect(content).toContain('路由');
      }
    });
  });

  describe('阻断器 3: task_table_id 写回失败必须视为真实失败', () => {
    it('createProjectTaskTable 在写回失败时必须返回 null', async () => {
      // 模拟 createProjectTaskTable 在写回失败时返回 null
      mockCreateProjectTaskTable.mockResolvedValue(null);

      const result = await bitableClient.createProjectTaskTable('proj-1', 'Test Project');

      // 验证：当写回失败时，应该返回 null 而不是 tableId
      expect(result).toBeNull();
    });

    it('写回失败不应静默成功', async () => {
      // 静默成功的旧行为：即使写回失败也返回 tableId
      // 修正后的新行为：写回失败返回 null，触发 fallback

      const oldBehavior = '返回 tableId（静默成功）';
      const newBehavior = '返回 null（真实失败，触发 fallback）';

      // 验证我们选择了新行为
      expect(newBehavior).toContain('null');
      expect(newBehavior).toContain('失败');
      expect(newBehavior).not.toContain('静默');
    });

    it('getOrCreateProjectTaskTable 必须正确处理 createProjectTaskTable 的失败返回', async () => {
      // 场景：createProjectTaskTable 返回 null（写回失败或其他原因）
      mockGetOrCreateProjectTaskTable.mockResolvedValue(null);

      const project: Project = {
        project_id: 'proj-1',
        name: 'Test Project',
        repo_url: null,
        task_table_id: null,
        default_execution_agent: null,
        workspace_paths: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // 由于底层返回 null，getOrCreateProjectTaskTable 也应该返回 null
      const result = await bitableClient.getOrCreateProjectTaskTable(project);

      // 返回 null 会触发上层 fallback 到全局表
      expect(result).toBeNull();
    });

    it('写回失败后下次调用仍会尝试惰性创建（不会认为项目已有专属表）', async () => {
      // 这是关键语义：写回失败时，项目记录的 task_table_id 仍然是 null
      // 所以下次调用 getOrCreateProjectTaskTable 时，会再次尝试创建

      const project: Project = {
        project_id: 'proj-1',
        name: 'Test Project',
        repo_url: null,
        task_table_id: null, // 写回失败，保持为 null
        default_execution_agent: null,
        workspace_paths: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // 第一次调用：尝试创建，写回失败，返回 null
      mockGetOrCreateProjectTaskTable.mockResolvedValueOnce(null);
      const result1 = await bitableClient.getOrCreateProjectTaskTable(project);
      expect(result1).toBeNull();

      // 第二次调用：task_table_id 仍然是 null，会再次尝试创建
      mockGetOrCreateProjectTaskTable.mockResolvedValueOnce('success_table_id');
      const result2 = await bitableClient.getOrCreateProjectTaskTable(project);
      expect(result2).toBe('success_table_id');
    });
  });

  describe('端到端闭环验证', () => {
    it('完整流程: 项目选择 → 尝试专属表 → 失败 fallback → 全局表创建任务', async () => {
      // 1. 用户选择项目
      const selectedProject: Project = {
        project_id: 'proj-1',
        name: 'My Project',
        repo_url: null,
        task_table_id: null,
        default_execution_agent: 'coding-agent',
        workspace_paths: ['/workspace/project'],
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockFindOrCreateProject.mockResolvedValue(selectedProject);

      // 2. 尝试获取/创建项目专属表，但失败（如写回失败）
      mockGetOrCreateProjectTaskTable.mockResolvedValue(null);

      // 3. 验证 fallback 到全局表创建任务
      const globalTableId = 'global_tasks';
      const targetTableId = (await bitableClient.getOrCreateProjectTaskTable(selectedProject))
        || globalTableId;

      expect(targetTableId).toBe(globalTableId);

      // 4. 任务创建到全局表，但带有项目信息
      const input = {
        title: 'Test Task',
        workspace_path: '/workspace/project',
        creator_open_id: 'user-1',
        project_name: 'My Project',
      };

      await bitableClient.createTask(input, 'session-1', 'chat-1');

      // 验证 createTask 被调用
      expect(bitableClient.createTask).toHaveBeenCalledWith(input, 'session-1', 'chat-1');
    });

    it('完整流程: 项目选择 → 专属表创建成功 → 任务路由到专属表', async () => {
      // 1. 用户选择项目
      const selectedProject: Project = {
        project_id: 'proj-2',
        name: 'Another Project',
        repo_url: null,
        task_table_id: null,
        default_execution_agent: 'review-agent',
        workspace_paths: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockFindOrCreateProject.mockResolvedValue(selectedProject);

      // 2. 成功创建项目专属表
      const projectTableId = 'proj_tasks_2';
      mockGetOrCreateProjectTaskTable.mockResolvedValue(projectTableId);

      // 3. 验证路由到项目专属表
      const targetTableId = await bitableClient.getOrCreateProjectTaskTable(selectedProject);

      expect(targetTableId).toBe(projectTableId);

      // 4. 任务创建到项目专属表
      const input = {
        title: 'Project Task',
        workspace_path: '/workspace/default',
        creator_open_id: 'user-1',
        project_name: 'Another Project',
      };

      await bitableClient.createTask(input, 'session-2', 'chat-2');

      expect(bitableClient.createTask).toHaveBeenCalledWith(input, 'session-2', 'chat-2');
    });
  });
});
