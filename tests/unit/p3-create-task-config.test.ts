import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/handlers/p2p.js', () => ({
  p2pHandler: {
    createTaskGroup: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/feishu/bitable-client.js', () => ({
  bitableClient: {
    findProjectById: vi.fn(),
  },
}));

import { buildCreateTaskCard, type CreateTaskCardData, type ProjectOption } from '../../src/feishu/cards.js';
import { cardActionHandler } from '../../src/handlers/card-action.js';
import { p2pHandler } from '../../src/handlers/p2p.js';
import { bitableClient } from '../../src/feishu/bitable-client.js';

const mockCreateTaskGroup = vi.mocked(p2pHandler.createTaskGroup);
const mockFindProjectById = vi.mocked(bitableClient.findProjectById);

describe('P3-A create_task 模型与 Agent 配置', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProjectById.mockResolvedValue(null);
  });

  it('create_task 卡片应包含 model 和 agent 输入字段', () => {
    const projects: ProjectOption[] = [
      {
        projectId: 'proj_project_a',
        name: 'ProjectA',
        workspacePaths: ['/workspace/a'],
        defaultExecutionAgent: 'project-agent',
      },
    ];

    const data: CreateTaskCardData = {
      workspacePaths: ['/workspace/a'],
      projectNames: ['ProjectA'],
      projects,
    };

    const card = buildCreateTaskCard(data) as any;
    const form = card.elements.find((e: any) => e.tag === 'form');
    const modelInput = form.elements.find((e: any) => e.name === 'model_name');
    const agentInput = form.elements.find((e: any) => e.name === 'agent_name');

    expect(modelInput).toBeDefined();
    expect(agentInput).toBeDefined();
    expect(modelInput.label.content).toContain('模型');
    expect(agentInput.label.content).toContain('Agent');
  });

  it('create_task 卡片应复用 /panel 风格的模型和角色候选项', () => {
    const projects: ProjectOption[] = [
      {
        projectId: 'proj_project_a',
        name: 'ProjectA',
        workspacePaths: ['/workspace/a'],
        defaultExecutionAgent: 'project-agent',
      },
    ];

    const data: CreateTaskCardData = {
      workspacePaths: ['/workspace/a'],
      projectNames: ['ProjectA'],
      projects,
      modelOptions: [
        { label: '[OpenAI] GPT-5', value: 'openai:gpt-5' },
        { label: '[Anthropic] Sonnet', value: 'anthropic:sonnet' },
      ],
      agentOptions: [
        { label: '（主）默认角色', value: 'none' },
        { label: '（主）通用助手', value: 'general' },
      ],
    };

    const card = buildCreateTaskCard(data) as any;
    const form = card.elements.find((e: any) => e.tag === 'form');
    const modelSelect = form.elements.find((e: any) => e.name === 'model_name');
    const agentSelect = form.elements.find((e: any) => e.name === 'agent_name');

    expect(modelSelect.tag).toBe('select_static');
    expect(agentSelect.tag).toBe('select_static');
    expect(modelSelect.options.map((item: any) => item.value)).toEqual(['openai:gpt-5', 'anthropic:sonnet']);
    expect(agentSelect.options.map((item: any) => item.value)).toEqual(['none', 'general']);
  });

  it('create_task_submit 应解析显式 model/agent 并传给 createTaskGroup', async () => {
    await cardActionHandler.handle({
      openId: 'user_open_id',
      senderId: 'user_open_id',
      messageId: 'msg_001',
      action: {
        form_value: {
          task_title: 'Test Task',
          task_description: 'Test Desc',
          project_select: 'proj_project_a',
          workspace_select: '/workspace/a',
          model_name: 'gpt-5',
          agent_name: 'general',
          project_config_map: JSON.stringify({
            projects: {
              proj_project_a: {
                name: 'ProjectA',
                workspacePaths: ['/workspace/a'],
                defaultExecutionAgent: 'project-agent',
              },
            },
          }),
        },
        value: {
          action: 'create_task_submit',
        },
      },
    } as any);

    expect(mockCreateTaskGroup).toHaveBeenCalledWith(expect.objectContaining({
      taskTitle: 'Test Task',
      projectId: 'proj_project_a',
      projectName: 'ProjectA',
      workspacePath: '/workspace/a',
      executionAgent: 'general',
      modelName: 'gpt-5',
    }));
  });

  it('选择默认角色时应清空 executionAgent 并交由 OpenCode 默认机制决定', async () => {
    await cardActionHandler.handle({
      openId: 'user_open_id',
      senderId: 'user_open_id',
      messageId: 'msg_003',
      action: {
        form_value: {
          task_title: 'Test Task',
          project_select: 'proj_project_a',
          workspace_select: '/workspace/a',
          model_name: 'openai:gpt-5',
          agent_name: 'none',
          project_config_map: JSON.stringify({
            projects: {
              proj_project_a: {
                name: 'ProjectA',
                workspacePaths: ['/workspace/a'],
                defaultExecutionAgent: 'project-agent',
              },
            },
          }),
        },
        value: {
          action: 'create_task_submit',
        },
      },
    } as any);

    expect(mockCreateTaskGroup).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj_project_a',
      projectName: 'ProjectA',
      executionAgent: undefined,
      modelName: 'openai:gpt-5',
    }));
  });

  it('未显式填写 model/agent 时应留空并交由 OpenCode 默认机制决定', async () => {
    await cardActionHandler.handle({
      openId: 'user_open_id',
      senderId: 'user_open_id',
      messageId: 'msg_002',
      action: {
        form_value: {
          task_title: 'Test Task',
          project_select: 'proj_project_a',
          workspace_select: '/workspace/a',
          model_name: '',
          agent_name: '',
          project_config_map: JSON.stringify({
            projects: {
              proj_project_a: {
                name: 'ProjectA',
                workspacePaths: ['/workspace/a'],
                defaultExecutionAgent: 'project-agent',
              },
            },
          }),
        },
        value: {
          action: 'create_task_submit',
        },
      },
    } as any);

    expect(mockCreateTaskGroup).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj_project_a',
      projectName: 'ProjectA',
      executionAgent: undefined,
      modelName: undefined,
    }));
  });

  it('create_task 卡片项目选项 value 应使用稳定 project_id，且配置映射应按 project_id 建索引', () => {
    const data = {
      workspacePaths: ['/workspace/a'],
      projectNames: ['ProjectA'],
      projects: [
        {
          projectId: 'proj_project_a',
          name: 'ProjectA',
          workspacePaths: ['/workspace/a'],
          defaultExecutionAgent: 'project-agent',
        },
      ],
    } as unknown as CreateTaskCardData;

    const card = buildCreateTaskCard(data) as { elements: Array<{ tag: string; elements?: Array<Record<string, unknown>> }> };
    const form = card.elements.find(element => element.tag === 'form');
    const elements = form?.elements ?? [];
    const projectSelect = elements.find(element => element.name === 'project_select') as { options?: Array<{ value: string }> } | undefined;
    const submitButton = elements.find(element => element.name === 'create_task_submit') as {
      value?: string | { project_config_map?: string };
    } | undefined;

    expect(projectSelect?.options?.some(option => option.value === 'proj_project_a')).toBe(true);

    const configMapText = typeof submitButton?.value === 'object'
      ? submitButton.value?.project_config_map ?? '{}'
      : '{}';
    const configMap = JSON.parse(configMapText) as {
      projects?: Record<string, { name: string; workspacePaths: string[]; defaultExecutionAgent: string | null }>;
    };
    expect(configMap.projects?.proj_project_a).toEqual({
      name: 'ProjectA',
      workspacePaths: ['/workspace/a'],
      defaultExecutionAgent: 'project-agent',
    });
  });

  it('旧卡片若仍提交 project_name 风格的 project_select，应只走名称回退而不伪造 projectId', async () => {
    await cardActionHandler.handle({
      openId: 'user_open_id',
      senderId: 'user_open_id',
      messageId: 'msg_legacy',
      action: {
        form_value: {
          task_title: 'Legacy Task',
          project_select: 'ProjectA',
          workspace_select: '/workspace/a',
          project_config_map: JSON.stringify({
            workspacePaths: { ProjectA: ['/workspace/a'] },
            agents: { ProjectA: 'project-agent' },
          }),
        },
        value: {
          action: 'create_task_submit',
        },
      },
    } as any);

    expect(mockCreateTaskGroup).toHaveBeenCalledWith(expect.objectContaining({
      projectId: undefined,
      projectName: 'ProjectA',
      workspacePath: '/workspace/a',
    }));
  });

  it('create_task_submit 在真实飞书回调只提交 project_select=project_id 时，也应回查项目并避免把 project_id 当项目名', async () => {
    mockFindProjectById.mockResolvedValue({
      project_id: 'proj_project_a',
      name: 'ProjectA',
      repo_url: null,
      task_table_id: 'https://feishu.cn/base/app_token?table=tbl_project_a',
      default_execution_agent: 'project-agent',
      workspace_paths: ['/workspace/a'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    await cardActionHandler.handle({
      openId: 'user_open_id',
      senderId: 'user_open_id',
      messageId: 'msg_real_callback',
      action: {
        form_value: {
          task_title: 'Real Callback Task',
          project_select: 'proj_project_a',
          workspace_select: '/workspace/a',
        },
        value: {
          action: 'create_task_submit',
        },
      },
    } as any);

    expect(mockFindProjectById).toHaveBeenCalledWith('proj_project_a');
    expect(mockCreateTaskGroup).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj_project_a',
      projectName: 'ProjectA',
      workspacePath: '/workspace/a',
    }));
  });
});
