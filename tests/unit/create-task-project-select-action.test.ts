import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/handlers/p2p.js', () => ({
  p2pHandler: {
    createTaskGroup: vi.fn(),
    buildCreateTaskCardData: vi.fn(),
  },
}));

vi.mock('../../src/feishu/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/feishu/client.js')>('../../src/feishu/client.js');
  return {
    ...actual,
    feishuClient: {
      ...actual.feishuClient,
      updateCard: vi.fn().mockResolvedValue(true),
    },
  };
});

import { cardActionHandler } from '../../src/handlers/card-action.js';
import { p2pHandler } from '../../src/handlers/p2p.js';
import { feishuClient } from '../../src/feishu/client.js';

const mockBuildCreateTaskCardData = vi.mocked(p2pHandler.buildCreateTaskCardData);
const mockUpdateCard = vi.mocked(feishuClient.updateCard);

describe('create_task_project_select 动作', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('选择项目后应重建并刷新 create_task 卡片，只展示该项目工作空间', async () => {
    mockBuildCreateTaskCardData.mockResolvedValue({
      workspacePaths: ['/global/path'],
      projectNames: ['Backend'],
      projects: [
        {
          projectId: 'proj_backend',
          name: 'Backend',
          workspacePaths: ['/workspace/backend/api'],
          defaultExecutionAgent: null,
        },
      ],
      selectedProjectId: 'proj_backend',
      modelOptions: [],
      agentOptions: [],
    });

    const result = await cardActionHandler.handle({
      chatId: 'chat_123',
      messageId: 'msg_123',
      openId: 'user_open_id',
      action: {
        option: { value: 'proj_backend' },
        value: {
          action: 'create_task_project_select',
        },
      },
    } as any);

    expect(mockBuildCreateTaskCardData).toHaveBeenCalledWith('proj_backend');
    expect(mockUpdateCard).toHaveBeenCalledTimes(1);

    const updatedCard = mockUpdateCard.mock.calls[0]?.[1] as any;
    const form = updatedCard.elements.find((element: any) => element.tag === 'form');
    const workspaceSelect = form.elements.find((element: any) => element.name === 'workspace_select');
    const submitButton = form.elements.find((element: any) => element.name === 'create_task_submit');

    expect(workspaceSelect.options).toHaveLength(2);
    expect(workspaceSelect.options[1].value).toBe('/workspace/backend/api');
    expect(submitButton.value.selected_project_id).toBe('proj_backend');
    expect(result).toEqual({
      toast: {
        type: 'success',
        content: '已按项目刷新工作空间',
      },
    });
  });
});
