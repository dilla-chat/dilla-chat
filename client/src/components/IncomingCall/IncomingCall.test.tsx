import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import IncomingCall from './IncomingCall';

describe('IncomingCall', () => {
  it('renders nothing when closed', () => {
    render(
      <IncomingCall
        open={false}
        callerName="Ada"
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('renders caller name + INCOMING CALL status + initial', () => {
    render(
      <IncomingCall
        open
        callerName="Ada Lovelace"
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/incoming call/i)).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('Accept button + Enter key both call onAccept', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    render(
      <IncomingCall
        open
        callerName="Ada"
        onAccept={onAccept}
        onDecline={onDecline}
      />,
    );
    fireEvent.click(screen.getByTitle(/accept/i));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onAccept).toHaveBeenCalledTimes(2);
  });

  it('Decline button + Escape key both call onDecline', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    render(
      <IncomingCall
        open
        callerName="Ada"
        onAccept={onAccept}
        onDecline={onDecline}
      />,
    );
    fireEvent.click(screen.getByTitle(/decline/i));
    expect(onDecline).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDecline).toHaveBeenCalledTimes(2);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('shows channel name when provided', () => {
    render(
      <IncomingCall
        open
        callerName="Ada"
        channelName="voice-lounge"
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(screen.getByText(/voice-lounge/i)).toBeInTheDocument();
  });

  it('uses callerInitial prop when provided (overrides callerName first char)', () => {
    render(
      <IncomingCall
        open
        callerName="Ada"
        callerInitial="X"
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(screen.getByText('X')).toBeInTheDocument();
    // The default 'A' (from callerName) should NOT appear as a tile.
  });

  it('renders avatar with callerColor background when provided', () => {
    // The component renders via createPortal into document.body, so the
    // RTL container is empty — query the document instead.
    render(
      <IncomingCall
        open
        callerName="Ada"
        callerColor="#ff0099"
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    const avatar = document.querySelector('.incoming-call-avatar') as HTMLElement;
    expect(avatar).toBeTruthy();
    expect(avatar.style.background).toMatch(/#ff0099|rgb\(255, ?0, ?153\)/);
  });

  it('falls back to "?" when callerName is empty and callerInitial is missing', () => {
    render(
      <IncomingCall
        open
        callerName=""
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});
