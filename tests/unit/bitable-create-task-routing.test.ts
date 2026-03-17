import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bitableClient } from '../../src/feishu/bitable-client.js';
import { PROJECT_FIELDS, TASK_FIELDS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from '../../src/config/bitable-fields.js';
import type { CreateTaskInput, Project } from '../../src/types/task.js';

type InternalBitableClient = {
  apiFetch: (path: string, opts?: RequestInit, retries?: number) => Promise<Record<string, unknown>>;
  findProjectById: (projectId: string) => Promise<Project | null>;
  findOrCreateProject: (name: string) => Promise<Project | null>;
  getOrCreateProjectTaskTable: (project: Project) => Promise<string | null>;
  listTables: (appToken: string) => Promise<Array<{ table_id: string; name: string }>>;
  createTable: (appToken: string, tableName: string, fields?: Array<{ field_name: string; type: number; property?: Record<string, unknown> }>) => Promise<{ table_id: string } | null>;
  listFields: (appToken: string, tableId: string) => Promise<string[]>;
  createField: (appToken: string, tableId: string, fieldName: string, fieldType: number, property?: Record<string, unknown>) => Promise<boolean>;
  listViews: (appToken: string, tableId: string) => Promise<Array<{ view_id: string; view_name: string; view_type: string }>>;
  listFieldsWithId: (appToken: string, tableId: string) => Promise<Array<{ field_id: string; field_name: string }>>;
  createView: (appToken: string, tableId: string, viewName: string, viewType: 'grid' | 'kanban' | 'gallery' | 'gantt') => Promise<{ view_id: string } | null>;
  setViewHiddenFields: (appToken: string, tableId: string, viewId: string, hiddenFieldIds: string[]) => Promise<boolean>;
  setKanbanGroupField: (appToken: string, tableId: string, viewId: string, groupFieldId: string) => Promise<boolean>;
};

describe('Bitable createTask 路由优先级', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    bitableClient.configure({
      appToken: 'app_token',
      projectTableId: 'project_table',
      taskTableId: 'global_table',
    });
  });

  it('有稳定 project_id 时应优先按 project_id 路由，而不是按 project_name', async () => {
    const internalClient = bitableClient as unknown as InternalBitableClient;
    const project: Project = {
      project_id: 'proj_123',
      name: 'Renamed Project',
      repo_url: null,
      task_table_id: 'project_table_123',
      default_execution_agent: 'project-agent',
      workspace_paths: ['/workspace/project'],
      created_at: new Date(),
      updated_at: new Date(),
    };

    vi.spyOn(internalClient, 'findProjectById').mockResolvedValue(project);
    vi.spyOn(internalClient, 'findOrCreateProject').mockResolvedValue(null);
    vi.spyOn(internalClient, 'getOrCreateProjectTaskTable').mockResolvedValue('project_table_123');
    const apiFetchSpy = vi.spyOn(internalClient, 'apiFetch').mockResolvedValue({
      code: 0,
      data: {
        record: {
          record_id: 'rec_task_123',
          fields: {
            [TASK_FIELDS.title]: 'Task From Stable Project Id',
            [TASK_FIELDS.status]: TASK_STATUS_LABELS.TODO,
            [TASK_FIELDS.priority]: TASK_PRIORITY_LABELS.medium,
            [TASK_FIELDS.execution_agent]: 'project-agent',
            [TASK_FIELDS.chat_link]: '',
            [TASK_FIELDS.workspace_path]: '/workspace/project',
            [TASK_FIELDS.created_at]: 1700000000000,
            [TASK_FIELDS.status_updated_at]: 1700000000000,
            [TASK_FIELDS.updated_at]: 1700000000000,
            [TASK_FIELDS.chat_id]: 'chat_123',
            [TASK_FIELDS.opencode_session_id]: 'session_123',
            [TASK_FIELDS.creator_open_id]: 'user_123',
            [TASK_FIELDS.project_id]: 'proj_123',
            [TASK_FIELDS.archived]: false,
          },
        },
      },
    });

    const input = {
      title: 'Task From Stable Project Id',
      workspace_path: '/workspace/project',
      creator_open_id: 'user_123',
      project_id: 'proj_123',
      project_name: 'Old Project Name',
    } as unknown as CreateTaskInput;

    const task = await bitableClient.createTask(input, 'session_123', 'chat_123');

    expect(internalClient.findProjectById).toHaveBeenCalledWith('proj_123');
    expect(internalClient.findOrCreateProject).not.toHaveBeenCalled();
    expect(internalClient.getOrCreateProjectTaskTable).toHaveBeenCalledWith(project);
    expect(apiFetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/tables/project_table_123/records?user_id_type=open_id'),
      expect.any(Object),
    );
    expect(task?.project_id).toBe('proj_123');
  });

  it('项目任务表写回项目总表时应持久化任务表链接，而不是裸 table_id', async () => {
    const internalClient = bitableClient as unknown as InternalBitableClient;
    const apiFetchSpy = vi.spyOn(internalClient, 'apiFetch').mockResolvedValue({ code: 0 });

    const persisted = await (bitableClient as any).persistProjectTaskTableId('proj_123', 'tbl_project_123');

    expect(persisted).toBe(true);

    const requestBody = JSON.parse(String(apiFetchSpy.mock.calls[0]?.[1]?.body ?? '{}')) as {
      fields?: Record<string, unknown>;
    };
    expect(requestBody.fields?.[PROJECT_FIELDS.task_table_id]).toBe('https://feishu.cn/base/app_token?table=tbl_project_123');
  });

  it('项目记录中的任务表字段为链接时，应仍能解析出内部 table_id 用于路由', () => {
    const project = (bitableClient as any).parseProjectRecord({
      record_id: 'proj_123',
      fields: {
        [PROJECT_FIELDS.name]: 'Project A',
        [PROJECT_FIELDS.repo_url]: null,
        [PROJECT_FIELDS.task_table_id]: 'https://feishu.cn/base/app_token?table=tbl_project_123',
        [PROJECT_FIELDS.default_execution_agent]: null,
        [PROJECT_FIELDS.workspace_paths]: null,
        [PROJECT_FIELDS.created_at]: 1700000000000,
        [PROJECT_FIELDS.updated_at]: 1700000000000,
      },
    }) as Project | null;

    expect(project?.task_table_id).toBe('tbl_project_123');
  });

  it('项目记录中的任务表字段为 URL 对象时，应优先解析 link 中的 table_id，而不是显示文本', () => {
    const project = (bitableClient as any).parseProjectRecord({
      record_id: 'proj_123',
      fields: {
        [PROJECT_FIELDS.name]: 'AesWorld',
        [PROJECT_FIELDS.repo_url]: null,
        [PROJECT_FIELDS.task_table_id]: {
          link: 'https://feishu.cn/base/app_token?table=tbldcFIPuQLIejbD',
          text: 'LarkBridge 任务看板',
        },
        [PROJECT_FIELDS.default_execution_agent]: null,
        [PROJECT_FIELDS.workspace_paths]: null,
        [PROJECT_FIELDS.created_at]: 1700000000000,
        [PROJECT_FIELDS.updated_at]: 1700000000000,
      },
    }) as Project | null;

    expect(project?.task_table_id).toBe('tbldcFIPuQLIejbD');
  });

  it('项目专属表标识为显示名等无效值时，应继续 fallback 到全局表而不是直接失败', async () => {
    const internalClient = bitableClient as unknown as InternalBitableClient;
    const project: Project = {
      project_id: 'proj_aesworld',
      name: 'AesWorld',
      repo_url: null,
      task_table_id: 'LarkBridge 任务看板',
      default_execution_agent: null,
      workspace_paths: ['F:/ShanghaiP4/neon/UGA/DEV_2/Plugins/AesWorld'],
      created_at: new Date(),
      updated_at: new Date(),
    };

    vi.spyOn(internalClient, 'findProjectById').mockResolvedValue(project);
    vi.spyOn(internalClient, 'listTables').mockResolvedValue([]);
    vi.spyOn(bitableClient as any, 'createProjectTaskTable').mockResolvedValue(null);
    const getOrCreateSpy = vi.spyOn(internalClient, 'getOrCreateProjectTaskTable');
    const apiFetchSpy = vi.spyOn(internalClient, 'apiFetch')
      .mockResolvedValueOnce({
        code: 0,
        data: {
          record: {
            record_id: 'rec_task_global',
            fields: {
              [TASK_FIELDS.title]: 'GSD + AesWorld',
              [TASK_FIELDS.status]: TASK_STATUS_LABELS.TODO,
              [TASK_FIELDS.priority]: TASK_PRIORITY_LABELS.medium,
              [TASK_FIELDS.execution_agent]: 'default',
              [TASK_FIELDS.chat_link]: '',
              [TASK_FIELDS.workspace_path]: 'F:/ShanghaiP4/neon/UGA/DEV_2/Plugins/AesWorld',
              [TASK_FIELDS.created_at]: 1700000000000,
              [TASK_FIELDS.status_updated_at]: 1700000000000,
              [TASK_FIELDS.updated_at]: 1700000000000,
              [TASK_FIELDS.chat_id]: 'chat_aesworld',
              [TASK_FIELDS.opencode_session_id]: 'session_aesworld',
              [TASK_FIELDS.creator_open_id]: 'user_123',
              [TASK_FIELDS.project_id]: 'proj_aesworld',
              [TASK_FIELDS.archived]: false,
            },
          },
        },
      });

    const input = {
      title: 'GSD + AesWorld',
      workspace_path: 'F:/ShanghaiP4/neon/UGA/DEV_2/Plugins/AesWorld',
      creator_open_id: 'user_123',
      project_id: 'proj_aesworld',
      project_name: 'AesWorld',
    } as unknown as CreateTaskInput;

    const task = await bitableClient.createTask(input, 'session_aesworld', 'chat_aesworld');

    expect(getOrCreateSpy).toHaveBeenCalledWith(project);
    expect(apiFetchSpy).toHaveBeenCalledTimes(1);
    expect(apiFetchSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/tables/global_table/records?user_id_type=open_id'),
      expect.any(Object),
    );
    expect(task?.task_id).toBe('rec_task_global');
  });

  it('惰性创建项目任务表后必须补建状态看板视图', async () => {
    const internalClient = bitableClient as unknown as InternalBitableClient;

    vi.spyOn(internalClient, 'listTables').mockResolvedValue([]);
    vi.spyOn(internalClient, 'createTable').mockResolvedValue({ table_id: 'tbl_project_123' });
    vi.spyOn(internalClient, 'listFields').mockResolvedValue([
      TASK_FIELDS.title,
      TASK_FIELDS.status,
      TASK_FIELDS.priority,
      TASK_FIELDS.blocked_reason,
    ]);
    vi.spyOn(internalClient, 'createField').mockResolvedValue(true);
    vi.spyOn(internalClient, 'apiFetch').mockResolvedValue({ code: 0 });
    const listViewsSpy = vi.spyOn(internalClient, 'listViews').mockResolvedValue([
      { view_id: 'view_grid_123', view_name: '表格视图', view_type: 'grid' },
    ]);
    const listFieldsWithIdSpy = vi.spyOn(internalClient, 'listFieldsWithId').mockResolvedValue([
      { field_id: 'fld_status', field_name: TASK_FIELDS.status },
      { field_id: 'fld_task_id', field_name: TASK_FIELDS.task_id },
      { field_id: 'fld_project_id', field_name: TASK_FIELDS.project_id },
      { field_id: 'fld_chat_id', field_name: TASK_FIELDS.chat_id },
    ]);
    const createViewSpy = vi.spyOn(internalClient, 'createView').mockResolvedValue({ view_id: 'view_kanban_123' });
    const hiddenFieldsSpy = vi.spyOn(internalClient, 'setViewHiddenFields').mockResolvedValue(true);
    const kanbanSpy = vi.spyOn(internalClient, 'setKanbanGroupField').mockResolvedValue(true);

    const tableId = await bitableClient.createProjectTaskTable('proj_123', 'Project A');

    expect(tableId).toBe('tbl_project_123');
    expect(listViewsSpy).toHaveBeenCalledWith('app_token', 'tbl_project_123');
    expect(listFieldsWithIdSpy).toHaveBeenCalledWith('app_token', 'tbl_project_123');
    expect(createViewSpy).toHaveBeenCalledWith('app_token', 'tbl_project_123', '状态看板', 'kanban');
    expect(hiddenFieldsSpy).toHaveBeenCalledWith('app_token', 'tbl_project_123', 'view_grid_123', expect.any(Array));
    expect(kanbanSpy).toHaveBeenCalledWith('app_token', 'tbl_project_123', 'view_kanban_123', 'fld_status');
  }, 15000);
});
