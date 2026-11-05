// What each staff role may do in the admin panel. This file is the one place to change it:
// the API enforces it on every admin route, and /auth/me sends the signed-in user's list to
// the admin panel, which hides or locks what they can't do.
//
// A permission is `<area>.read` or `<area>.write`. Admin routes declare their area with
// @Staff('<area>'); GET needs `.read`, anything else needs `.write`.

export const AREAS = {
  dashboard: 'Dashboard',
  orders: 'Orders',
  catalog: 'Products & try-on',
  content: 'Content',
  promos: 'Promotions',
  marketing: 'Emails to shoppers',
  customers: 'Customers',
  reviews: 'Reviews',
  requests: 'Requests',
  returns: 'Returns',
  delivery: 'Delivery',
  payments: 'Payments',
  refunds: 'Refunds',
  analytics: 'Analytics',
  settings: 'Gateways, couriers & policies',
  team: 'Team & roles',
  system: 'System',
} as const;
export type Area = keyof typeof AREAS;
export type Permission = `${Area}.${'read' | 'write'}`;

export const STAFF_ROLES = [
  'ADMIN',
  'MANAGER',
  'SUPPORT',
  'MERCHANDISER',
  'ANALYST',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const isStaff = (role: string): role is StaffRole =>
  (STAFF_ROLES as readonly string[]).includes(role);

const all = Object.keys(AREAS) as Area[];
const rw = (...areas: Area[]) =>
  areas.flatMap((a) => [`${a}.read`, `${a}.write`] as Permission[]);
const ro = (...areas: Area[]) => areas.map((a) => `${a}.read` as Permission);
// Read-only areas: the dashboard and analytics have nothing to change; refunds are an action only.
const READ_ONLY: Area[] = ['dashboard', 'analytics'];
const WRITE_ONLY: Area[] = ['refunds'];
const valid = (p: Permission) => {
  const [area, kind] = p.split('.') as [Area, string];
  return kind === 'read'
    ? !WRITE_ONLY.includes(area)
    : !READ_ONLY.includes(area);
};

export const ROLES: Record<
  StaffRole,
  { label: string; summary: string; permissions: Permission[] }
> = {
  ADMIN: {
    label: 'Admin',
    summary:
      'Everything, including the team, payment and courier credentials, and system settings.',
    permissions: rw(...all),
  },
  MANAGER: {
    label: 'Manager',
    summary:
      'Runs the store day to day: orders, catalogue, promotions, emails to shoppers, customers, returns, refunds and delivery. Can’t manage the team or credentials.',
    permissions: [
      ...rw(
        'dashboard',
        'orders',
        'catalog',
        'content',
        'promos',
        'marketing',
        'customers',
        'reviews',
        'requests',
        'returns',
        'delivery',
        'payments',
        'refunds',
        'analytics',
      ),
      ...ro('settings'),
    ],
  },
  SUPPORT: {
    label: 'Support',
    summary:
      'Helps customers: orders, customer accounts, returns, delivery, reviews and requests. Sees payments but can’t refund.',
    permissions: [
      ...rw(
        'dashboard',
        'orders',
        'customers',
        'returns',
        'delivery',
        'reviews',
        'requests',
      ),
      ...ro('payments', 'catalog', 'promos'),
    ],
  },
  MERCHANDISER: {
    label: 'Merchandiser',
    summary:
      'Looks after what’s on sale: products, try-on, content, promotions and emails to shoppers. Sees analytics.',
    permissions: [
      ...rw(
        'dashboard',
        'catalog',
        'content',
        'promos',
        'marketing',
        'reviews',
        'requests',
        'analytics',
      ),
      ...ro('orders'),
    ],
  },
  ANALYST: {
    label: 'Analyst',
    summary:
      'Read-only: can look at everything except the team, credentials and system, and can’t change anything.',
    permissions: ro(
      'dashboard',
      'orders',
      'catalog',
      'content',
      'promos',
      'marketing',
      'customers',
      'reviews',
      'requests',
      'returns',
      'delivery',
      'payments',
      'analytics',
    ),
  },
};
for (const r of Object.values(ROLES))
  r.permissions = [...new Set(r.permissions)].filter(valid);

export const permissionsOf = (role: string): Permission[] =>
  isStaff(role) ? ROLES[role].permissions : [];
export const can = (role: string, p: Permission) =>
  permissionsOf(role).includes(p);
