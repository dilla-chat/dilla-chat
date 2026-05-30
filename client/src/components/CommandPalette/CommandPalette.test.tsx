import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CommandPalette, { type PaletteCommand } from './CommandPalette';

function makeCommands(): PaletteCommand[] {
  return [
    { id: 'nav.design', label: 'Open #design', section: 'NAVIGATE', run: vi.fn() },
    { id: 'nav.dev', label: 'Open #dev', section: 'NAVIGATE', run: vi.fn() },
    { id: 'voice.join', label: 'Join #voice-lounge', section: 'VOICE', run: vi.fn() },
    { id: 'fed.status', label: 'Show peer status', section: 'FEDERATION', run: vi.fn() },
  ];
}

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <CommandPalette open={false} onClose={() => {}} commands={makeCommands()} />,
    );
    expect(container.querySelector('.command-palette')).not.toBeInTheDocument();
  });

  it('shows section labels and command items when open', () => {
    render(<CommandPalette open onClose={() => {}} commands={makeCommands()} />);
    expect(screen.getByText('NAVIGATE')).toBeInTheDocument();
    expect(screen.getByText('VOICE')).toBeInTheDocument();
    expect(screen.getByText('FEDERATION')).toBeInTheDocument();
    expect(screen.getByText('Open #design')).toBeInTheDocument();
    expect(screen.getByText('Join #voice-lounge')).toBeInTheDocument();
  });

  it('filters by query against label/section/hint', () => {
    render(<CommandPalette open onClose={() => {}} commands={makeCommands()} />);
    const input = screen.getByLabelText(/command query/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'voice' } });
    expect(screen.getByText('Join #voice-lounge')).toBeInTheDocument();
    expect(screen.queryByText('Open #design')).not.toBeInTheDocument();
  });

  it('shows empty state when no matches', () => {
    render(<CommandPalette open onClose={() => {}} commands={makeCommands()} />);
    const input = screen.getByLabelText(/command query/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzzzz' } });
    expect(screen.getByText(/no matching commands/i)).toBeInTheDocument();
  });

  it('ArrowDown + Enter runs second command and closes', () => {
    const commands = makeCommands();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={commands} />);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(commands[1].run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={makeCommands()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking an item runs and closes', () => {
    const commands = makeCommands();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={commands} />);
    fireEvent.click(screen.getByText('Open #design'));
    expect(commands[0].run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking the overlay closes', () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={makeCommands()} />);
    const overlay = screen.getByLabelText(/close command palette/i);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
