import type { Metadata } from "next";
import { Geist } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geist = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "A2A Channels – Admin",
  description: "Manage channel bindings and agent configurations",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-50 text-gray-900">
        <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6">
          <span className="font-semibold text-lg tracking-tight">
            A2A Channels
          </span>
          <nav className="flex gap-4 text-sm">
            <Link
              href="/channels"
              className="hover:text-blue-600 transition-colors"
            >
              Channels
            </Link>
            <Link
              href="/agents"
              className="hover:text-blue-600 transition-colors"
            >
              Agents
            </Link>
          </nav>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </body>
    </html>
  );
}
