'use client';

import {useCallback, useEffect, useMemo, useState} from 'react';
import type {ActivityResponse} from './shared';
import {createActivityController} from './activity-controller-logic';

export interface ActivityController {
  activity: ActivityResponse | null;
  error: string | null;
  watchActive: boolean;
  refresh: () => Promise<void>;
  notifyMutation: () => void;
}

/**
 * Workspace 统一 activity 控制器（M7.3A.2）。
 *
 * - 任何 narration/asset/LLM 任务 mutation 后调用 notifyMutation() 立即刷新并启动 watch。
 * - 停止条件：至少成功刷新过一次，且连续两次无 running/queued 任务，
 *   且 audio/subtitle 已进入稳定终态。
 * - hidden 页面：轮询降至 15s；恢复可见时立即刷新并恢复 2s。
 * - 网络失败退避：2s → 4s → 8s → 15s；成功后恢复 2s。
 * - unmount 时清理 timer，禁止旧闭包持续请求。
 */
export function useActivityController(projectId: string): ActivityController {
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watchActive, setWatchActive] = useState(false);

  const fetchActivity = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/activity`, {cache: 'no-store'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ActivityResponse;
  }, [projectId]);

  const controller = useMemo(() => {
    return createActivityController({
      fetchActivity,
      onChange: (next) => {
        setActivity(next.activity);
        setError(next.error);
        setWatchActive(next.watchActive);
      },
      getVisibilityState: () => (typeof document !== 'undefined' ? document.visibilityState : 'visible'),
      setInterval: (cb, ms) => window.setInterval(cb, ms),
      clearInterval: (id) => {
        if (id !== null) window.clearInterval(id);
      },
    });
  }, [fetchActivity]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void controller.refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [controller]);

  useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  return {
    activity,
    error,
    watchActive,
    refresh: controller.refresh,
    notifyMutation: controller.notifyMutation,
  };
}
