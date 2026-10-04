import { register } from 'node:module';
register(new URL('./sql-loader.mjs', import.meta.url), import.meta.url);
