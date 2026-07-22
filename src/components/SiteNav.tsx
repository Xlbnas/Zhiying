'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';

/**
 * 顶部导航：品牌 + 项目 / 任务 两个入口（CONTRACT §6）。
 * 中文界面，active 状态基于当前路径。
 */
export function SiteNav() {
  const pathname = usePathname();
  const isJobs = pathname.startsWith('/jobs');

  return (
    <header className="topnav">
      <div className="topnav-inner">
        <Link href="/" className="brand" aria-label="知影首页">
          <span className="brand-mark" aria-hidden="true" />
          知影
          <span className="brand-sub">AI 知识视频工坊</span>
        </Link>
        <nav className="nav-links" aria-label="主导航">
          <Link href="/" className={`nav-link${isJobs ? '' : ' active'}`}>
            项目
          </Link>
          <Link href="/jobs" className={`nav-link${isJobs ? ' active' : ''}`}>
            任务
          </Link>
        </nav>
      </div>
    </header>
  );
}
