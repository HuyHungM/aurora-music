export interface NavItemConfig {
  href: string;
  /** Translation key resolved through the locale dictionaries. */
  labelKey: string;
  icon: "home" | "search" | "library" | "radio" | "offline";
}

export const navItems: NavItemConfig[] = [
  { href: "/", labelKey: "nav.home", icon: "home" },
  { href: "/search", labelKey: "nav.search", icon: "search" },
  { href: "/library", labelKey: "nav.library", icon: "library" },
  { href: "/offline", labelKey: "nav.offline", icon: "offline" },
  { href: "/radio", labelKey: "nav.radio", icon: "radio" },
];

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
