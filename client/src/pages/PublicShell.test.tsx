import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import PublicShell from './PublicShell';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
}));

vi.mock('./PublicShell.css', () => ({}));

describe('PublicShell', () => {
  it('renders the brand logo + tagline + subtitle', () => {
    const { container, getByText } = render(<PublicShell>x</PublicShell>);
    expect(container.querySelector('.public-brand-logo')).toBeTruthy();
    // "Dilla" appears twice (tagline h2 + mobile header). Just verify
    // one element matches.
    expect(container.querySelector('.public-brand-tagline')?.textContent).toBe('Dilla');
    expect(getByText('A federated, end-to-end encrypted team chat')).toBeTruthy();
  });

  it('renders three brand pills', () => {
    const { container } = render(<PublicShell>x</PublicShell>);
    expect(container.querySelectorAll('.public-brand-pill').length).toBe(3);
  });

  it('renders the children inside .public-card', () => {
    const { container } = render(
      <PublicShell><div data-testid="content">hello</div></PublicShell>,
    );
    const card = container.querySelector('.public-card') as HTMLElement;
    expect(card.querySelector('[data-testid=content]')?.textContent).toBe('hello');
  });

  it('does not render step dots when no steps prop is passed', () => {
    const { container } = render(<PublicShell>x</PublicShell>);
    expect(container.querySelector('.public-steps')).toBeNull();
  });

  it('renders the step dots when steps=[N, total] is given', () => {
    const { container } = render(<PublicShell steps={[2, 4]}>x</PublicShell>);
    const dots = container.querySelectorAll('.public-step-dot');
    expect(dots.length).toBe(4);
  });

  it('marks the current step .active and earlier steps .completed', () => {
    const { container } = render(<PublicShell steps={[3, 4]}>x</PublicShell>);
    const dots = [...container.querySelectorAll('.public-step-dot')] as HTMLElement[];
    expect(dots[0].className).toContain('completed');
    expect(dots[1].className).toContain('completed');
    expect(dots[2].className).toContain('active');
    expect(dots[3].className).not.toContain('active');
    expect(dots[3].className).not.toContain('completed');
  });

  it('mobile header has logo + brand text', () => {
    const { container } = render(<PublicShell>x</PublicShell>);
    const header = container.querySelector('.public-mobile-header') as HTMLElement;
    expect(header.querySelector('img')).toBeTruthy();
    expect(header.textContent).toContain('Dilla');
  });
});
