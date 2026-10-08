import {integer, sqliteTable, text, index} from 'drizzle-orm/sqlite-core';
export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(), number: text('number').notNull().unique(),
  body: text('body').notNull(), version: integer('version').notNull(),
});
export const settings = sqliteTable('settings', {key: text('key').primaryKey(), value: text('value').notNull()});
export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(), expires: integer('expires').notNull(), authVersion: text('auth_version').notNull(),
}, table => [index('sessions_expiry_idx').on(table.expires)]);
export const loginAttempts = sqliteTable('login_attempts', {
  key: text('key').primaryKey(), windowStart: integer('window_start').notNull(), count: integer('count').notNull(),
});
