import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotFound from './NotFound';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('NotFound', () => {
  it('renders 404 heading', () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    );
    expect(screen.getByText('404')).toBeInTheDocument();
  });

  it('shows description text', () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    );
    expect(screen.getByText("This page doesn't exist.")).toBeInTheDocument();
  });

  it('navigates home on button click', () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Go Home'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
