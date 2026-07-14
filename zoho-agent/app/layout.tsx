import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { TopLoadingBar } from "@/components/top-loading-bar";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist"
});

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
      <body className={geist.className}>
        <TopLoadingBar />
        {children}
      </body>
    </html>
  );
}

