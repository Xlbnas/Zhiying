/**
 * TTS-C.1A 常量（设计文档 docs/TTS_C_1A_MATERIALIZATION_IMPLEMENTATION.md §1-§5）。
 * 修改 canonical 参数必须 bump 版本常量（frozen contract 语义 fail-closed）。
 */

// 投影根（dataDir 下与 voice-library 同级分离；DB 只存 root-relative path）
export const MATERIALIZATION_ROOT_DIR = 'voice-materializations';
export const MATERIALIZATION_CANONICAL_FILENAME = 'reference.wav';

// 目标路径模板：<voice-root>/<profile_id>/<revision_id>/reference.wav
export const DESTINATION_PATH_TEMPLATE = '<profile_id>/<revision_id>/reference.wav';

// validation / execution lease（毫秒）
export const MATERIALIZATION_VALIDATION_LEASE_MS = 15 * 60 * 1000; // 与 generation lease 对齐
export const MATERIALIZATION_EXECUTION_LEASE_MS = 15 * 60 * 1000;

// Worker heartbeat 间隔
export const MATERIALIZATION_HEARTBEAT_INTERVAL_MS = 15 * 1000;

// 源文件打开 flag：no-follow 读取
export const SOURCE_OPEN_FLAG = 'r';
export const TEMP_OPEN_FLAG = 'wx'; // 独占创建（staging 同目录）

// 1A 终态
export const FILE_READY_UNPUBLISHED = 'file_ready_unpublished';
