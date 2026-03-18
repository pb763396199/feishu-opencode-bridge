import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuCardActionEvent } from '../../src/feishu/client.js';

type TaskSubmitEvent = FeishuCardActionEvent & {
  senderId: string;
  action: FeishuCardActionEvent['action'] & {
    value: {
      action: 'create_task_submit';
    };
    form_value: Record<string, string>;
  };
};

type TaskDoEvent = FeishuCardActionEvent & {
  action: FeishuCardActionEvent['action'] & {
    value: {
      action: 'task_do';
      chat_id: string;
    };
  };
};

const mocks = vi.hoisted(() => {
  const createTaskGroup = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue({ info: {}, parts: [] });
  const updateTaskStatus = vi.fn().mockResolvedValue(true);
  const updateChatName = vi.fn().mockResolvedValue(true);
  const getTaskByChatId = vi.fn();
  const getSession = vi.fn();

  return {
    createTaskGroup,
    sendMessage,
    updateTaskStatus,
    updateChatName,
    getTaskByChatId,
    getSession,
  };
});

vi.mock('../../src/handlers/p2p.js', () => ({
  p2pHandler: {
    createTaskGroup: mocks.createTaskGroup,
  },
}));

vi.mock('../../src/opencode/client.js', () => ({
  opencodeClient: {
    sendMessage: mocks.sendMessage,
  },
}));

vi.mock('../../src/store/task-store.js', () => ({
  taskStore: {
    getTaskByChatId: mocks.getTaskByChatId,
    updateTaskStatus: mocks.updateTaskStatus,
  },
}));

vi.mock('../../src/store/chat-session.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/store/chat-session.js')>('../../src/store/chat-session.js');
  return {
    ...actual,
    chatSessionStore: {
      ...actual.chatSessionStore,
      getSession: mocks.getSession,
    },
  };
});

vi.mock('../../src/feishu/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/feishu/client.js')>('../../src/feishu/client.js');
  return {
    ...actual,
    feishuClient: {
      ...actual.feishuClient,
      updateChatName: mocks.updateChatName,
      updateCard: vi.fn().mockResolvedValue(true),
    },
  };
});

import { cardActionHandler } from '../../src/handlers/card-action.js';
import { p2pHandler } from '../../src/handlers/p2p.js';
import { taskCommandHandler } from '../../src/commands/task-commands.js';
import { opencodeClient } from '../../src/opencode/client.js';

function buildTask(overrides: Record<string, unknown> = {}) {
  return {
    title: '测试任务',
    status: 'TODO',
    priority: 'medium',
    blocked_reason: null,
    execution_agent: 'default',
    chat_link: '',
    description: '执行任务内容',
    workspace_path: '/task/workspace',
    started_at: null,
    done_at: null,
    created_at: new Date('2026-03-18T00:00:00.000Z'),
    closed_at: null,
    status_updated_at: new Date('2026-03-18T00:00:00.000Z'),
    unblocked_at: null,
    updated_at: new Date('2026-03-18T00:00:00.000Z'),
    deliverable_summary: null,
    task_id: 'task-1',
    project_id: 'proj-1',
    chat_id: 'chat-1',
    opencode_session_id: 'session-1',
    creator_open_id: 'user_open_id',
    archived: false,
    archived_at: null,
    ...overrides,
  };
}

describe('task workspace regression coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateTaskStatus.mockResolvedValue(true);
    mocks.updateChatName.mockResolvedValue(true);
    mocks.sendMessage.mockResolvedValue({ info: {}, parts: [] });
    mocks.getTaskByChatId.mockResolvedValue(buildTask());
    mocks.getSession.mockReturnValue({
      sessionId: 'session-1',
      resolvedDirectory: '/resolved/workspace',
      defaultDirectory: '/default/workspace',
    });
  });

  it('create_task_submit 应优先把手动输入路径传给 createTaskGroup', async () => {
    const event: TaskSubmitEvent = {
      openId: 'user_open_id',
      senderId: 'user_open_id',
      messageId: 'msg_manual',
      token: 'token_manual',
      rawEvent: {},
      action: {
        tag: 'form',
        form_value: {
          task_title: 'Manual Task',
          project_select: 'proj_project_a',
          workspace_select: '/workspace/from-select',
          workspace_path: '/workspace/from-manual',
          project_config_map: JSON.stringify({
            projects: {
              proj_project_a: {
                name: 'ProjectA',
                workspacePaths: ['/workspace'],
                defaultExecutionAgent: null,
              },
            },
          }),
        },
        value: {
          action: 'create_task_submit',
        },
      },
    };

    await cardActionHandler.handle(event);

    expect(p2pHandler.createTaskGroup).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/workspace/from-manual',
    }));
  });

  it('create_task_submit 在未手输时应把下拉路径传给 createTaskGroup', async () => {
    const event: TaskSubmitEvent = {
      openId: 'user_open_id',
      senderId: 'user_open_id',
      messageId: 'msg_select',
      token: 'token_select',
      rawEvent: {},
      action: {
        tag: 'form',
        form_value: {
          task_title: 'Select Task',
          project_select: 'proj_project_a',
          workspace_select: '/workspace/from-select',
          workspace_path: '',
          project_config_map: JSON.stringify({
            projects: {
              proj_project_a: {
                name: 'ProjectA',
                workspacePaths: ['/workspace/from-select'],
                defaultExecutionAgent: null,
              },
            },
          }),
        },
        value: {
          action: 'create_task_submit',
        },
      },
    };

    await cardActionHandler.handle(event);

    expect(p2pHandler.createTaskGroup).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/workspace/from-select',
    }));
  });

  it('task_do 卡片入口应复用 /do 链路并透传 resolvedDirectory', async () => {
    const event: TaskDoEvent = {
      openId: 'user_open_id',
      messageId: 'msg_task_do',
      token: 'token_task_do',
      rawEvent: {},
      action: {
        tag: 'button',
        value: {
          action: 'task_do',
          chat_id: 'chat-1',
        },
      },
    };

    const result = await cardActionHandler.handle(event);

    expect(taskCommandHandler).toBeDefined();
    expect(opencodeClient.sendMessage).toHaveBeenCalledWith(
      'session-1',
      '执行任务内容',
      { directory: '/resolved/workspace' }
    );
    expect(result).toEqual({
      toast: {
        type: 'success',
        content: '🚀 已启动执行',
        i18n_content: {
          zh_cn: '🚀 已启动执行',
          en_us: '🚀 Execution started',
        },
      },
    });
  });
});
