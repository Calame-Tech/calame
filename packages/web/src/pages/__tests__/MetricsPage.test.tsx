// MetricsPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MetricsPage from '../MetricsPage.js';
import { installFetchMock, flushEffects } from './testUtils.js';

describe('MetricsPage', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the metrics header and dashboard', async () => {
    render(<MetricsPage setView={vi.fn()} />);
    expect(screen.getAllByText('Metrics').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Request volume, tool usage, and performance over time.')).toBeTruthy();
    await flushEffects();
    // MetricsDashboard header rendered after the summary fetch settled
    expect(screen.getByText('ANALYTICS')).toBeTruthy();
  });

  it('navigates back to the dashboard via the breadcrumb', async () => {
    const setView = vi.fn();
    render(<MetricsPage setView={setView} />);
    fireEvent.click(screen.getByText('Dashboard'));
    expect(setView).toHaveBeenCalledWith({ page: 'dashboard' });
    await flushEffects();
  });
});
