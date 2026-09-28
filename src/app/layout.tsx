import type { Metadata, Viewport } from "next";
import { Geist_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { OfflineIndicator } from "@/components/ui/offline-indicator";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { getRequestLocale } from "@/lib/i18n/server";
import {
  APP_APPLE_TOUCH_ICON,
  APP_MANIFEST_PATH,
  APP_NAME,
  APP_SHORT_NAME,
  APP_THEME_COLOR,
  appDescription,
} from "@/lib/app-metadata";
import "./globals.css";

// Stitch display/body voice. Plus Jakarta Sans is a variable font, so no
// `weight` list is needed; the whole 200-800 range ships in one file and the
// typography tokens pick the weight per role.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  // No rendered text uses the mono face (only the CSS variable exists),
  // so preloading its woff2 triggers "preloaded but not used" warnings.
  // The face stays available via the variable; the primary sans face
  // above remains preloaded for initial rendering.
  preload: false,
});

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  return {
    // One canonical identity: every field is read from `@/lib/app-metadata`,
    // the same module the web app manifest is generated from, so the browser
    // tab, the search snippet, the install dialog and the OS launcher can
    // never describe Aurora differently (Phase 51).
    title: {
      // The template is what makes the app name visible on every route. Each
      // page supplies only its own label ("Home", "Radio", ...), and without a
      // template a child's title *replaces* the parent's — so the browser tab
      // read "Home" while the launcher said "Aurora Music". Page labels are
      // unchanged; they are now suffixed with the canonical name.
      default: APP_NAME,
      template: `%s · ${APP_NAME}`,
    },
    description: appDescription(locale),
    applicationName: APP_NAME,
    manifest: APP_MANIFEST_PATH,
    appleWebApp: {
      // Installed-mode support on iOS/iPadOS Safari. Next.js 16 emits
      // `mobile-web-app-capable` for `capable` — the framework-native output,
      // and the spelling Safari actually honours alongside the older
      // `apple-mobile-web-app-capable` form. `capable` is the only current
      // field; the legacy `mobileWebApp` variant was removed from the type.
      capable: true,
      title: APP_SHORT_NAME,
      // Dark canvas in both light and dark appearances, so the status bar text
      // always has contrast against the splash.
      statusBarStyle: "black-translucent",
    },
    formatDetection: {
      // Do not let iOS auto-link or auto-correct track/artist strings into
      // phone numbers, dates or addresses.
      telephone: false,
      date: false,
      address: false,
      email: false,
    },
    openGraph: {
      type: "website",
      siteName: APP_NAME,
      title: APP_NAME,
      description: appDescription(locale),
      locale: locale === "vi" ? "vi_VN" : "en_US",
    },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      ],
      // iOS ignores the declared size and scales the image itself, so the
      // 192px launcher asset is a correct apple-touch-icon source and does
      // not need a second rendered file.
      apple: [{ url: APP_APPLE_TOUCH_ICON, sizes: "192x192", type: "image/png" }],
    },
  };
}

export const viewport: Viewport = {
  themeColor: APP_THEME_COLOR,
  width: "device-width",
  initialScale: 1,
  // Lets the layout paint under the notch, the rounded display corners and
  // the home indicator so `env(safe-area-inset-*)` resolves to real values.
  // Without this, iOS Safari reserves that space itself and every
  // safe-area inset in the application shell, mini player, full player and
  // queue panel silently resolves to 0 on exactly the devices that need it.
  viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getRequestLocale();
  return (
    <html
      lang={locale}
      className={`${jakarta.variable} ${geistMono.variable} h-full bg-background text-text-primary antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <LocaleProvider initialLocale={locale}>
          <ServiceWorkerRegister />
          <OfflineIndicator />
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
