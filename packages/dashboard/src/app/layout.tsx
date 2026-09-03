import type { Metadata } from "next";
import { Inter, DM_Sans } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { AppProviders } from "@/components/providers";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXTAUTH_URL || "http://localhost:7023"
  ),
  title: {
    default: "raven - Copilot Proxy Dashboard",
    template: "%s - raven",
  },
  description: "GitHub Copilot proxy dashboard",
  openGraph: {
    title: "raven - Copilot Proxy Dashboard",
    description: "GitHub Copilot proxy dashboard",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Blocking script: apply dark class before first paint to prevent FOUC */}
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline theme-init script; content is a literal, no user input flows here
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem("theme");var d=window.matchMedia("(prefers-color-scheme:dark)").matches;var isDark=s==="dark"||(s!=="light"&&d);var root=document.documentElement;root.classList.toggle("dark",isDark);root.classList.toggle("light",!isDark);root.dataset.mode=isDark?"dark":"light"}catch(e){}})()`,
          }}
        />
      </head>
      <body
        className={`${inter.variable} ${dmSans.variable} antialiased`}
      >
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
