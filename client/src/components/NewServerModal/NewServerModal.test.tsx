import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NewServerModal from './NewServerModal';

describe('NewServerModal', () => {
  it('renders nothing when closed', () => {
    render(<NewServerModal open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('defaults to Join mode', () => {
    render(<NewServerModal open onClose={() => {}} />);
    expect(screen.getByLabelText(/server url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invite token/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/team name/i)).not.toBeInTheDocument();
  });

  it('switching to Create shows team name field', () => {
    render(<NewServerModal open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^create$/i }));
    expect(screen.getByLabelText(/team name/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/invite token/i)).not.toBeInTheDocument();
  });

  it('Join submit calls onJoin with payload and closes', () => {
    const onJoin = vi.fn();
    const onClose = vi.fn();
    render(<NewServerModal open onClose={onClose} onJoin={onJoin} />);
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'https://gbg-1.dilla.local' },
    });
    fireEvent.change(screen.getByLabelText(/invite token/i), {
      target: { value: 'token-abc' },
    });
    fireEvent.click(screen.getByText(/join →/i));
    expect(onJoin).toHaveBeenCalledWith({
      serverUrl: 'https://gbg-1.dilla.local',
      invite: 'token-abc',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Create submit calls onCreate with payload', () => {
    const onCreate = vi.fn();
    render(<NewServerModal open onClose={() => {}} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('tab', { name: /^create$/i }));
    fireEvent.change(screen.getByLabelText(/team name/i), {
      target: { value: 'berralitos' },
    });
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'https://gbg-1.dilla.local' },
    });
    fireEvent.click(screen.getByText(/create →/i));
    expect(onCreate).toHaveBeenCalledWith({
      name: 'berralitos',
      serverUrl: 'https://gbg-1.dilla.local',
    });
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(<NewServerModal open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('submit button disabled until fields are filled', () => {
    render(<NewServerModal open onClose={() => {}} />);
    const submit = screen.getByText(/join →/i);
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'x' },
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/invite token/i), {
      target: { value: 'y' },
    });
    expect(submit).not.toBeDisabled();
  });
});
