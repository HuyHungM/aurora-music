import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { OfflineIndicator } from "@/components/ui/offline-indicator";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
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

export const metadata: Metadata = {
  title: "Aurora Music",
  description: "Stream and discover music with Aurora",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#08070d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full bg-background text-text-primary antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegister />
        <OfflineIndicator />
        {children}
      </body>
    </html>
  );
}
