import {Workbench} from '@/components/Workbench';

/**
 * 项目工作台页（CONTRACT §6）：左 Scene 列表 + 右 Player。
 * 服务端壳只负责取 id，交互全部在 client 组件 Workbench 内。
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{id: string}>;
}) {
  const {id} = await params;
  return <Workbench projectId={id} />;
}
