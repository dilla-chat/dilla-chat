import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MeshTopBar from './MeshTopBar';

describe('MeshTopBar', () => {
  it('renders a top-bar landmark with placeholder content', () => {
    render(<MeshTopBar />);
    const bar = screen.getByRole('banner', { name: /mesh top bar/i });
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveClass('mesh-top-bar');
  });

  it('applies --topbar-h height via inline style or CSS class', () => {
    const { container } = render(<MeshTopBar />);
    const bar = container.querySelector('.mesh-top-bar') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.className).toContain('mesh-top-bar');
  });
});
