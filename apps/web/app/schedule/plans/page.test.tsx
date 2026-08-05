import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MonthlySchedulePlansPage from './page';

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn()
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return { ...original, api: apiMock };
});

vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  )
}));

const defaults = {
  coverageStartHour: 0,
  coverageEndHour: 24,
  blockHours: 4,
  maxSessionHours: 5,
  maxDailyHours: 5,
  minRestHours: 8,
  fullTimeMinMonthlyHours: 104,
  fullTimeMaxMonthlyHours: 130,
  morningStartHour: 8,
  morningEndHour: 12,
  overnightStartHour: 0,
  overnightEndHour: 6,
  strongScoreThreshold: 102,
  weakScoreThreshold: 98
};

const options = {
  rooms: [{ id: 'room-1', name: '柏瑞美-散粉' }],
  anchors: [
    { id: 'anchor-1', display_name: '陈莹', employment_type: 'UNKNOWN' }
  ],
  performanceScores: [
    {
      id: 'score-1',
      anchor_id: 'anchor-1',
      room_id: 'room-1',
      capability_score: 105.5,
      confidence_grade: 'A',
      sample_hours: 75,
      period_start: '2026-07-01',
      period_end: '2026-07-31',
      source_rank: 1,
      source_document: '【柏瑞美】散粉7月主播数据公平诊断.docx',
      adjusted_roi_index: 104.9,
      adjusted_hourly_gmv_index: 106.1,
      evidence_status: 'VERIFIED',
      anchor_name: '陈莹',
      room_name: '柏瑞美-散粉'
    }
  ],
  defaults,
  evidenceNotice: 'A/B参与软排序，C级仅观察。',
  automation: {
    enabled: true,
    dayOfMonth: 20,
    hour: 10,
    minute: 0,
    monthsAhead: 1,
    timezone: 'Asia/Shanghai',
    draftOnly: true
  }
};

const feasiblePrecheck = {
  feasible: true,
  month: '2026-08',
  strategy: 'BALANCED',
  dataAuthority: 'LOCAL_DATABASE',
  feishuRuntimeRequired: false,
  summary: {
    roomCount: 1,
    daysInMonth: 31,
    demandHours: 744,
    eligibleAnchorCount: 1,
    fullTimeAnchorCount: 0,
    minimumRequiredHours: 0,
    maximumCapacityHours: 744,
    unavailableExceptionCount: 0,
    crossBoundarySessionCount: 0
  },
  blockers: [],
  warnings: []
};

function details(status = 'DRAFT') {
  return {
    plan: {
      id: 'plan-1',
      schedule_month: '2026-08-01',
      status,
      rules_snapshot: defaults,
      generation_summary: {
        totalDemandSlots: 1,
        assignedSlots: 1,
        unfilledSlots: 0
      },
      validation_summary:
        status === 'DRAFT'
          ? {}
          : { errorCount: 0, warningCount: 0, checkedAt: '2026-08-01T00:00:00Z' },
      version: 1,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
      published_at: status === 'PUBLISHED' ? '2026-08-01T00:05:00Z' : null
    },
    slots: [
      {
        id: 'slot-1',
        room_id: 'room-1',
        room_name: '柏瑞美-散粉',
        starts_at: '2026-08-01T00:00:00+08:00',
        ends_at: '2026-08-01T04:00:00+08:00',
        required_anchor_count: 1,
        status: 'FILLED',
        assignment_id: 'assignment-1',
        anchor_id: 'anchor-1',
        anchor_name: '陈莹',
        employment_type: 'UNKNOWN',
        preference_tier: 'STRONG',
        reasons: ['能力档案支持该时段软排序'],
        warnings: [],
        assignment_version: 1,
        assignment_status: 'DRAFT',
        capability_score: 105.5,
        confidence_grade: 'A',
        sample_hours: 75,
        adjusted_roi_index: 104.9,
        adjusted_hourly_gmv_index: 106.1,
        evidence_status: 'VERIFIED',
        source_document: '【柏瑞美】散粉7月主播数据公平诊断.docx'
      }
    ],
    violations: [],
    anchorHours: [
      {
        anchor_id: 'anchor-1',
        display_name: '陈莹',
        employment_type: 'UNKNOWN',
        generated_hours: 4,
        existing_hours: 8,
        total_hours: 12
      }
    ]
  };
}

function summary(status = 'DRAFT') {
  return {
    id: 'plan-1',
    schedule_month: '2026-08-01',
    status,
    version: 1,
    generation_summary: {},
    validation_summary: {},
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    slot_count: 1,
    assignment_count: 1
  };
}

describe('MonthlySchedulePlansPage API contract', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('posts the generator controls using the backend DTO field names', async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/schedule-plans/options') return Promise.resolve(options);
      if (path.startsWith('/schedule-plans?')) {
        return Promise.resolve({ month: '2026-08', plans: [] });
      }
      if (path === '/schedule-plans/precheck' && init?.method === 'POST') {
        return Promise.resolve(feasiblePrecheck);
      }
      if (path === '/schedule-plans/generate' && init?.method === 'POST') {
        return Promise.resolve(details());
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MonthlySchedulePlansPage />);
    await screen.findByText(/暂无自动排班草案/);
    fireEvent.click(screen.getByRole('button', { name: '一键生成草案' }));

    await waitFor(() => {
      const call = apiMock.mock.calls.find(
        ([path, init]) =>
          path === '/schedule-plans/generate' && init?.method === 'POST'
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        roomIds: ['room-1'],
        coverageStartHour: 0,
        coverageEndHour: 24,
        blockHours: 4,
        existingSchedulePolicy: 'PRESERVE_EXISTING',
        strategy: 'BUSINESS'
      });
    });
  });

  it('keeps the draft assignment area visible for three-hour blocks and sends replacement policy', async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/schedule-plans/options') return Promise.resolve(options);
      if (path.startsWith('/schedule-plans?')) {
        return Promise.resolve({ month: '2026-08', plans: [] });
      }
      if (path === '/schedule-plans/precheck' && init?.method === 'POST') {
        return Promise.resolve(feasiblePrecheck);
      }
      if (path === '/schedule-plans/generate' && init?.method === 'POST') {
        return Promise.resolve(details());
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MonthlySchedulePlansPage />);
    expect(
      await screen.findByRole('heading', { name: '草案分配区' })
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('每段直播时长'), {
      target: { value: '3' }
    });
    expect(screen.getByText('3小时时段模式已启用')).toBeInTheDocument();
    expect(screen.getByText('草案分配区在下方')).toHaveAttribute(
      'href',
      '#draft-assignment'
    );
    fireEvent.click(
      screen.getByRole('radio', { name: /替换系统自动排班/ })
    );
    fireEvent.click(screen.getByRole('button', { name: '一键生成草案' }));

    await waitFor(() => {
      const call = apiMock.mock.calls.find(
        ([path, init]) =>
          path === '/schedule-plans/generate' && init?.method === 'POST'
      );
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        blockHours: 3,
        existingSchedulePolicy: 'REPLACE_AUTO_PLAN'
      });
    });
  });

  it('renders real evidence fields and does not mislabel unknown employment as part-time', async () => {
    const optionsUsingLegacyDraftField = {
      ...options,
      automation: {
        ...options.automation,
        draftOnly: undefined,
        onlyCreatesDraft: true
      }
    };
    apiMock.mockImplementation((path: string) => {
      if (path === '/schedule-plans/options') {
        return Promise.resolve(optionsUsingLegacyDraftField);
      }
      if (path.startsWith('/schedule-plans?')) {
        return Promise.resolve({ month: '2026-08', plans: [summary()] });
      }
      if (path === '/schedule-plans/plan-1') return Promise.resolve(details());
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MonthlySchedulePlansPage />);

    expect(await screen.findByText('ROI 104.9 · 小时GMV 106.1')).toBeInTheDocument();
    expect(
      screen.getByText('每月20日10:00自动生成下月草案，仅草案不自动发布')
    ).toBeInTheDocument();
    expect(screen.getByText('时区：Asia/Shanghai')).toBeInTheDocument();
    expect(screen.getAllByText(/用工类型待确认/).length).toBeGreaterThan(0);
    expect(screen.getByText('正式 8.0h + 草案 4.0h')).toBeInTheDocument();
    expect(screen.queryByText('无硬约束问题')).not.toBeInTheDocument();
    expect(screen.getByText('待校验')).toBeInTheDocument();
  });

  it('summarizes monthly hours and places over-limit and below-limit anchors first', async () => {
    const workloadDetails = details();
    workloadDetails.anchorHours = [
      {
        anchor_id: 'normal',
        display_name: '正常主播',
        employment_type: 'FULL_TIME',
        generated_hours: 110,
        existing_hours: 0,
        total_hours: 110
      },
      {
        anchor_id: 'below',
        display_name: '不足主播',
        employment_type: 'FULL_TIME',
        generated_hours: 80,
        existing_hours: 0,
        total_hours: 80
      },
      {
        anchor_id: 'over',
        display_name: '超额主播',
        employment_type: 'FULL_TIME',
        generated_hours: 140,
        existing_hours: 0,
        total_hours: 140
      }
    ];
    apiMock.mockImplementation((path: string) => {
      if (path === '/schedule-plans/options') return Promise.resolve(options);
      if (path.startsWith('/schedule-plans?')) {
        return Promise.resolve({ month: '2026-08', plans: [summary()] });
      }
      if (path === '/schedule-plans/plan-1') return Promise.resolve(workloadDetails);
      throw new Error(`Unexpected API call: ${path}`);
    });

    const { container } = render(<MonthlySchedulePlansPage />);
    await screen.findByText('超额主播');
    expect(screen.getByLabelText('主播月工时总览')).toHaveTextContent(
      '3已分配1低于下限1超过上限1全职达标'
    );
    const names = Array.from(
      container.querySelectorAll('.auto-plan-hours-list article > div:first-child strong')
    ).map((node) => node.textContent);
    expect(names).toEqual(['超额主播', '不足主播', '正常主播']);
  });

  it('blocks an empty preserved draft and guides the user to create a replacement draft', async () => {
    const emptyDraft = details();
    Object.assign(emptyDraft.plan.generation_summary, {
      totalDemandSlots: 0,
      assignedSlots: 0,
      unfilledSlots: 0,
      preservedExistingSlots: 744,
      existingSchedulePolicy: 'PRESERVE_EXISTING'
    });
    emptyDraft.slots = [];
    emptyDraft.anchorHours = [];
    apiMock.mockImplementation((path: string) => {
      if (path === '/schedule-plans/options') return Promise.resolve(options);
      if (path.startsWith('/schedule-plans?')) {
        return Promise.resolve({ month: '2026-08', plans: [summary()] });
      }
      if (path === '/schedule-plans/plan-1') return Promise.resolve(emptyDraft);
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MonthlySchedulePlansPage />);

    expect(
      await screen.findByText('旧正式排班占用了 744 个候选时段，当前草案没有可调整内容。')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新校验' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '发布正式排班' })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: '改为替换系统自动排班' })
    );
    expect(
      screen.getByRole('radio', { name: /替换系统自动排班/ })
    ).toBeChecked();
  });

  it('keeps manual generation usable when the automation field is absent', async () => {
    const optionsWithoutAutomation = { ...options, automation: undefined };
    apiMock.mockImplementation((path: string) => {
      if (path === '/schedule-plans/options') {
        return Promise.resolve(optionsWithoutAutomation);
      }
      if (path.startsWith('/schedule-plans?')) {
        return Promise.resolve({ month: '2026-08', plans: [] });
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MonthlySchedulePlansPage />);

    expect(await screen.findByText('自动生成未启用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键生成草案' })).toBeEnabled();
  });

  it('saves editable automation settings with the exact backend contract and refreshes options', async () => {
    let currentOptions = options;
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/schedule-plans/options') return Promise.resolve(currentOptions);
      if (path.startsWith('/schedule-plans?')) {
        return Promise.resolve({ month: '2026-08', plans: [] });
      }
      if (path === '/schedule-plans/automation' && init?.method === 'PATCH') {
        const payload = JSON.parse(String(init.body));
        currentOptions = {
          ...currentOptions,
          automation: {
            ...payload,
            timezone: 'Asia/Shanghai',
            draftOnly: true
          }
        };
        return Promise.resolve(currentOptions.automation);
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MonthlySchedulePlansPage />);
    await screen.findByText('每月20日10:00自动生成下月草案，仅草案不自动发布');
    fireEvent.click(screen.getByRole('button', { name: '设置自动生成' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /启用每月自动生成/ }));
    fireEvent.change(screen.getByLabelText('每月日期'), {
      target: { value: '21' }
    });
    fireEvent.change(screen.getByLabelText('执行小时'), {
      target: { value: '17' }
    });
    fireEvent.change(screen.getByLabelText('执行分钟'), {
      target: { value: '30' }
    });
    fireEvent.change(screen.getByLabelText('生成目标'), {
      target: { value: '2' }
    });
    fireEvent.click(
      screen.getByRole('button', { name: '保存自动生成设置' })
    );

    await waitFor(() => {
      const saveCall = apiMock.mock.calls.find(
        ([path, init]) =>
          path === '/schedule-plans/automation' && init?.method === 'PATCH'
      );
      expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
        enabled: false,
        dayOfMonth: 21,
        hour: 17,
        minute: 30,
        monthsAhead: 2
      });
      expect(
        apiMock.mock.calls.filter(([path]) => path === '/schedule-plans/options')
      ).toHaveLength(2);
    });

    expect(
      await screen.findByText(
        '自动生成设置已保存；系统只会按时生成草案，不会自动发布。'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('自动生成未启用')).toBeInTheDocument();
  });

  it('supports validate then confirm-publish with the route contract', async () => {
    let current = details();
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/schedule-plans/options') return Promise.resolve(options);
      if (path.startsWith('/schedule-plans?')) {
        return Promise.resolve({
          month: '2026-08',
          plans: [summary(current.plan.status)]
        });
      }
      if (path === '/schedule-plans/plan-1' && !init?.method) {
        return Promise.resolve(current);
      }
      if (path === '/schedule-plans/plan-1/validate' && init?.method === 'POST') {
        current = details('VALIDATED');
        return Promise.resolve(current);
      }
      if (path === '/schedule-plans/plan-1/publish' && init?.method === 'POST') {
        current = details('PUBLISHED');
        return Promise.resolve(current);
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(<MonthlySchedulePlansPage />);
    fireEvent.click(await screen.findByRole('button', { name: '重新校验' }));

    const publishButton = await screen.findByRole('button', {
      name: '发布正式排班'
    });
    await waitFor(() => expect(publishButton).toBeEnabled());
    fireEvent.click(publishButton);
    expect(screen.getByRole('heading', { name: '确认发布 2026-08 排班？' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/schedule-plans/plan-1/publish',
        { method: 'POST', body: '{}' }
      );
    });
  });
});
