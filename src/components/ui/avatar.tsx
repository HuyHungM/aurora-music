import Image from "next/image";

export interface AvatarProps {
  name?: string;
  image?: string;
  size?: number;
}

function initials(name?: string): string {
  if (!name || name.trim() === "") {
    return "?";
  }
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export function Avatar({ name, image, size = 32 }: AvatarProps) {
  if (image) {
    return (
      <Image
        src={image}
        alt={name ? `${name}'s avatar` : "User avatar"}
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full bg-accent/20 font-semibold text-accent-foreground"
      style={{ width: size, height: size, fontSize: size / 2.4 }}
    >
      {initials(name)}
    </span>
  );
}