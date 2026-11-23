import type { Metadata, Viewport } from "next";
import "./globals.css";
import { themeInitScript } from "@/modules/procurement/client/theme";

export const metadata: Metadata = {
  title: "Advait | Tender & Procurement Intelligence",
  description:
    "An integration-ready procurement intelligence workspace powered by synthetic procurement data.",
};

export const viewport: Viewport = { themeColor: "#04060d", colorScheme: "dark light" };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
