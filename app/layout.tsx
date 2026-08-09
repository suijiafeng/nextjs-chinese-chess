import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://changan-xiangqi.ctm2233.chatgpt.site"),
  title: "长安棋社 · 中国象棋",
  description: "一局安静、讲究、随时可开的中国象棋。",
  openGraph: {
    title: "长安棋社 · 中国象棋",
    description: "落子之间，自有天地。在线体验完整规则的中国象棋。",
    url: "https://changan-xiangqi.ctm2233.chatgpt.site",
    siteName: "长安棋社",
    locale: "zh_CN",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1731,
        height: 909,
        alt: "长安棋社——落子之间，自有天地",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "长安棋社 · 中国象棋",
    description: "落子之间，自有天地。在线体验完整规则的中国象棋。",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
