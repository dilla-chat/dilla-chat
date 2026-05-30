import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Avatar, PlainAvatar, memberAvatarStyle, memberAvatarClass } from './Avatar';

describe('memberAvatarStyle', () => {
  it('uses backgroundColor longhand (not the background shorthand) for fallback tiles', () => {
    const style = memberAvatarStyle({ color: '#abc' });
    expect(style.backgroundColor).toBe('#abc');
    expect(style.background).toBeUndefined();
  });

  it('falls back to var(--muted) when color is missing', () => {
    const style = memberAvatarStyle({});
    expect(style.backgroundColor).toBe('var(--muted)');
  });

  it('switches to backgroundImage + cover when avatarUrl is set', () => {
    const style = memberAvatarStyle({ avatarUrl: '/u/x.png' });
    expect(style.backgroundImage).toBe('url(/u/x.png)');
    expect(style.backgroundSize).toBe('cover');
    expect(style.backgroundPosition).toBe('center');
    expect(style.backgroundRepeat).toBe('no-repeat');
    expect(style.color).toBe('transparent');
    expect(style.backgroundColor).toBeUndefined();
  });

  it('applies size to width/height/fontSize', () => {
    const style = memberAvatarStyle({ color: '#000' }, 40);
    expect(style.width).toBe(40);
    expect(style.height).toBe(40);
    expect(style.fontSize).toBe(16); // 40 * 0.4
  });

  it('omits size styles when size is undefined', () => {
    const style = memberAvatarStyle({ color: '#000' });
    expect(style.width).toBeUndefined();
    expect(style.height).toBeUndefined();
  });

  it('avatarUrl takes precedence over color', () => {
    const style = memberAvatarStyle({ color: '#abc', avatarUrl: '/x.png' });
    expect(style.backgroundColor).toBeUndefined();
    expect(style.backgroundImage).toContain('/x.png');
  });
});

describe('memberAvatarClass', () => {
  it('returns the base class when no avatarUrl is set', () => {
    expect(memberAvatarClass({}, 'avatar')).toBe('avatar');
    expect(memberAvatarClass({ avatarUrl: '' }, 'avatar')).toBe('avatar');
  });

  it('appends has-image when avatarUrl is set', () => {
    expect(memberAvatarClass({ avatarUrl: '/x.png' }, 'avatar')).toBe('avatar has-image');
  });

  it('preserves custom base class names', () => {
    expect(memberAvatarClass({ avatarUrl: '/x.png' }, 'big-avatar')).toBe('big-avatar has-image');
  });
});

describe('Avatar component', () => {
  it('renders initials when no avatarUrl', () => {
    const { container } = render(<Avatar member={{ initials: 'AB', color: '#f00' }} />);
    expect(container.textContent).toBe('AB');
  });

  it('omits initials when avatarUrl is set', () => {
    const { container } = render(<Avatar member={{ initials: 'AB', avatarUrl: '/p.png' }} />);
    expect(container.textContent).toBe('');
  });

  it('renders a presence dot when status is provided', () => {
    const { container } = render(<Avatar member={{ initials: 'AB', status: 'online' }} />);
    expect(container.querySelector('.presence.online')).toBeTruthy();
  });

  it('omits the presence dot when no status', () => {
    const { container } = render(<Avatar member={{ initials: 'AB' }} />);
    expect(container.querySelector('.presence')).toBeNull();
  });

  it('applies size prop to wrapper style', () => {
    const { container } = render(<Avatar member={{ initials: 'AB' }} size={50} />);
    const wrap = container.firstChild as HTMLElement;
    expect(wrap.style.width).toBe('50px');
    expect(wrap.style.height).toBe('50px');
  });
});

describe('PlainAvatar component', () => {
  it('renders initials when no avatarUrl', () => {
    const { container } = render(<PlainAvatar member={{ initials: 'CD' }} />);
    expect(container.textContent).toBe('CD');
  });

  it('never renders a presence dot (even with status)', () => {
    const { container } = render(<PlainAvatar member={{ initials: 'CD', status: 'online' }} />);
    expect(container.querySelector('.presence')).toBeNull();
  });

  it('omits initials when avatarUrl is set', () => {
    const { container } = render(<PlainAvatar member={{ initials: 'CD', avatarUrl: '/p.png' }} />);
    expect(container.textContent).toBe('');
  });
});
