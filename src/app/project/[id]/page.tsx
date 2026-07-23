import {WorkflowWorkspace} from '@/components/workflow/WorkflowWorkspace';

/**
 * 项目工作台页（M2-C）：Workflow Workspace Shell。
 * 服务端壳只负责取 id；M2 工作流 / Legacy M1 工作台路由在 client 组件内完成。
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{id: string}>;
}) {
  const {id} = await params;
  return <WorkflowWorkspace projectId={id} />;
}
