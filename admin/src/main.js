import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router.js'
import { handleUnauthorized } from './api.js'
import { restore, signOut } from './auth.js'
import { toast } from './toast.js'
import { vCan } from './can.js'

handleUnauthorized(() => {
  signOut()
  const here = router.currentRoute.value
  if (here.name !== 'login') {
    toast('Your session has ended. Sign in again to continue.', 'error')
    router.replace({ name: 'login', query: { redirect: here.fullPath } })
  }
})

restore().then(() => createApp(App).use(router).directive('can', vCan).mount('#app'))
