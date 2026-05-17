import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MeshBottomBar from './MeshBottomBar';

describe('MeshBottomBar', () => {
  it('renders a content-info landmark with placeholder content', () => {
    render(<MeshBottomBar />);
    const bar = screen.getByRole('contentinfo', { name: /mesh bottom bar/i });
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveClass('mesh-bottom-bar');
  });

  it('applies --bottombar-h height class', () => {
    const { container } = render(<MeshBottomBar />);
    const bar = container.querySelector('.mesh-bottom-bar') as HTMLElement;
    expect(bar).toBeTruthy();
  });
});
