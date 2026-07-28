/**
 * M6 Production MG_RelationGraph — 关系/冲突结构图（多节点+连线）。
 * 数据驱动：只消费 templateProps，无任何 demo 默认值。
 * templateProps: { title: string; nodes: {id: string; label: string}[]; edges: {from: string; to: string; label?: string}[]; caption?: string }
 */
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {Typography} from '../../design/typography';
import {colors, lineWidth} from '../../design/tokens';

export interface RelationGraphProps {
  title: string;
  nodes: Array<{id: string; label: string}>;
  edges: Array<{from: string; to: string; label?: string}>;
  caption?: string;
}

/** 等距排列节点在圆上 */
function layoutNodes(nodes: Array<{id: string; label: string}>, cx: number, cy: number, radius: number) {
  return nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    return {
      ...node,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });
}

export const MG_RelationGraph = ({title, nodes, edges, caption}: RelationGraphProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const cx = 960, cy = 520, radius = 260;
  const positioned = layoutNodes(nodes, cx, cy, radius);

  const nodeMap = new Map(positioned.map((n) => [n.id, n]));

  return (
    <AbsoluteFill style={{backgroundColor: colors.background, overflow: 'hidden'}}>
      {/* 标题 */}
      <div style={{
        position: 'absolute', left: 120, top: 80,
        opacity: interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'}),
      }}>
        <Typography variant="SectionTitle" color={colors.accent} style={{fontSize: 36, letterSpacing: 2}}>
          {title}
        </Typography>
        <div style={{width: 60, height: 3, background: colors.accent, marginTop: 12}} />
      </div>

      {/* SVG 连线 */}
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        {edges.map((edge, i) => {
          const from = nodeMap.get(edge.from);
          const to = nodeMap.get(edge.to);
          if (!from || !to) return null;
          const opacity = interpolate(frame, [20 + i * 5, 35 + i * 5], [0, 1], {extrapolateRight: 'clamp'});
          return (
            <g key={`${edge.from}-${edge.to}`} opacity={opacity}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke={colors.accent} strokeWidth={lineWidth.normal} />
              {edge.label ? (
                <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 10}
                  fill={colors.secondary} fontSize={16} textAnchor="middle">
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* 节点 */}
      {positioned.map((node, i) => {
        const opacity = interpolate(frame, [8 + i * 6, 22 + i * 6], [0, 1], {extrapolateRight: 'clamp'});
        return (
          <div key={node.id} style={{
            position: 'absolute',
            left: node.x - 90, top: node.y - 40,
            width: 180, minHeight: 80,
            borderRadius: 14,
            border: `1.5px solid ${colors.accentSoft}`,
            background: `${colors.accent}14`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '12px 16px',
            opacity,
          }}>
            <Typography variant="BodyLabel" color={colors.primary} style={{fontSize: 20, fontWeight: 600, textAlign: 'center'}}>
              {node.label}
            </Typography>
          </div>
        );
      })}

      {/* caption */}
      {caption ? (
        <div style={{
          position: 'absolute', left: 120, bottom: 80,
          opacity: interpolate(frame, [50, 65], [0, 1], {extrapolateRight: 'clamp'}),
        }}>
          <Typography variant="BodyLabel" color={colors.secondary} style={{fontSize: 18}}>
            {caption}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
