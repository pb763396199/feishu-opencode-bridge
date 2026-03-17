// src/types/task.ts
import type { TaskStatus, BlockedReason, TaskTopic, TaskPriority } from '../config/bitable-fields.js';

export interface Task {
  // A. 决策概览（冻结列）
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  blocked_reason: BlockedReason | null;
  execution_agent: string;
  
  // B. 行动与跳转
  chat_link: string;
  description: string | null;
  workspace_path: string;
  
  // C. 时间与节奏
  started_at: Date | null;
  done_at: Date | null;
  created_at: Date;
  closed_at: Date | null;
  status_updated_at: Date;
  unblocked_at: Date | null;
  updated_at: Date;
  
  // D. 交付物
  deliverable_summary: string | null;
  
  // E. 系统与快照（隐藏）
  task_id: string;
  project_id: string | null;
  chat_id: string;
  opencode_session_id: string;
  creator_open_id: string;
  archived: boolean;
  archived_at: Date | null;
}

export interface Project {
  project_id: string;
  name: string;
  repo_url: string | null;
  task_table_id: string | null;           // P2: 该项目专属任务表的 table_id
  default_execution_agent: string | null; // P2: 该项目任务的默认执行 Agent
  workspace_paths: string[] | null;       // P2: 该项目可用的工作目录列表
  created_at: Date;
  updated_at: Date;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  workspace_path: string;
  creator_open_id: string;
  project_id?: string;
  project_name?: string;
  execution_agent?: string;  // P2-A: 允许显式指定执行Agent（覆盖项目配置）
}

export interface TaskFilter {
  status?: TaskStatus[];
  priority?: TaskPriority[];
  archived?: boolean;
  project_id?: string;
  creator_open_id?: string;
}

export interface BlockedHistoryEntry {
  timestamp: string;
  action: 'blocked' | 'unblocked';
  reason?: BlockedReason;
  message?: string;
}
