import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "长安棋社 · 中国象棋",
  description: "一局安静、讲究、随时可开的中国象棋。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
