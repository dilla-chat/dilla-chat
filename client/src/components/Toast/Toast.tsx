import { useState, useCallback, type ReactNode } from 'react';
import { ToastContext, type ToastType } from './ToastContext';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 0;

const typeClasses: Record<ToastType, string> = {
  info: '',
  success: 'border-success',
  error: 'border-danger',
  warning: 'border-warning',
};

export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext value={{ toast }}>
      {children}
      <div
        className="toast-container fixed bottom-lg right-lg z-toast flex flex-col-reverse gap-sm pointer-events-none"
        role="status"
        aria-live="polite"
        data-testid="toast-container"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-md px-lg py-md rounded-md text-sm text-foreground-primary bg-surface-secondary border border-border shadow-glass pointer-events-auto animate-toast-slide-in max-w-[360px] ${typeClasses[t.type]}`}
            data-testid={`toast-${t.type}`}
          >
            <span className="flex-1">{t.message}</span>
            <button
              className="bg-transparent border-none text-foreground-muted cursor-pointer text-xl leading-none p-0 transition-colors duration-fast ease-out hover:text-foreground-primary"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}
