"use client";

import { useEffect, useRef, useCallback, type ReactNode } from "react";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name for the dialog (announced on open). */
  label?: string;
}

export function Dialog({ open, onClose, children, label }: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  // Keep Tab cycling inside the modal while it is open.
  const handleTrap = useCallback((e: KeyboardEvent) => {
    if (e.key !== "Tab" || !dialogRef.current) {
      return;
    }
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.tabIndex >= 0);
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement;

    document.addEventListener("keydown", handleEscape);
    document.addEventListener("keydown", handleTrap, true);
    document.body.style.overflow = "hidden";
    // Move focus into the dialog unless something inside (e.g. an
    // autofocused input) already claimed it.
    if (
      dialogRef.current &&
      !dialogRef.current.contains(document.activeElement)
    ) {
      dialogRef.current.focus();
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("keydown", handleTrap, true);
      document.body.style.overflow = "";
      previousFocusRef.current?.focus();
    };
  }, [open, handleEscape, handleTrap]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-border-subtle bg-surface-1 p-6 shadow-2xl focus:outline-none"
      >
        {children}
      </div>
    </div>
  );
}

export interface DialogTitleProps {
  children: ReactNode;
}

export function DialogTitle({ children }: DialogTitleProps) {
  return (
    <h2 className="text-lg font-semibold text-text-primary">{children}</h2>
  );
}

export interface DialogCloseProps {
  onClick: () => void;
  "aria-label"?: string;
}

export function DialogClose({
  onClick,
  "aria-label": ariaLabel = "Close dialog",
}: DialogCloseProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}

export interface DialogActionsProps {
  children: ReactNode;
}

export function DialogActions({ children }: DialogActionsProps) {
  return (
    <div className="mt-4 flex justify-end gap-2">{children}</div>
  );
}
