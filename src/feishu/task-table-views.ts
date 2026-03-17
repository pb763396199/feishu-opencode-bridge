import { TASK_FIELDS } from '../config/bitable-fields.js';

interface TaskTableViewApi {
  listViews(appToken: string, tableId: string): Promise<Array<{ view_id: string; view_name: string; view_type: string }>>;
  listFieldsWithId(appToken: string, tableId: string): Promise<Array<{ field_id: string; field_name: string }>>;
  createView(appToken: string, tableId: string, viewName: string, viewType: 'grid' | 'kanban' | 'gallery' | 'gantt'): Promise<{ view_id: string } | null>;
  setViewHiddenFields(appToken: string, tableId: string, viewId: string, hiddenFieldIds: string[]): Promise<boolean>;
  setKanbanGroupField(appToken: string, tableId: string, viewId: string, groupFieldId: string): Promise<boolean>;
}

const HIDDEN_FIELD_NAMES = new Set<string>([
  TASK_FIELDS.closed_at,
  TASK_FIELDS.status_updated_at,
  TASK_FIELDS.unblocked_at,
  TASK_FIELDS.updated_at,
  TASK_FIELDS.task_id,
  TASK_FIELDS.project_id,
  TASK_FIELDS.chat_id,
  TASK_FIELDS.opencode_session_id,
  TASK_FIELDS.creator_open_id,
  TASK_FIELDS.archived,
  TASK_FIELDS.archived_at,
]);

export async function ensureTaskTableViews(api: TaskTableViewApi, appToken: string, taskTableId: string): Promise<void> {
  try {
    const existingViews = await api.listViews(appToken, taskTableId);
    const allFields = await api.listFieldsWithId(appToken, taskTableId);

    const gridView = existingViews.find(view => view.view_type === 'grid');
    if (gridView) {
      const hiddenFieldIds = allFields
        .filter(field => HIDDEN_FIELD_NAMES.has(field.field_name))
        .map(field => field.field_id);
      if (hiddenFieldIds.length > 0) {
        await api.setViewHiddenFields(appToken, taskTableId, gridView.view_id, hiddenFieldIds);
      }
    }

    const existingKanban = existingViews.find(view => view.view_type === 'kanban');
    const kanbanView = existingKanban ?? await api.createView(appToken, taskTableId, '状态看板', 'kanban');
    if (!kanbanView) {
      return;
    }

    const statusField = allFields.find(field => field.field_name === TASK_FIELDS.status);
    if (!statusField) {
      return;
    }

    await api.setKanbanGroupField(appToken, taskTableId, kanbanView.view_id, statusField.field_id);
  } catch (error) {
    console.warn('[Bitable] 初始化任务表视图失败（非致命）:', error);
  }
}
