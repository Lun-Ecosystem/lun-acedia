import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/cormorant-garamond/500.css';
import '@lun-ecosystem/lunacedia-views/styles.css';
import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';
import App from './App.svelte';

registerSW({ immediate: true });

mount(App, { target: document.getElementById('app')! });
