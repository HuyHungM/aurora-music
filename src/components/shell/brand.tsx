import Link from "next/link";
import { SparkleIcon } from "@/components/ui/icons";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-2 rounded-lg text-text-primary outline-none transition-opacity hover:opacity-90"
      aria-label="Aurora Music home"
    >
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-aurora text-background">
        <SparkleIcon size={18} />
      </span>
      {!compact ? <span className="text-base font-bold tracking-tight">Aurora</span> : null}
    </Link>
  );
}