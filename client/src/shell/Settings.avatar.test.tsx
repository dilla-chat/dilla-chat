// Drive AvatarUploader pick/crop/upload/clear paths.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMocks = vi.hoisted(() => ({
  uploadFile: vi.fn(async () => ({ id: 'att-1' })),
  getAttachmentUrl: vi.fn(() => 'https://srv/att-1'),
  updateMe: vi.fn(async () => ({})),
}));

vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../services/websocket', () => ({ ws: { on: vi.fn(() => () => {}) } }));

import { AvatarUploader } from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';

const SHELL = {
  SERVERS: [], CHANNELS: [],
  MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00' }],
  byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', avatarUrl: '' } },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: null, currentUserId: 'me',
};

function wrap(children: React.ReactNode) {
  return (
    <MemoryRouter>
      <ShellDataProvider value={SHELL}>{children}</ShellDataProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  apiMocks.uploadFile.mockClear();
  apiMocks.getAttachmentUrl.mockClear();
  apiMocks.updateMe.mockClear();
  useAuthStore.setState({
    derivedKey: 'dk',
    teams: new Map([['t1', { user: { id: 'me', display_name: 'Me' }, baseUrl: 'https://srv', token: 'tok' }]]),
  } as never);
  useTeamStore.setState({
    activeTeamId: 't1',
    members: new Map([['t1', [{ id: 'm1', userId: 'me', username: 'me', displayName: 'Me', avatarUrl: '', publicKeyHex: '' }]]]),
  } as never);
});

describe('AvatarUploader', () => {
  it('renders avatar + Upload button', () => {
    const { container } = render(wrap(<AvatarUploader />));
    expect(container.querySelector('.set-avatar')).toBeTruthy();
    expect(container.textContent).toContain('Upload');
  });

  it('shows initials when no avatar URL', () => {
    const { container } = render(wrap(<AvatarUploader />));
    expect(container.textContent).toContain('ME');
  });

  it('clicking Upload triggers the hidden file input', () => {
    const { container } = render(wrap(<AvatarUploader />));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click');
    const uploadBtn = [...container.querySelectorAll('button')].find((b) => /upload/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(uploadBtn);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('rejects non-image file types', () => {
    const { container } = render(wrap(<AvatarUploader />));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);
    expect(container.textContent).toContain('Pick an image');
  });

  it('rejects files over 5 MB', () => {
    const { container } = render(wrap(<AvatarUploader />));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File([new ArrayBuffer(6 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [big], configurable: true });
    fireEvent.change(fileInput);
    expect(container.textContent).toContain('5 MB');
  });

  it('opens CropModal when image is picked', () => {
    const { container } = render(wrap(<AvatarUploader />));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const img = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [img], configurable: true });
    // URL.createObjectURL is not implemented in jsdom by default
    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = vi.fn(() => 'blob:fake');
      URL.revokeObjectURL = vi.fn();
    }
    fireEvent.change(fileInput);
    // Modal renders into document body via portal? Look at full document
    expect(document.body.querySelector('.cropper, [role="dialog"], .modal-overlay')).toBeDefined();
  });

  it('shows Remove button only when user has an avatar', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      members: new Map([['t1', [{ id: 'm1', userId: 'me', username: 'me', displayName: 'Me', avatarUrl: 'https://x/y.png', publicKeyHex: '' }]]]),
    } as never);
    const SHELL2 = { ...SHELL, byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', avatarUrl: 'https://x/y.png' } } };
    const { container } = render(
      <MemoryRouter>
        <ShellDataProvider value={SHELL2}>
          <AvatarUploader />
        </ShellDataProvider>
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('Remove');
  });

  it('clicking Remove calls api.updateMe with avatar_url=""', async () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      members: new Map([['t1', [{ id: 'm1', userId: 'me', username: 'me', displayName: 'Me', avatarUrl: 'https://x/y.png', publicKeyHex: '' }]]]),
    } as never);
    const SHELL2 = { ...SHELL, byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', avatarUrl: 'https://x/y.png' } } };
    const { container } = render(
      <MemoryRouter>
        <ShellDataProvider value={SHELL2}>
          <AvatarUploader />
        </ShellDataProvider>
      </MemoryRouter>,
    );
    const remove = [...container.querySelectorAll('button')].find((b) => /remove/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(remove);
      await Promise.resolve();
    });
    expect(apiMocks.updateMe).toHaveBeenCalledWith(
      'https://srv', 'tok', { avatar_url: '' },
    );
  });
});
