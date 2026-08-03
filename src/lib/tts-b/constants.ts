/**
 * TTS-B 集中常量（设计文档 docs/TTS_B_ASSIGNMENT_PERFORMANCE_DESIGN.md §3/§5/§8）。
 * 修改任何 canonical 参数必须 bump 对应版本常量（source identity 随之失效，fail-closed）。
 */

// artifact kinds（artifacts 表 append-only）
export const PROJECT_VOICE_ASSIGNMENT_KIND = 'project_voice_assignment';
export const NARRATION_PERFORMANCE_PLAN_KIND = 'narration_performance_plan';

// schema / compiler / prompt 版本
export const PROJECT_VOICE_ASSIGNMENT_SCHEMA_VERSION = 'project-voice-assignment@1.0';
export const PROJECT_VOICE_ASSIGNMENT_COMPILER_VERSION = '1.0';
export const NARRATION_PERFORMANCE_PLAN_SCHEMA_VERSION = 'narration-performance-plan@1.0';
export const NARRATION_PERFORMANCE_PLAN_COMPILER_VERSION = '1.0';
export const NARRATION_PERFORMANCE_PLAN_PROMPT_VERSION = 'narration-performance-plan@1.0';

// generation stage（复用 generation_runs / generation_dispatch_jobs）
export const PERFORMANCE_USAGE_STAGE = 'm7_narration_performance_plan';

// 依赖的 frozen 常量（引用而非复制）
export const NARRATION_PLAN_V2_ARTIFACT_KIND = 'narration_plan_v2';
export const NARRATION_PLAN_V2_SCHEMA_VERSION = 'narration-plan@2.0';
export const NARRATION_V2_COMPILER_VERSION = '2.0';
export const VOICE_PROFILE_REVISION_SCHEMA_VERSION = 'voice-profile-revision@1.0';
export const VOICE_PROVIDER = 'indextts2';
export const ADAPTER_COMPATIBILITY_KEY = 'indextts2-adapter-registry@1';
