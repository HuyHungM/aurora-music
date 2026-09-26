"use client";

import { useRouter } from "next/navigation";
import { ErrorFallback } from "@/components/ui/error-fallback";
import { useOnlineStatus } from "@/components/ui/offline-indicator";
import { useLocale } from "@/components/i18n/locale-provider";
import { toUserFacingError } from "@/lib/errors/user-error";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const online = useOnlineStatus();
  const { locale } = useLocale();
  const mapped = toUserFacingError(error, { online }, locale);
  return (
    <ErrorFallback
      message={mapped.message}
      code={mapped.code}
      digest={error.digest}
      offline={!online}
      onRetry={() => reset()}
      onHome={() => router.push("/")}
    />
  );
}
