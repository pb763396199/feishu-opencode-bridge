import { describe, expect, it } from 'vitest';
import { resolveTaskExecutionDirectory } from '../src/commands/task-commands.js';
import type { Task } from '../src/types/task.js';
import type { ChatSessionData } from '../src/store/chat-session.js';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    title: '测试任务',
    status: 'TODO',
    priority: 'medium',
    blocked_reason: null,
    execution_agent: 'default',
    chat_link: '',
    description: 'desc',
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
    project_id: 'project-1',
    chat_id: 'chat-1',
    opencode_session_id: 'session-1',
    creator_open_id: 'user-1',
    archived: false,
    archived_at: null,
    ...overrides,
  };
}

function createSession(overrides: Partial<ChatSessionData> = {}): ChatSessionData {
  return {
    chatId: 'chat-1',
    sessionId: 'session-1',
    creatorId: 'user-1',
    createdAt: Date.now(),
    interactionHistory: [],
    ...overrides,
  };
}

describe('resolveTaskExecutionDirectory', () => {
  it('优先使用 resolvedDirectory', () => {
    const result = resolveTaskExecutionDirectory(
      createTask({ workspace_path: '/task/workspace' }),
      createSession({ resolvedDirectory: '/resolved/workspace', defaultDirectory: '/default/workspace' })
    );

    expect(result).toEqual({
      directory: '/resolved/workspace',
      source: 'resolvedDirectory',
    });
  });

  it('resolvedDirectory 缺失时回退到 defaultDirectory', () => {
    const result = resolveTaskExecutionDirectory(
      createTask({ workspace_path: '/task/workspace' }),
      createSession({ resolvedDirectory: '   ', defaultDirectory: '/default/workspace' })
    );

    expect(result).toEqual({
      directory: '/default/workspace',
      source: 'defaultDirectory',
    });
  });

  it('会话目录都缺失时回退到 task.workspace_path', () => {
    const result = resolveTaskExecutionDirectory(
      createTask({ workspace_path: '/task/workspace' }),
      createSession({ resolvedDirectory: '', defaultDirectory: '' })
    );

    expect(result).toEqual({
      directory: '/task/workspace',
      source: 'task.workspace_path',
    });
  });

  it('所有目录都缺失时返回 none', () => {
    const result = resolveTaskExecutionDirectory(
      createTask({ workspace_path: '   ' }),
      createSession({ resolvedDirectory: '', defaultDirectory: '' })
    );

    expect(result).toEqual({
      source: 'none',
    });
  });
});
