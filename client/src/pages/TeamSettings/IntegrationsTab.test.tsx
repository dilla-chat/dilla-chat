// Cover IntegrationsTab — giphy key save/clear flow.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  getGiphyIntegration: vi.fn(async () => ({ configured: false })),
  setGiphyApiKey: vi.fn(async () => ({ configured: true })),
}));
vi.mock('../../services/api', () => ({ api: apiMocks }));

import IntegrationsTab from './IntegrationsTab';

beforeEach(() => {
  apiMocks.getGiphyIntegration.mockClear();
  apiMocks.setGiphyApiKey.mockClear();
});

describe('IntegrationsTab', () => {
  it('renders + fetches integration status', async () => {
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(apiMocks.getGiphyIntegration).toHaveBeenCalledWith('t1'));
    expect(container.firstChild).toBeTruthy();
  });

  it('shows "not configured" badge initially', async () => {
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(container.textContent).toContain('not configured'));
  });

  it('shows "configured" badge when api returns true', async () => {
    apiMocks.getGiphyIntegration.mockResolvedValueOnce({ configured: true });
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(container.textContent).toContain('configured'));
  });

  it('typing in key field + Save calls api.setGiphyApiKey', async () => {
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(apiMocks.getGiphyIntegration).toHaveBeenCalled());
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gph_test_key' } });
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { fireEvent.click(saveBtn); await Promise.resolve(); });
    expect(apiMocks.setGiphyApiKey).toHaveBeenCalledWith('t1', 'gph_test_key');
  });

  it('Save button disabled when input is empty', async () => {
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(apiMocks.getGiphyIntegration).toHaveBeenCalled());
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('shows OK message after save success', async () => {
    apiMocks.setGiphyApiKey.mockResolvedValueOnce({ configured: true });
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(apiMocks.getGiphyIntegration).toHaveBeenCalled());
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'k' } });
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { fireEvent.click(saveBtn); await Promise.resolve(); });
    expect(container.textContent).toContain('Saved');
  });

  it('shows error on save failure', async () => {
    apiMocks.setGiphyApiKey.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(apiMocks.getGiphyIntegration).toHaveBeenCalled());
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'k' } });
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { fireEvent.click(saveBtn); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('forbidden');
  });

  it('Clear button appears when configured + calls setGiphyApiKey with empty', async () => {
    apiMocks.getGiphyIntegration.mockResolvedValueOnce({ configured: true });
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(container.textContent).toContain('Clear'));
    const clearBtn = [...container.querySelectorAll('button')].find((b) => /clear/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { fireEvent.click(clearBtn); await Promise.resolve(); });
    expect(apiMocks.setGiphyApiKey).toHaveBeenCalledWith('t1', '');
  });

  it('Clear error shows error message', async () => {
    apiMocks.getGiphyIntegration.mockResolvedValueOnce({ configured: true });
    apiMocks.setGiphyApiKey.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(container.textContent).toContain('Clear'));
    const clearBtn = [...container.querySelectorAll('button')].find((b) => /clear/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { fireEvent.click(clearBtn); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('forbidden');
  });

  it('handles getGiphyIntegration failure (gracefully sets not configured)', async () => {
    apiMocks.getGiphyIntegration.mockRejectedValueOnce(new Error('network'));
    const { container } = render(<IntegrationsTab teamId="t1" />);
    await waitFor(() => expect(container.textContent).toContain('not configured'));
  });
});
