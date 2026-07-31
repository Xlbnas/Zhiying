/**
 * 兼容层（M7.3A）：durable generation runs 已提取为通用模块
 * `@/lib/llm-generation/runs`（stage 参数化，M7.2 narrative beats 与
 * M7.3A visual intent 共用同一套 generation_runs/generation_attempts 表）。
 * 本 re-export 仅为不破坏既有 import 路径；新代码请直接引用通用模块。
 */
export * from '../llm-generation/runs';
