import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "subtle";

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-foreground hover:bg-accent-hover active:bg-accent",
  secondary:
    "bg-surface-3 text-text-primary border border-border-strong hover:border-accent/50 hover:text-accent",
  ghost:
    "text-text-secondary hover:text-text-primary hover:bg-surface-2",
  subtle: "text-text-muted hover:text-text-secondary",
};

const sizeClasses = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  icon: "h-11 w-11 inline-flex items-center justify-center",
} as const;

type Size = keyof typeof sizeClasses;

interface SharedProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}

const baseClasses =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors select-none";

function classes(variant: Variant, size: Size, className?: string): string {
  return [baseClasses, variantClasses[variant], sizeClasses[size], className]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: SharedProps & Omit<ComponentProps<"button">, keyof SharedProps>) {
  return (
    <button className={classes(variant, size, className)} {...props}>
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: SharedProps & Omit<ComponentProps<typeof Link>, keyof SharedProps> & { href: string }) {
  return (
    <Link href={href} className={classes(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}