import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders a specific no-data reason without inventing records', () => {
    render(
      <EmptyState
        title="暂无排班"
        description="完成飞书字段映射后显示真实记录。"
      />
    );
    expect(screen.getByText('暂无排班')).toBeInTheDocument();
    expect(screen.getByText('完成飞书字段映射后显示真实记录。')).toBeInTheDocument();
  });
});
