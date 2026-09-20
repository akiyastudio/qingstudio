import { t, type MessageKey } from './runtime';
const statusKeys: Record<string, MessageKey> = { '未分类': 'ui.uncategorized.54b89f', '策划中': 'status.planning', '待拍摄': 'status.awaitingShoot', '后期中': 'status.postProduction', '已归档': 'status.archived' };
export const projectStatusLabel = (status: string) => Object.prototype.hasOwnProperty.call(statusKeys, status) ? t(statusKeys[status]) : status;
