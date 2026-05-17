import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutStore } from './layoutStore';

beforeEach(() => {
  useLayoutStore.setState({
    sidebarWidth: 240,
    membersWidth: 232,
    topBarEnabled: false,
    bottomBarEnabled: false,
  });
});

describe('layoutStore', () => {
  it('exposes mesh shell defaults', () => {
    const s = useLayoutStore.getState();
    expect(s.sidebarWidth).toBe(240);
    expect(s.membersWidth).toBe(232);
    expect(s.topBarEnabled).toBe(false);
    expect(s.bottomBarEnabled).toBe(false);
  });

  it('setSidebarWidth clamps to [200, 360]', () => {
    const { setSidebarWidth } = useLayoutStore.getState();
    setSidebarWidth(100);
    expect(useLayoutStore.getState().sidebarWidth).toBe(200);
    setSidebarWidth(500);
    expect(useLayoutStore.getState().sidebarWidth).toBe(360);
    setSidebarWidth(280);
    expect(useLayoutStore.getState().sidebarWidth).toBe(280);
  });

  it('setMembersWidth clamps to [180, 340]', () => {
    const { setMembersWidth } = useLayoutStore.getState();
    setMembersWidth(50);
    expect(useLayoutStore.getState().membersWidth).toBe(180);
    setMembersWidth(900);
    expect(useLayoutStore.getState().membersWidth).toBe(340);
    setMembersWidth(220);
    expect(useLayoutStore.getState().membersWidth).toBe(220);
  });

  it('nudgeSidebarWidth applies clamped delta', () => {
    const { nudgeSidebarWidth } = useLayoutStore.getState();
    nudgeSidebarWidth(80);
    expect(useLayoutStore.getState().sidebarWidth).toBe(320);
    nudgeSidebarWidth(-1000);
    expect(useLayoutStore.getState().sidebarWidth).toBe(200);
  });

  it('nudgeMembersWidth applies clamped delta', () => {
    const { nudgeMembersWidth } = useLayoutStore.getState();
    nudgeMembersWidth(50);
    expect(useLayoutStore.getState().membersWidth).toBe(282);
    nudgeMembersWidth(-1000);
    expect(useLayoutStore.getState().membersWidth).toBe(180);
  });

  it('toggleTopBar / toggleBottomBar flip boolean state', () => {
    const { toggleTopBar, toggleBottomBar } = useLayoutStore.getState();
    toggleTopBar();
    expect(useLayoutStore.getState().topBarEnabled).toBe(true);
    toggleTopBar();
    expect(useLayoutStore.getState().topBarEnabled).toBe(false);
    toggleBottomBar();
    expect(useLayoutStore.getState().bottomBarEnabled).toBe(true);
  });
});
