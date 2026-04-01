import { createContext } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);
