import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import {SiteNav} from '@/components/SiteNav';
import './globals.css';

export const metadata: Metadata = {
  title: '知影 · AI 知识视频工坊',
  description: '知识创作者的视频工作台 — M1 渲染闭环',
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="zh-CN">
      <body>
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
