import { pathao } from './pathao.js';
import { redx } from './redx.js';
import { steadfast } from './steadfast.js';
import type { Courier, CourierId } from './types.js';

/** The three couriers most Bangladeshi online shops book with. */
export const COURIERS: Record<CourierId, Courier> = { pathao, steadfast, redx };
