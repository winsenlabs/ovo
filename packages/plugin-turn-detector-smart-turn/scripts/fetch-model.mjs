// Fetches Smart Turn v3.2 (CPU, int8) into $OVO_TURN_MODELS_DIR/smart-turn/ at build time:
//   OVO_TURN_MODELS_DIR=/opt/ovo/models node scripts/fetch-model.mjs
// The file is pinned to a Hugging Face revision and checked against its SHA-256 (the LFS object id
// Hugging Face publishes for it); an existing file with the right hash is kept. BSD-2-Clause
// (github.com/pipecat-ai/smart-turn): redistributable with its copyright notice, which is written
// beside it. Not committed to git: 8.7 MB of weights would sit in every clone.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'pipecat-ai/smart-turn-v3';
const REVISION = 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93';
const FILE = 'smart-turn-v3.2-cpu.onnx';
const SHA256 = '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f';
const NOTICE = `Smart Turn v3.2 (${REPO}@${REVISION}), Copyright (c) 2024-2025, Daily. BSD 2-Clause License:
https://github.com/pipecat-ai/smart-turn/blob/main/LICENSE
`;

const root = process.env.OVO_TURN_MODELS_DIR;
if (!root) throw new Error('set OVO_TURN_MODELS_DIR to the models directory');
const dir = join(root, 'smart-turn');
const path = join(dir, FILE);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
mkdirSync(dir, { recursive: true });
if (existsSync(path) && sha(readFileSync(path)) === SHA256) {
  console.log(`${path}: present`);
} else {
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${FILE}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = sha(bytes);
  if (got !== SHA256) throw new Error(`${FILE}: SHA-256 ${got}, expected ${SHA256}`);
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
  console.log(`${path}: fetched (${bytes.length} bytes)`);
}
writeFileSync(join(dir, 'NOTICE'), NOTICE);
