// src/types/task.ts
import type { TaskStatus, BlockedReason, TaskTopic, TaskPriority } from '../config/bitable-fields.js';

export interface Task {
  // A. 决策概览（冻结列）
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  health: 'GREEN' | 'YELLOW' | 'RED';
  blocked_reason: BlockedReason | null;
  assignee: string;  // 飞书用户 open_id
  topic: TaskTopic | null;
  
  // B. 行动与跳转
  chat_link: string;
  description: string | null;
  workspace_path: string;
  working_branch: string | null;
  
  // C. 时间与节奏
  started_at: Date | null;
  done_at: Date | null;
  created_at: Date;
  closed_at: Date | null;
  status_updated_at: Date;
  unblocked_at: Date | null;
  blocked_history: string | null;  // JSON 数组字符串
  followup_task_id: string | null;
  updated_at: Date;
  
  // D. 交付物
  deliverable_summary: string | null;
  deliverable_md: string | null;
  
  // E. 系统与快照（隐藏）
  task_id: string;
  project_id: string | null;
  chat_id: string;
  opencode_session_id: string;
  creator_open_id: string;
  sync_last_message_id: string | null;
  sync_last_push_at: Date | null;
  git_diffstat: string | null;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
  git_commits: string | null;
  git_base_commit: string | null;
  hidden: boolean;
  archived_at: Date | null;
  failure_step: string | null;
}

export interface Project {
  project_id: string;
  name: string;
  repo_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  workspace_path: string;
  creator_open_id: string;
  project_name?: string;
}

export interface TaskFilter {
  status?: TaskStatus[];
  priority?: TaskPriority[];
  hidden?: boolean;
  project_id?: string;
  creator_open_id?: string;
}

export interface BlockedHistoryEntry {
  timestamp: string;
  action: 'blocked' | 'unblocked';
  reason?: BlockedReason;
  message?: string;
}
