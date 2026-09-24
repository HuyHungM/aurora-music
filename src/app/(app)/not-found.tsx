import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Not found" };

export default function AppNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <p className="text-xs uppercase tracking-wide text-text-muted">404</p>
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">Page not found</h1>
      <p className="max-w-sm text-sm leading-relaxed text-text-muted">
        The page you were looking for doesn&apos;t exist or has moved.
      </p>
      <ButtonLink href="/" variant="secondary">
        Back to home
      </ButtonLink>
    </div>
  );
}