import { createRouter, createWebHistory } from 'vue-router'
import { auth } from './auth.js'
import AppLayout from './components/AppLayout.vue'
import ExploreView from './views/ExploreView.vue'

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: (to, from, saved) => saved ?? (to.path === from.path ? undefined : { top: 0 }),
  routes: [
    {
      path: '/',
      component: AppLayout,
      // Browsing is open to everyone; only the shopper's own things (cart, orders, account…) need a sign-in.
      children: [
        { path: '', name: 'explore', component: ExploreView, meta: { title: 'Explore' } },
        { path: 'shop', name: 'shop', component: () => import('./views/CatalogView.vue'), props: { mode: 'shop' }, meta: { title: 'All products' } },
        { path: 'popular', name: 'popular', component: () => import('./views/CatalogView.vue'), props: { mode: 'popular' }, meta: { title: 'Popular products' } },
        { path: 'category/:slug', name: 'category', component: () => import('./views/CatalogView.vue'), props: (r) => ({ mode: 'category', slug: r.params.slug }) },
        { path: 'collection/:slug', name: 'collection', component: () => import('./views/CatalogView.vue'), props: (r) => ({ mode: 'collection', slug: r.params.slug }) },
        { path: 'product/:id', name: 'product', component: () => import('./views/ProductView.vue'), props: true },
        { path: 'inspiration', name: 'inspiration', component: () => import('./views/InspirationView.vue'), meta: { title: 'Inspiration' } },
        { path: 'inspiration/:slug', name: 'story', component: () => import('./views/StoryView.vue'), props: true },
        { path: 'favourites', name: 'favourites', component: () => import('./views/FavouritesView.vue'), meta: { title: 'Favourites', requiresAuth: true } },
        { path: 'cart', name: 'cart', component: () => import('./views/CartView.vue'), meta: { title: 'Cart', requiresAuth: true } },
        { path: 'checkout', name: 'checkout', component: () => import('./views/CheckoutView.vue'), meta: { title: 'Checkout', requiresAuth: true } },
        { path: 'orders', name: 'orders', component: () => import('./views/OrdersView.vue'), meta: { title: 'Orders', requiresAuth: true } },
        { path: 'orders/:id', name: 'order', component: () => import('./views/OrderView.vue'), props: true, meta: { title: 'Order', requiresAuth: true } },
        { path: 'request', name: 'request', component: () => import('./views/RequestView.vue'), meta: { title: 'Request a product', requiresAuth: true } },
        { path: 'promise', name: 'promise', component: () => import('./views/PromiseView.vue'), meta: { title: 'Our promise' } },
        { path: 'festival', name: 'festival', component: () => import('./views/FestivalPlannerView.vue'), meta: { title: 'Family outfit planner' } },
        { path: 'style', name: 'style', component: () => import('./views/StyleQuizView.vue'), meta: { title: 'Style quiz' } },
        { path: 'looks', name: 'looks', component: () => import('./views/LooksView.vue'), meta: { title: 'Family votes' } },
        { path: 'team', name: 'team', component: () => import('./views/TeamView.vue'), meta: { title: 'Team', requiresAuth: true } },
        { path: 'account', name: 'account', component: () => import('./views/AccountView.vue'), meta: { title: 'Account', requiresAuth: true } },
        { path: ':pathMatch(.*)*', name: 'not-found', component: () => import('./views/NotFoundView.vue'), meta: { title: 'Not found' } },
      ],
    },
    // "Ask family" voting page: no account and no shop chrome, for whoever the link was sent to.
    { path: '/look/:token', name: 'look', component: () => import('./views/LookView.vue'), props: true, meta: { title: 'Help choose a look' } },
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { guest: true, title: 'Log in' } },
    { path: '/signup', name: 'signup', component: () => import('./views/SignupView.vue'), meta: { guest: true, title: 'Sign up' } },
  ],
})

router.beforeEach((to) => {
  if (to.matched.some((r) => r.meta.requiresAuth) && !auth.user) return { name: 'login', query: { redirect: to.fullPath } }
  if (to.meta.guest && auth.user) return { name: 'explore' }
})

router.afterEach((to) => {
  if (to.meta.title) document.title = `${to.meta.title} · Cartly`
})

export default router
