import { createRouter, createWebHistory } from 'vue-router'
import { auth, can, home } from './auth.js'
import { refreshBadges } from './badges.js'
import AdminLayout from './components/AdminLayout.vue'
import DashboardView from './views/DashboardView.vue'

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: (to, from, saved) => saved ?? (to.path === from.path ? undefined : { top: 0 }),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { guest: true, title: 'Sign in' } },
    // The rider app: a phone-sized page of the rider's own parcels.
    // Shown after signing in with a password an admin set: they pick their own before going on.
    { path: '/set-password', name: 'set-password', component: () => import('./views/SetPasswordView.vue'), meta: { title: 'Choose a password' } },
    { path: '/rider', name: 'rider', component: () => import('./views/RiderView.vue'), meta: { rider: true, title: 'My deliveries' } },
    {
      path: '/',
      component: AdminLayout,
      children: [
        { path: '', name: 'dashboard', component: DashboardView, meta: { area: 'dashboard', title: 'Dashboard' } },
        { path: 'orders', name: 'orders', component: () => import('./views/OrdersView.vue'), meta: { area: 'orders', title: 'Orders' } },
        { path: 'orders/:id', name: 'order', component: () => import('./views/OrderView.vue'), props: true, meta: { area: 'orders', title: 'Order' } },
        { path: 'products', name: 'products', component: () => import('./views/ProductsView.vue'), meta: { area: 'catalog', title: 'Products' } },
        { path: 'products/new', name: 'product-new', component: () => import('./views/ProductEditView.vue'), meta: { area: 'catalog', title: 'New product' } },
        { path: 'products/:id(\\d+)', name: 'product', component: () => import('./views/ProductEditView.vue'), props: true, meta: { area: 'catalog', title: 'Product' } },
        { path: 'customers', name: 'customers', component: () => import('./views/CustomersView.vue'), meta: { area: 'customers', title: 'Customers' } },
        { path: 'customers/:id', name: 'customer', component: () => import('./views/CustomerView.vue'), props: true, meta: { area: 'customers', title: 'Customer' } },
        { path: 'reviews', name: 'reviews', component: () => import('./views/ReviewsView.vue'), meta: { area: 'reviews', title: 'Reviews' } },
        { path: 'promotions', name: 'promotions', component: () => import('./views/PromosView.vue'), meta: { area: 'promos', title: 'Promotions' } },
        { path: 'emails', name: 'emails', component: () => import('./views/OutreachView.vue'), meta: { area: 'marketing', title: 'Emails' } },
        { path: 'returns', name: 'returns', component: () => import('./views/ReturnsView.vue'), meta: { area: 'returns', title: 'Returns' } },
        { path: 'returns/:id', name: 'return', component: () => import('./views/ReturnView.vue'), props: true, meta: { area: 'returns', title: 'Return' } },
        { path: 'analytics', name: 'analytics', component: () => import('./views/AnalyticsView.vue'), meta: { area: 'analytics', title: 'Analytics' } },
        { path: 'delivery', name: 'delivery', component: () => import('./views/DeliveryView.vue'), meta: { area: 'delivery', title: 'Delivery' } },
        { path: 'payments', name: 'payments', component: () => import('./views/PaymentsView.vue'), meta: { area: 'payments', title: 'Payments' } },
        { path: 'requests', name: 'requests', component: () => import('./views/RequestsView.vue'), meta: { area: 'requests', title: 'Requests' } },
        { path: 'content', name: 'content', component: () => import('./views/ContentView.vue'), meta: { area: 'content', title: 'Content' } },
        { path: 'content/stories/new', name: 'story-new', component: () => import('./views/StoryEditView.vue'), meta: { area: 'content', title: 'New story' } },
        { path: 'content/stories/:slug', name: 'story', component: () => import('./views/StoryEditView.vue'), props: true, meta: { area: 'content', title: 'Story' } },
        { path: 'team', name: 'team', component: () => import('./views/TeamView.vue'), meta: { area: 'team', title: 'Team & roles' } },
        { path: 'system', name: 'system', component: () => import('./views/SystemView.vue'), meta: { area: 'system', title: 'System' } },
        { path: ':pathMatch(.*)*', name: 'not-found', component: () => import('./views/NotFoundView.vue'), meta: { title: 'Not found' } },
      ],
    },
  ],
})

router.beforeEach((to) => {
  if (!to.meta.guest && !auth.user) return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
  if (to.meta.guest && auth.user) return home()
  if (auth.user?.passwordTemporary && to.name !== 'set-password' && !to.meta.guest) return { name: 'set-password', query: { redirect: to.fullPath } }
  if (to.name === 'set-password') return auth.user?.passwordTemporary ? true : home()
  // Riders only ever see the rider app; staff never need it.
  if (auth.user && !to.meta.guest && !!to.meta.rider !== (auth.user.role === 'RIDER')) return home()
  // Pages outside the user's role: back to the dashboard, which every staff role can see.
  if (to.meta.area && !can(`${to.meta.area}.read`)) return to.name === 'dashboard' ? true : { name: 'dashboard', query: { denied: to.meta.title } }
})

router.afterEach((to) => {
  document.title = `${to.meta.title ?? 'Admin'} · Cartly ${to.meta.rider ? 'Rider' : 'Admin'}`
  if (auth.user && auth.user.role !== 'RIDER' && !auth.user.passwordTemporary) refreshBadges()
})

export default router
