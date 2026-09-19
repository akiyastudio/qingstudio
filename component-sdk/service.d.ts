import type { ComponentServiceInboundFrame, HostCapability, HostCapabilityRequest, HostCapabilityResponse } from './index.js';
export interface ServiceHostClient { callHost<K extends HostCapability>(parentId: string, method: K, payload: HostCapabilityRequest<K>): Promise<HostCapabilityResponse<K>>; acceptFrame(frame: ComponentServiceInboundFrame): boolean; failAll(error: Error): void }
export function createServiceHostClient(options: { writeFrame(frame: unknown): void }): ServiceHostClient;
