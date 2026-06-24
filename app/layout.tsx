import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Internal Docs Assistant",
  description:
    "Ask questions about internal logistics processes and get answers with citations to the source documents.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
