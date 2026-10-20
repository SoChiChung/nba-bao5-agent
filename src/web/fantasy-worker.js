import { buildFantasyPlans } from './fantasy-model.js';

self.addEventListener('message', ({ data }) => {
  try {
    self.postMessage(buildFantasyPlans(data.data, data.options));
  } catch (error) {
    self.postMessage({ error:error?.message ?? '方案计算失败，请调整规划条件后重试。' });
  }
});
