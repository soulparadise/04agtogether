import identity from './identity.json' with { type: 'json' };
export const EXTENSION_ID = identity.id;
export const APP_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://localhost:3000', 'https://soulparadise.ru'];
export const DEFAULT_APP_ORIGIN = typeof __APP_ORIGIN__ === 'string' ? __APP_ORIGIN__ : 'http://127.0.0.1:5173';
