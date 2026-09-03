import {enqueueFinalRender} from '@/lib/final-render/bridge';

/**
 * The execution seam is intentionally generic: both locations execute the same
 * render contract, while their request/result plumbing remains location-specific.
 */
export interface RenderExecutor<Request, Result> {
  execute(request: Request): Promise<Result>;
}

export interface ExistingWorkerRenderRequest {
  projectId: string;
  subtitleMode?: 'none' | 'burned';
  expectedAudio?: {artifactId: string; version: number};
  expectedSubtitle?: {artifactId: string; version: number};
  expectedReconciliation?: {artifactId: string; version: number};
}

/** Production adapter. It preserves enqueueFinalRender and therefore the NAS Worker path. */
export class ExistingWorkerExecutor
  implements RenderExecutor<ExistingWorkerRenderRequest, ReturnType<typeof enqueueFinalRender>>
{
  async execute(request: ExistingWorkerRenderRequest): Promise<ReturnType<typeof enqueueFinalRender>> {
    return enqueueFinalRender(request.projectId, request);
  }
}
