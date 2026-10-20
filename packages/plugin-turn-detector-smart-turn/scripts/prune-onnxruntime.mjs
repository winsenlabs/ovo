// Image build step: keeps only this platform's onnxruntime-node binaries in a deployed app
// (`pnpm deploy --prod`). The package ships darwin, linux and win32 libraries (287 MB unpacked), of
// which linux/x64 is 46 MB. Run it on the build host, which is the image's platform:
//   node prune-onnxruntime.mjs /runtime/worker
// Fails loudly when this platform's binary is not there, so an image never ships without it.
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const app = process.argv[2];
if (!app) throw new Error('usage: prune-onnxruntime.mjs <deployed app directory>');
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const arch = process.env.TARGET_ARCH ?? process.arch;
const bins = join(realpathSync(join(app, 'node_modules', 'onnxruntime-node')), 'bin', 'napi-v6');
if (!existsSync(join(bins, platform, arch)))
  throw new Error(`onnxruntime-node has no ${platform}/${arch} binary in ${bins}`);
for (const other of readdirSync(bins)) {
  for (const cpu of readdirSync(join(bins, other)))
    if (other !== platform || cpu !== arch) rmSync(join(bins, other, cpu), { recursive: true });
  if (other !== platform) rmSync(join(bins, other), { recursive: true });
}
console.log(`onnxruntime-node: kept ${platform}/${arch} under ${bins}`);
