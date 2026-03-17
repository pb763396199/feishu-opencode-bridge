import { describe, it, expect } from 'vitest';
import { buildCreateTaskCard, type CreateTaskCardData, type ProjectOption } from '../../src/feishu/cards.js';

/**
 * P2-A 工作空间可见性测试：验证项目选择驱动的工作空间选项
 *
 * 模型对齐（P2-A闭环）：
 * - 项目（Project）= 任务容器（routing单位），决定任务归属和路由
 * - 工作空间（Workspace）= 执行实例（worktree/branch/version），是任务运行的具体目录
 *
 * 测试覆盖：
 * 1. 有 workspace_paths 配置的项目，卡片只显示项目专属工作目录
 * 2. 无配置项目，卡片显示全局工作目录（向后兼容）
 * 3. 混合场景：部分项目有配置，部分无
 * 4. 手动输入选项始终可用
 * 5. 卡片标签语义：项目标签强调任务归属，工作空间标签强调执行目录
 */

describe('P2-A: 项目驱动的工作空间可见性', () => {
  describe('buildCreateTaskCard - 工作空间选项渲染', () => {
    it('选择项目前不应伪装成已按项目筛选，也不应混合展示所有项目工作空间', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_frontend',
          name: 'Frontend',
          workspacePaths: ['/workspace/frontend/src', '/workspace/frontend/docs'],
          defaultExecutionAgent: null,
        },
        {
          projectId: 'proj_backend',
          name: 'Backend',
          workspacePaths: ['/workspace/backend/api'],
          defaultExecutionAgent: null,
        },
      ];

      const data: CreateTaskCardData = {
        workspacePaths: ['/global/path1', '/global/path2'],
        projectNames: ['Frontend', 'Backend'],
        projects,
      };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      expect(workspaceSelect).toBeDefined();
      expect(workspaceSelect.label.content).not.toContain('【已按项目筛选】');
      expect(workspaceSelect.placeholder.content).toBe('请先选择项目，再选择执行工作空间...');
      expect(workspaceSelect.options).toHaveLength(1);
      expect(workspaceSelect.options[0].value).toBe('__manual__');
    });

    it('选中有配置的项目后，应只显示该项目的执行工作空间', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_frontend',
          name: 'Frontend',
          workspacePaths: ['/workspace/frontend/src', '/workspace/frontend/docs'],
          defaultExecutionAgent: null,
        },
        {
          projectId: 'proj_backend',
          name: 'Backend',
          workspacePaths: ['/workspace/backend/api'],
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: ['/global/path1', '/global/path2'],
        projectNames: ['Frontend', 'Backend'],
        projects,
        selectedProjectId: 'proj_backend',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      expect(workspaceSelect).toBeDefined();
      expect(workspaceSelect.label.content).toContain('【已按项目筛选】');
      expect(workspaceSelect.options).toHaveLength(2);
      expect(workspaceSelect.options[1].value).toBe('/workspace/backend/api');
      expect(workspaceSelect.options[1].text.content).toContain('[Backend]');
      expect(workspaceSelect.options[1].text.content).not.toContain('[Frontend]');
    });

    it('选中无配置项目后，应回退显示全局工作目录，而不是其他项目目录', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_configured',
          name: 'Configured',
          workspacePaths: ['/workspace/configured'],
          defaultExecutionAgent: null,
        },
        {
          projectId: 'proj_legacy',
          name: 'Legacy',
          workspacePaths: null,
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: ['/global/path1', '/global/path2'],
        projectNames: ['Configured', 'Legacy'],
        projects,
        selectedProjectId: 'proj_legacy',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      expect(workspaceSelect).toBeDefined();
      expect(workspaceSelect.label.content).not.toContain('【已按项目筛选】');
      expect(workspaceSelect.options).toHaveLength(3);
      const optionTexts = workspaceSelect.options.slice(1).map((o: any) => o.text.content);
      expect(optionTexts).toEqual(['/global/path1', '/global/path2']);
      expect(optionTexts.some((text: string) => text.includes('[Configured]'))).toBe(false);
    });

    it('当项目有 workspace_paths 配置时，应只显示项目专属工作目录', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_frontend',
          name: 'Frontend',
          workspacePaths: ['/workspace/frontend/src', '/workspace/frontend/docs'],
          defaultExecutionAgent: null,
        },
        {
          projectId: 'proj_backend',
          name: 'Backend',
          workspacePaths: ['/workspace/backend/api'],
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: ['/global/path1', '/global/path2'], // 全局路径不应被显示
        projectNames: ['Frontend', 'Backend'],
        projects,
        selectedProjectId: 'proj_frontend',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      expect(workspaceSelect).toBeDefined();
      expect(workspaceSelect.options).toHaveLength(3); // 手动输入 + 当前项目2个路径

      // 第一个选项应该是手动输入
      expect(workspaceSelect.options[0].value).toBe('__manual__');

      // 其他选项应该带项目标签
      const pathOptions = workspaceSelect.options.slice(1);
      expect(pathOptions.some((o: any) => o.text.content.includes('[Frontend]'))).toBe(true);
      expect(pathOptions.some((o: any) => o.text.content.includes('[Backend]'))).toBe(false);
      expect(pathOptions.some((o: any) => o.text.content.includes('/workspace/frontend/src'))).toBe(true);
      expect(pathOptions.some((o: any) => o.text.content.includes('/workspace/backend/api'))).toBe(false);

      // 不应该包含全局路径
      expect(pathOptions.some((o: any) => o.text.content.includes('/global/path1'))).toBe(false);
      expect(pathOptions.some((o: any) => o.text.content.includes('/global/path2'))).toBe(false);
    });

    it('当项目无 workspace_paths 配置时，应显示全局工作目录（向后兼容）', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_project_a',
          name: 'ProjectA',
          workspacePaths: null,
          defaultExecutionAgent: null,
        },
        {
          projectId: 'proj_project_b',
          name: 'ProjectB',
          workspacePaths: [], // 空数组也视为无配置
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: ['/global/path1', '/global/path2'],
        projectNames: ['ProjectA', 'ProjectB'],
        projects,
        selectedProjectId: 'proj_project_a',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      expect(workspaceSelect).toBeDefined();
      expect(workspaceSelect.options).toHaveLength(3); // 手动输入 + 2个全局路径

      // 应该显示全局路径（不带项目标签）
      const pathOptions = workspaceSelect.options.slice(1);
      expect(pathOptions.some((o: any) => o.text.content.includes('/global/path1'))).toBe(true);
      expect(pathOptions.some((o: any) => o.text.content.includes('/global/path2'))).toBe(true);

      // 不应该有项目标签
      expect(pathOptions.some((o: any) => o.text.content.includes('[ProjectA]'))).toBe(false);
    });

    it('混合场景：部分项目有配置，应只显示有配置项目的工作目录', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_configured',
          name: 'Configured',
          workspacePaths: ['/workspace/configured'],
          defaultExecutionAgent: 'agent-1',
        },
        {
          projectId: 'proj_not_configured',
          name: 'NotConfigured',
          workspacePaths: null,
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: ['/fallback/path'],
        projectNames: ['Configured', 'NotConfigured'],
        projects,
        selectedProjectId: 'proj_configured',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      expect(workspaceSelect).toBeDefined();
      // 应该显示 Configured 项目的目录，而不是全局路径
      expect(workspaceSelect.options.some((o: any) => o.text.content.includes('[Configured]'))).toBe(true);
      expect(workspaceSelect.options.some((o: any) => o.text.content.includes('/workspace/configured'))).toBe(true);
      // 不应该显示全局回退路径
      expect(workspaceSelect.options.some((o: any) => o.text.content.includes('/fallback/path'))).toBe(false);
    });

    it('应正确标记项目专属工作目录（带项目名称前缀）', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_my_project',
          name: 'MyProject',
          workspacePaths: ['/workspace/myproject'],
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: [],
        projectNames: ['MyProject'],
        projects,
        selectedProjectId: 'proj_my_project',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      const pathOption = workspaceSelect.options.find((o: any) => o.value === '/workspace/myproject');
      expect(pathOption).toBeDefined();
      expect(pathOption.text.content).toBe('[MyProject] /workspace/myproject');
    });

    it('应显示项目筛选提示标签（当有配置项目时）', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_project',
          name: 'Project',
          workspacePaths: ['/workspace/project'],
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: ['/global'],
        projectNames: ['Project'],
        projects,
        selectedProjectId: 'proj_project',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      // 标签应包含"已按项目筛选"提示
      expect(workspaceSelect.label.content).toContain('【已按项目筛选】');
      expect(workspaceSelect.placeholder.content).toBe('选择该项目下的执行工作空间...');
    });

    it('无配置项目时应显示标准标签（向后兼容）', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_legacy',
          name: 'Legacy',
          workspacePaths: null,
          defaultExecutionAgent: null,
        },
      ];

      const data: CreateTaskCardData = {
        workspacePaths: ['/global/path'],
        projectNames: ['Legacy'],
        projects,
      };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      // 标签不应包含"已按项目筛选"
      expect(workspaceSelect.label.content).not.toContain('【已按项目筛选】');
      expect(workspaceSelect.placeholder.content).toBe('选择执行工作空间...');
    });

    it('手动输入选项应始终可用', () => {
      const data: CreateTaskCardData = {
        workspacePaths: ['/path1'],
        projectNames: ['Project'],
        projects: [
          {
            projectId: 'proj_project',
            name: 'Project',
            workspacePaths: ['/path2'],
            defaultExecutionAgent: null,
          },
        ],
      };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      // 第一个选项应该是手动输入
      expect(workspaceSelect.options[0].value).toBe('__manual__');
      expect(workspaceSelect.options[0].text.content).toBe('📝 手动输入路径');
    });

    it('应正确处理 Windows 路径（反斜杠转义）', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_windows',
          name: 'WindowsProject',
          workspacePaths: ['C:\\Users\\Dev\\Project'],
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: [],
        projectNames: ['WindowsProject'],
        projects,
        selectedProjectId: 'proj_windows',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      // 显示路径应该使用正斜杠
      const pathOption = workspaceSelect.options.find((o: any) => o.value === 'C:\\Users\\Dev\\Project');
      expect(pathOption.text.content).toBe('[WindowsProject] C:/Users/Dev/Project');
      // 但 value 应该保持原始路径
      expect(pathOption.value).toBe('C:\\Users\\Dev\\Project');
    });

    it('无工作目录选项时不应渲染下拉框', () => {
      const data: CreateTaskCardData = {
        workspacePaths: [],
        projectNames: ['Project'],
        projects: [
          {
            projectId: 'proj_project',
            name: 'Project',
            workspacePaths: [],
            defaultExecutionAgent: null,
          },
        ],
      };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      // 当没有工作目录选项时，不应该渲染下拉框
      expect(workspaceSelect).toBeUndefined();
    });
  });

  describe('workspacePathsByProject - 数据流传递', () => {
    it('应支持通过 workspacePathsByProject 传递项目工作目录映射', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_project1',
          name: 'Project1',
          workspacePaths: ['/workspace/p1'],
          defaultExecutionAgent: null,
        },
      ];

      const data: CreateTaskCardData = {
        workspacePaths: ['/fallback'],
        projectNames: ['Project1'],
        projects,
        workspacePathsByProject: {
          proj_project1: ['/workspace/p1'],
        },
      };

      // 验证数据能被正确传递（不抛出错误）
      const card = buildCreateTaskCard(data) as any;
      expect(card).toBeDefined();
    });
  });

  describe('P2-A闭环: 卡片标签语义验证（项目=容器，工作空间=执行实例）', () => {
    it('项目选择器标签应强调任务归属和路由（而非工作目录配置）', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_test_project',
          name: 'TestProject',
          workspacePaths: ['/workspace/test'],
          defaultExecutionAgent: null,
        },
      ];

      const data: CreateTaskCardData = {
        workspacePaths: [],
        projectNames: ['TestProject'],
        projects,
      };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const projectSelect = formElement.elements.find((e: any) => e.name === 'project_select');

      // 标签应强调项目是任务归属和路由单位
      expect(projectSelect.label.content).toContain('任务归属与路由单位');
      // 不应包含暗示1:1绑定的表述
      expect(projectSelect.label.content).not.toContain('选择后将使用项目配置的工作目录');
    });

    it('工作空间选择器标签应强调执行实例语义（任务运行目录）', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_test_project',
          name: 'TestProject',
          workspacePaths: ['/workspace/test'],
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: ['/global/path'],
        projectNames: ['TestProject'],
        projects,
        selectedProjectId: 'proj_test_project',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      // 标签应强调工作空间是执行实例
      expect(workspaceSelect.label.content).toContain('执行工作空间');
      expect(workspaceSelect.label.content).toContain('任务运行目录');
      // 不应是简单的"工作目录"
      expect(workspaceSelect.label.content).not.toBe('📂 工作目录');
    });

    it('工作空间手动输入框占位符应说明是代码运行目录', () => {
      const data: CreateTaskCardData = {
        workspacePaths: ['/path'],
        projectNames: ['Project'],
        projects: [
          {
            projectId: 'proj_project',
            name: 'Project',
            workspacePaths: null,
            defaultExecutionAgent: null,
          },
        ],
      };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceInput = formElement.elements.find((e: any) => e.name === 'workspace_path');

      // 占位符应明确说明是执行工作空间和代码运行目录
      expect(workspaceInput.placeholder.content).toContain('执行工作空间');
      expect(workspaceInput.placeholder.content).toContain('代码运行目录');
    });

    it('项目选项应显示执行工作空间数量（而非工作目录数量）', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_with_workspaces',
          name: 'ProjectWithWorkspaces',
          workspacePaths: ['/workspace/a', '/workspace/b', '/workspace/c'],
          defaultExecutionAgent: null,
        },
        {
          projectId: 'proj_without_workspaces',
          name: 'ProjectWithoutWorkspaces',
          workspacePaths: null,
          defaultExecutionAgent: null,
        },
      ];

      const data: CreateTaskCardData = {
        workspacePaths: [],
        projectNames: ['ProjectWithWorkspaces', 'ProjectWithoutWorkspaces'],
        projects,
      };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const projectSelect = formElement.elements.find((e: any) => e.name === 'project_select');

      // 查找带工作空间的项目选项
      const workspaceProjectOption = projectSelect.options.find(
        (o: any) => o.text.content.includes('ProjectWithWorkspaces')
      );
      const noWorkspaceProjectOption = projectSelect.options.find(
        (o: any) => o.text.content.includes('ProjectWithoutWorkspaces')
      );

      // 有配置的项目应显示"3个执行工作空间"
      expect(workspaceProjectOption.text.content).toContain('3个执行工作空间');
      // 无配置的项目不应有数量后缀
      expect(noWorkspaceProjectOption.text.content).not.toContain('个');
    });

    it('有项目配置时工作空间下拉占位符应强调项目筛选', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_scoped',
          name: 'ScopedProject',
          workspacePaths: ['/workspace/scoped'],
          defaultExecutionAgent: null,
        },
      ];

      const data = {
        workspacePaths: ['/global/path'],
        projectNames: ['ScopedProject'],
        projects,
        selectedProjectId: 'proj_scoped',
      } as CreateTaskCardData & { selectedProjectId: string };

      const card = buildCreateTaskCard(data) as any;
      const formElement = card.elements.find((e: any) => e.tag === 'form');
      const workspaceSelect = formElement.elements.find((e: any) => e.name === 'workspace_select');

      // 标签应包含【已按项目筛选】标记
      expect(workspaceSelect.label.content).toContain('【已按项目筛选】');
      // 占位符应强调在项目下选择
      expect(workspaceSelect.placeholder.content).toBe('选择该项目下的执行工作空间...');
    });

    it('卡片不应包含暗示项目与工作空间1:1绑定的表述', () => {
      const projects: ProjectOption[] = [
        {
          projectId: 'proj_a',
          name: 'ProjectA',
          workspacePaths: ['/workspace/a'],
          defaultExecutionAgent: null,
        },
        {
          projectId: 'proj_b',
          name: 'ProjectB',
          workspacePaths: ['/workspace/b1', '/workspace/b2'],
          defaultExecutionAgent: null,
        },
      ];

      const data: CreateTaskCardData = {
        workspacePaths: ['/global'],
        projectNames: ['ProjectA', 'ProjectB'],
        projects,
      };

      const card = buildCreateTaskCard(data) as any;
      const cardStr = JSON.stringify(card);

      // 不应有暗示1:1绑定的表述
      expect(cardStr).not.toContain('项目专属工作目录');
      expect(cardStr).not.toContain('项目的工作目录');
      expect(cardStr).not.toContain('所属项目的工作目录');

      // 应使用强调执行实例的表述
      expect(cardStr).toContain('执行工作空间');
    });
  });
});
