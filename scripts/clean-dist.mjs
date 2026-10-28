import { rmSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const target = path.resolve(root, 'dist');
if (path.dirname(target) !== root || path.basename(target) !== 'dist') {
  throw new Error('拒绝删除非工程 dist 目录：' + target);
}
rmSync(target, { recursive: true, force: true });
