import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '吉拾开张｜直播排班与妆造协同',
  description: '吉拾开张内部直播排班、妆造预约与协同工具'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
