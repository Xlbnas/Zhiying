/**
 * TTS-C.1A.R1 compose mount 分离（§十）：
 * - Web：materialization 专用 mount :ro（可只读校验 existing projection，不能创建/temp/rename）；
 * - Worker：同一 mount :rw（唯一 rw writer）；
 * - adapter：无 materialization mount；
 * - env 缺失 fail-closed（`:?` 强制语法）；
 * - TTS-A voice-library Web 写入不回退（/app/data 主挂载仍 rw 在 Web/Worker）；
 * - registry mount 不变（adapter /config/voice-registry.json:ro + /voices:ro）。
 */
import fs from 'node:fs';
import {ok, summary} from './lib/tts-c1a-test-utils';

(async () => {
  const compose = fs.readFileSync('docker-compose.production.yml', 'utf8');

  // 1) env fail-closed：专用 mount 必须 :? 强制（缺失即 compose 拒绝）
  ok(compose.includes('${ZHIYING_HOST_MATERIALIZATIONS_DIR:?ZHIYING_HOST_MATERIALIZATIONS_DIR required}'), 'CM-01 env 缺失 fail-closed（:? 强制）');

  // 2) Web :ro
  const webBlock = compose.split('zhiying-worker:')[0].split('zhiying-web:')[1];
  ok(
    webBlock.includes('/app/data/voice-materializations:ro'),
    'CM-02 Web materialization mount :ro',
  );
  ok(!webBlock.includes('/app/data/voice-materializations:rw'), 'CM-02b Web 无 rw materialization mount');

  // 3) Worker :rw（服务定义 = 2 空格缩进，避开 depends_on 内的引用）
  const workerBlock = compose.split('zhiying-web:')[1].split('\n  indextts2-adapter:')[0];
  ok(
    workerBlock.includes('/app/data/voice-materializations:rw'),
    'CM-03 Worker materialization mount :rw',
  );

  // 4) adapter 无 materialization mount
  const adapterBlock = compose.split('\n  indextts2-adapter:')[1] ?? '';
  ok(!adapterBlock.includes('voice-materializations'), 'CM-04 adapter 无 materialization mount');
  ok(adapterBlock.includes('/config/voice-registry.json:ro') && adapterBlock.includes('/voices:ro'), 'CM-04b adapter registry mount 不变（:ro）');

  // 5) Web/Worker 主 data 挂载仍 rw（TTS-A voice-library Web 写入不回退）
  ok(compose.split('zhiying-web:')[1].split('zhiying-worker:')[0].includes('${ZHIYING_HOST_DATA_DIR:?ZHIYING_HOST_DATA_DIR required}:/app/data\n'), 'CM-05 Web /app/data 主挂载保留 rw');
  ok(workerBlock.includes('${ZHIYING_HOST_DATA_DIR:?ZHIYING_HOST_DATA_DIR required}:/app/data'), 'CM-05b Worker /app/data 主挂载保留 rw');

  // 6) 子路径挂载覆盖顺序：materialization mount 出现在 data 挂载之后（子路径覆盖生效）
  const webDataIdx = webBlock.indexOf(':/app/data\n');
  const webMatIdx = webBlock.indexOf(':/app/data/voice-materializations');
  ok(webDataIdx !== -1 && webMatIdx > webDataIdx, 'CM-06 子路径挂载在 data 之后（覆盖生效）', {dataIdx: webDataIdx, matIdx: webMatIdx});

  summary('TTS-C.1A compose-mounts');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
