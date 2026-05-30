// React context binding for the shell data produced by useShellData(). The
// shell components (ChatApp, Settings, Extras, Chrome) historically read
// from a `window.SHELL_DATA` global — a legacy of the design handoff. This
// context is the migration target: components should consume shell data
// via `useShellDataContext()` so:
//   - the dependency is explicit (no hidden global reads)
//   - re-renders are React-driven, not "next render reads new global"
//   - tests can inject a synthetic provider without monkeypatching window
//
// AppShell wraps its tree in <ShellDataProvider value={shellData}> and
// also writes the same object to window.SHELL_DATA until every reader
// is ported over.

import { createContext, useContext, type ReactNode } from 'react';

// We don't import the concrete return type of useShellData to avoid a
// circular type dependency — the shape is the handoff-compatible bag of
// SERVERS/CHANNELS/MEMBERS/etc. Tightening to a real interface is part
// of the wider shell-typing pass.
export type ShellData = Record<string, unknown> | null;

const Ctx = createContext<ShellData>(null);

export function ShellDataProvider({
  value,
  children,
}: Readonly<{
  value: ShellData;
  children: ReactNode;
}>) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read the live shell data from context. Returns null outside a provider
 *  (e.g. tests that render a component in isolation); callers should
 *  treat that the same as "data not loaded yet" rather than crashing. */
export function useShellDataContext(): ShellData {
  return useContext(Ctx);
}
