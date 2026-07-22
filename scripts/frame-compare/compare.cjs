/**
 * 帧一致性对比：Renderer PNG（1920x1080）vs Player 截图（缩放对齐后 pixelmatch）。
 * 用法: node compare.mjs <renderer.png> <player.png>
 * 输出: diff 像素比例；>5% 非零退出。
 */
const fs = require('node:fs');
const {PNG} = require('pngjs');
const pmModule = require('pixelmatch');
const pixelmatch = pmModule.default ?? pmModule;

const [, , rendererPath, playerPath] = process.argv;
if (!rendererPath || !playerPath) {
  console.error('usage: node compare.mjs <renderer.png> <player.png>');
  process.exit(2);
}

const r = PNG.sync.read(fs.readFileSync(rendererPath));
const p = PNG.sync.read(fs.readFileSync(playerPath));

// 把 renderer 图 box-sample 缩放到 player 尺寸
function downscale(src, dstW, dstH) {
  const dst = new PNG({width: dstW, height: dstH});
  const xRatio = src.width / dstW;
  const yRatio = src.height / dstH;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(src.width, Math.ceil((x + 1) * xRatio));
      const y0 = Math.floor(y * yRatio);
      const y1 = Math.min(src.height, Math.ceil((y + 1) * yRatio));
      let rs = 0, gs = 0, bs = 0, as = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) << 2;
          rs += src.data[i]; gs += src.data[i + 1]; bs += src.data[i + 2]; as += src.data[i + 3];
          n++;
        }
      }
      const j = (y * dstW + x) << 2;
      dst.data[j] = rs / n; dst.data[j + 1] = gs / n; dst.data[j + 2] = bs / n; dst.data[j + 3] = as / n;
    }
  }
  return dst;
}

const rs = downscale(r, p.width, p.height);
const diffPx = pixelmatch(rs.data, p.data, null, p.width, p.height, {threshold: 0.15});
const total = p.width * p.height;
const ratio = diffPx / total;
console.log(
  `${require('node:path').basename(rendererPath)} vs ${require('node:path').basename(playerPath)}: ` +
  `diff=${diffPx}px (${(ratio * 100).toFixed(2)}%) threshold=0.15`,
);
process.exit(ratio <= 0.05 ? 0 : 1);
