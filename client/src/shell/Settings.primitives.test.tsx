// Unit tests for the small exported primitives in Settings.tsx —
// Row, Group, Toggle, TextField, Select, Btn, FormBar, permsSummary.

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import {
  Row,
  Group,
  Toggle,
  TextField,
  Select,
  Btn,
  FormBar,
  permsSummary,
  PERM_FLAGS,
  USER_TABS,
  TEAM_TABS,
} from './Settings';

describe('Row', () => {
  it('renders label + hint + children', () => {
    const { container } = render(
      <Row label="Display Name" hint="visible to your team">
        <input data-testid="x" />
      </Row>,
    );
    expect(container.textContent).toContain('Display Name');
    expect(container.textContent).toContain('visible to your team');
    expect(container.querySelector('[data-testid="x"]')).toBeTruthy();
  });

  it('renders without hint', () => {
    const { container } = render(<Row label="Name"><span /></Row>);
    expect(container.querySelector('.set-row-hint')).toBeNull();
  });
});

describe('Group', () => {
  it('renders title + hint + children', () => {
    const { container } = render(
      <Group title="Account" hint="profile + identity">
        <div data-testid="kids" />
      </Group>,
    );
    expect(container.textContent).toContain('Account');
    expect(container.textContent).toContain('profile + identity');
    expect(container.querySelector('[data-testid="kids"]')).toBeTruthy();
  });

  it('omits hint when not provided', () => {
    const { container } = render(<Group title="X"><span /></Group>);
    expect(container.querySelector('.set-group-hint')).toBeNull();
  });
});

describe('Toggle', () => {
  it('renders with on state', () => {
    const { container } = render(<Toggle value={true} onChange={vi.fn()} />);
    expect(container.querySelector('[data-on="1"]')).toBeTruthy();
  });

  it('renders with off state', () => {
    const { container } = render(<Toggle value={false} onChange={vi.fn()} />);
    expect(container.querySelector('[data-on="0"]')).toBeTruthy();
  });

  it('clicking inverts state and fires onChange', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle value={false} onChange={onChange} />);
    fireEvent.click(container.querySelector('.set-toggle') as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('clicking on toggle when on fires onChange(false)', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle value={true} onChange={onChange} />);
    fireEvent.click(container.querySelector('.set-toggle') as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('TextField', () => {
  it('renders value + placeholder', () => {
    const { container } = render(
      <TextField value="hello" onChange={vi.fn()} placeholder="name" />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('hello');
    expect(input.placeholder).toBe('name');
  });

  it('typing fires onChange with new value', () => {
    const onChange = vi.fn();
    const { container } = render(<TextField value="" onChange={onChange} />);
    fireEvent.change(container.querySelector('input') as HTMLInputElement, {
      target: { value: 'jonas' },
    });
    expect(onChange).toHaveBeenCalledWith('jonas');
  });

  it('mono prop adds mono class', () => {
    const { container } = render(<TextField value="" onChange={vi.fn()} mono />);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.className).toContain('mono');
  });

  it('readOnly prop adds readonly class + no onChange', () => {
    const onChange = vi.fn();
    const { container } = render(<TextField value="x" onChange={onChange} readOnly />);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.className).toContain('set-input-readonly');
    expect(input.readOnly).toBe(true);
    // change should not fire onChange (handler is undefined when readOnly)
    fireEvent.change(input, { target: { value: 'y' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Select', () => {
  it('renders options + value', () => {
    const { container } = render(
      <Select value="b" onChange={vi.fn()} options={['a', 'b', 'c']} />,
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('b');
    expect(container.querySelectorAll('option')).toHaveLength(3);
  });

  it('changing value fires onChange', () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select value="a" onChange={onChange} options={['a', 'b', 'c']} />,
    );
    fireEvent.change(container.querySelector('select') as HTMLSelectElement, {
      target: { value: 'c' },
    });
    expect(onChange).toHaveBeenCalledWith('c');
  });
});

describe('Btn', () => {
  it('renders text + calls onClick', () => {
    const onClick = vi.fn();
    const { container, getByText } = render(<Btn onClick={onClick}>Save</Btn>);
    fireEvent.click(getByText('Save'));
    expect(onClick).toHaveBeenCalled();
    expect(container.querySelector('.btn')).toBeTruthy();
  });

  it('danger prop adds btn--danger class', () => {
    const { container } = render(<Btn onClick={vi.fn()} danger>Delete</Btn>);
    expect(container.querySelector('.btn--danger')).toBeTruthy();
  });
});

describe('FormBar', () => {
  it('renders Discard + Save buttons', () => {
    const { container } = render(
      <FormBar dirty={true} saving={false} savedAt={null} onSave={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(container.textContent).toContain('Discard');
    expect(container.textContent).toContain('Save');
  });

  it('Save is disabled when not dirty', () => {
    const { container } = render(
      <FormBar dirty={false} saving={false} savedAt={null} onSave={vi.fn()} onDiscard={vi.fn()} />,
    );
    const save = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('Save is disabled when saving', () => {
    const { container } = render(
      <FormBar dirty={true} saving={true} savedAt={null} onSave={vi.fn()} onDiscard={vi.fn()} />,
    );
    const save = [...container.querySelectorAll('button')].find((b) => /saving/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.textContent).toContain('Saving');
  });

  it('clicking Save fires onSave', () => {
    const onSave = vi.fn();
    const { container } = render(
      <FormBar dirty={true} saving={false} savedAt={null} onSave={onSave} onDiscard={vi.fn()} />,
    );
    const save = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalled();
  });

  it('clicking Discard fires onDiscard', () => {
    const onDiscard = vi.fn();
    const { container } = render(
      <FormBar dirty={true} saving={false} savedAt={null} onSave={vi.fn()} onDiscard={onDiscard} />,
    );
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /discard/i.test(b.textContent ?? '')) as HTMLButtonElement);
    expect(onDiscard).toHaveBeenCalled();
  });

  it('shows Saved chip after savedAt changes, then fades after timer', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FormBar dirty={false} saving={false} savedAt={null} onSave={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(container.textContent).not.toContain('Saved');
    rerender(<FormBar dirty={false} saving={false} savedAt={Date.now()} onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(container.textContent).toContain('Saved');
    act(() => { vi.advanceTimersByTime(2100); });
    expect(container.textContent).not.toContain('Saved');
    vi.useRealTimers();
  });
});

describe('permsSummary', () => {
  it('returns "no permissions" for 0', () => {
    expect(permsSummary(0)).toContain('no permissions');
  });

  it('returns "All" or full list when admin bit set', () => {
    const all = (1 << PERM_FLAGS.length) - 1;
    const s = permsSummary(all);
    expect(s).toBeTruthy();
  });

  it('returns a string for a partial permission set', () => {
    const s = permsSummary(0x47); // arbitrary mix
    expect(typeof s).toBe('string');
  });
});

describe('USER_TABS / TEAM_TABS / PERM_FLAGS', () => {
  it('USER_TABS is a non-empty array', () => {
    expect(Array.isArray(USER_TABS)).toBe(true);
    expect(USER_TABS.length).toBeGreaterThan(0);
  });

  it('TEAM_TABS is a non-empty array', () => {
    expect(Array.isArray(TEAM_TABS)).toBe(true);
    expect(TEAM_TABS.length).toBeGreaterThan(0);
  });

  it('PERM_FLAGS is a non-empty array', () => {
    expect(Array.isArray(PERM_FLAGS)).toBe(true);
    expect(PERM_FLAGS.length).toBeGreaterThan(0);
  });
});
