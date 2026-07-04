import type { Metadata } from "next";
import { TopLoadingBar } from "@/components/top-loading-bar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zoho Agent",
  description: "Controlled Zoho workflow executor for internal sales operations"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <TopLoadingBar />
        {children}
      </body>
    </html>
  );
}
