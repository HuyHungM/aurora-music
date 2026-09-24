export interface NavItemConfig {
  href: string;
  label: string;
  icon: "home" | "search" | "library" | "radio";
}

export const navItems: NavItemConfig[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/search", label: "Search", icon: "search" },
  { href: "/library", label: "Library", icon: "library" },
  { href: "/radio", label: "Radio", icon: "radio" },
];

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}