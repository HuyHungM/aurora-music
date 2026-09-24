"use client";

import { useRouter } from "next/navigation";
import { ErrorFallback } from "@/components/ui/error-fallback";
import { useOnlineStatus } from "@/components/ui/offline-indicator";
import { toUserFacingError } from "@/lib/errors/user-error";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const online = useOnlineStatus();
  const mapped = toUserFacingError(error, { online });
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <ErrorFallback
        message={mapped.message}
        code={mapped.code}
        digest={error.digest}
        offline={!online}
        onRetry={() => reset()}
        onHome={() => router.push("/")}
      />
    </div>
  );
}
