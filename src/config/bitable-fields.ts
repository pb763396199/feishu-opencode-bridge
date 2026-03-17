// src/config/bitable-fields.ts
// 唯一真实来源：飞书中文列名 ↔ 代码英文字段名

/**
 * 多维表格字段结构版本号。
 *
 * 规则：仅当飞书表格字段有增删改时才递增，与应用版本号无关。
 * Bootstrap 创建表格时写入此版本号；服务启动健康检查时，
 * 若检测到 description.schema_version < BITABLE_SCHEMA_VERSION，
 * 自动执行字段迁移（补建缺失字段）。
 *
 * 历史：
 *   1 - 初始版本（v2.3，31个任务字段 + 5个项目字段）
 *   2 - v3.0：删除 INBOX/BACKLOG，新增 IN_REVIEW（错误：状态标签使用英文）
 *   3 - v3.0修正：状态标签改回中文（待执行/进行中/被阻塞/待验收/已完成/已取消）
 *   4 - P1 收口：删除 health，assignee 重命名为 execution_agent，hidden 重命名为 archived
 *   5 - P2：项目总表扩展字段，支持每项目独立任务表
 */
export const BITABLE_SCHEMA_VERSION = '5';

export const PROJECT_FIELDS = {
  project_id:              '项目ID',
  name:                    '项目名称',
  repo_url:                '仓库地址',
  task_table_id:           '任务表ID',           // P2: 该项目专属任务表的 table_id
  default_execution_agent: '默认执行Agent',       // P2: 该项目任务的默认执行 Agent
  workspace_paths:         '工作目录配置',       // P2: 该项目可用的工作目录（JSON）
  created_at:              '创建时间',
  updated_at:              '更新时间',
} as const;

export const TASK_FIELDS = {
  // A. 决策概览（冻结列）
  title:           '任务名称',
  status:          '状态',
  priority:        '优先级',
  blocked_reason:  '阻塞原因',
  execution_agent: '执行Agent',
  // B. 行动与跳转
  chat_link:       '群聊链接',
  description:     '任务内容',
  workspace_path:  '工作目录',
  // C. 时间与节奏
  started_at:         '开始时间',
  done_at:            '完成时间',
  created_at:         '创建时间',
  closed_at:          '群解散时间',
  status_updated_at:  '状态更新时间',
  unblocked_at:       '解除阻塞时间',
  updated_at:         '更新时间',
  // D. 交付物
  deliverable_summary: '交付摘要',
  // E. 系统与快照（隐藏）
  task_id:               '任务ID',
  project_id:            '项目ID',
  chat_id:               '群组ID',
  opencode_session_id:   '会话ID',
  creator_open_id:       '创建者ID',
  archived:              '是否归档',
  archived_at:           '归档时间',
} as const;

export const TASK_STATUS_LABELS = {
  TODO:        '待执行',
  IN_PROGRESS: '进行中',
  BLOCKED:     '被阻塞',
  IN_REVIEW:   '待验收',
  DONE:        '已完成',
  CANCELLED:   '已取消',
} as const;

export const BLOCKED_REASON_LABELS = {
  question_asked:   '等待回答',
  permission_asked: '等待授权',
} as const;

export const TASK_TOPIC_LABELS = {
  feature:       '新功能',
  bugfix:        '缺陷修复',
  refactor:      '重构',
  performance:   '性能优化',
  test:          '测试',
  research:      '调研',
  documentation: '文档',
  chore:         '维护',
} as const;

export const TASK_PRIORITY_LABELS = {
  urgent: '紧急',
  high:   '高',
  medium: '中',
  low:    '低',
} as const;

export type TaskStatus = keyof typeof TASK_STATUS_LABELS;
export type BlockedReason = keyof typeof BLOCKED_REASON_LABELS;
export type TaskTopic = keyof typeof TASK_TOPIC_LABELS;
export type TaskPriority = keyof typeof TASK_PRIORITY_LABELS;
