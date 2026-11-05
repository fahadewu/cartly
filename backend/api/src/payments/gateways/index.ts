import { bkash } from './bkash.js';
import { nagad } from './nagad.js';
import { sslcommerz } from './sslcommerz.js';
import type { Gateway, GatewayId } from './types.js';

export const GATEWAYS: Record<GatewayId, Gateway> = { bkash, nagad, sslcommerz };
