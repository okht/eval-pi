import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createModels } from '../server/models.mjs';

if (!process.env.APPDATA) throw new Error('请在 Windows 的 EvalPi 桌面环境运行');
const dataDir = path.join(process.env.APPDATA, 'EvalPi', 'workspace', 'models');
const models = await createModels({ dataDir });
try {
  const status = await models.status();
  if (!status.authenticated || status.authMode !== 'subscription') throw new Error('请先在 EvalPi 中完成 ChatGPT 订阅登录');
  await writeFile(new URL('../examples/openai-customer-service/.evalpi-local.json', import.meta.url), JSON.stringify({
    authPath: path.join(dataDir, 'models', 'auth.json'), provider: status.provider, model: status.model,
  }, null, 2), { mode: 0o600 });
  console.log(`Target model configured: ${status.provider}/${status.model}; credentials were not copied.`);
} finally {
  await models.dispose();
}
