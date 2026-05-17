import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SafetyCompare from './SafetyCompare';

const matching = '12345 67890 abcde fghij 12345 67890 abcde fghij';

describe('SafetyCompare', () => {
  it('renders nothing when closed', () => {
    render(
      <SafetyCompare
        open={false}
        yours={matching}
        theirs={matching}
        yourName="you"
        theirName="them"
        onClose={() => {}}
        onMarkVerified={() => {}}
        onMarkMismatch={() => {}}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows MATCH when fingerprints are identical', () => {
    render(
      <SafetyCompare
        open
        yours={matching}
        theirs={matching}
        yourName="you"
        theirName="them"
        onClose={() => {}}
        onMarkVerified={() => {}}
        onMarkMismatch={() => {}}
      />,
    );
    expect(screen.getByText(/fingerprints match/i)).toBeInTheDocument();
  });

  it('shows DIFFER when fingerprints differ and highlights mismatched blocks', () => {
    const yours = '11111 22222 33333 44444';
    const theirs = '11111 99999 33333 44444';
    render(
      <SafetyCompare
        open
        yours={yours}
        theirs={theirs}
        yourName="you"
        theirName="them"
        onClose={() => {}}
        onMarkVerified={() => {}}
        onMarkMismatch={() => {}}
      />,
    );
    expect(screen.getByText(/fingerprints differ/i)).toBeInTheDocument();
    expect(document.querySelectorAll('.safety-compare-block.diff').length).toBeGreaterThan(0);
  });

  it('Mark verified calls onMarkVerified', () => {
    const onMarkVerified = vi.fn();
    render(
      <SafetyCompare
        open
        yours={matching}
        theirs={matching}
        yourName="you"
        theirName="them"
        onClose={() => {}}
        onMarkVerified={onMarkVerified}
        onMarkMismatch={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/mark verified/i));
    expect(onMarkVerified).toHaveBeenCalledOnce();
  });

  it("Doesn't match calls onMarkMismatch", () => {
    const onMarkMismatch = vi.fn();
    render(
      <SafetyCompare
        open
        yours={matching}
        theirs="11111 22222 33333 44444"
        yourName="you"
        theirName="them"
        onClose={() => {}}
        onMarkVerified={() => {}}
        onMarkMismatch={onMarkMismatch}
      />,
    );
    fireEvent.click(screen.getByText(/doesn't match/i));
    expect(onMarkMismatch).toHaveBeenCalledOnce();
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(
      <SafetyCompare
        open
        yours={matching}
        theirs={matching}
        yourName="you"
        theirName="them"
        onClose={onClose}
        onMarkVerified={() => {}}
        onMarkMismatch={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
