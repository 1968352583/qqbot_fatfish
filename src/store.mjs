import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { defaults, validateConfig, chinaDate, monthKey } from './config.mjs';

const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const digest = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(path, { now = Date.now } = {}) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, openid TEXT UNIQUE NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        prefs TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0, last_inbound INTEGER NOT NULL DEFAULT 0,
        last_proactive INTEGER NOT NULL DEFAULT 0, busy_until INTEGER NOT NULL DEFAULT 0, pause_until INTEGER NOT NULL DEFAULT 0,
        proactive_day TEXT NOT NULL DEFAULT '', proactive_count INTEGER NOT NULL DEFAULT 0, unanswered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), remote_id TEXT UNIQUE,
        role TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, sources TEXT NOT NULL DEFAULT '[]', memories TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS messages_user_at ON messages(user_id, at);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, sources TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, due INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '', next_try INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, month TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS replies (remote_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (remote_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    `);
    const reminderColumns = new Set(this.db.prepare('PRAGMA table_info(reminders)').all().map(row => row.name));
    for (const [name, initial] of [['delivery_text', "''"], ['delivery_sources', "'[]'"], ['delivery_memories', "'[]'"], ['source_ids', "'[]'"]]) {
      if (!reminderColumns.has(name)) this.db.exec(`ALTER TABLE reminders ADD COLUMN ${name} TEXT NOT NULL DEFAULT ${initial}`);
    }
    this.db.prepare("UPDATE reminders SET status='uncertain', note='发送时进程中断，请核对 QQ；不会自动重复发送' WHERE status='sending'").run();
    this.db.prepare("UPDATE usage SET status='estimated' WHERE status='reserved'").run();
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  config() { const row = this.db.prepare("SELECT value FROM settings WHERE key='config'").get(); return { ...defaults, ...(row ? parse(row.value) : {}) }; }
  updateConfig(patch) { const value = validateConfig(patch, this.config()); for (const user of this.users()) validateConfig(user.prefs, value, true); this.db.prepare("INSERT INTO settings VALUES ('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json(value)); return value; }
  user(id) { const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id); return row && { ...row, enabled: Boolean(row.enabled), prefs: parse(row.prefs) }; }
  byOpenid(openid) { const row = this.db.prepare('SELECT id FROM users WHERE openid=?').get(openid); return row && this.user(row.id); }
  users() { return this.db.prepare('SELECT id FROM users ORDER BY rowid').all().map(row => this.user(row.id)); }
  addUser(openid, name = '新朋友') {
    const existing = this.byOpenid(openid); if (existing) return existing;
    const id = randomUUID(); this.db.prepare('INSERT INTO users(id,openid,name) VALUES (?,?,?)').run(id, openid, name.slice(0, 50)); return this.user(id);
  }
  updateUser(id, { name, enabled, prefs } = {}) {
    const user = this.user(id); if (!user) throw new Error('用户不存在。');
    if (prefs !== undefined) validateConfig(prefs, this.config(), true);
    this.db.prepare('UPDATE users SET name=?, enabled=?, prefs=?, revision=revision+1 WHERE id=?').run(
      typeof name === 'string' ? name.slice(0, 50) : user.name, enabled === undefined ? Number(user.enabled) : Number(Boolean(enabled)), json(prefs ?? user.prefs), id);
    return this.user(id);
  }
  preferences(id) { const config = this.config(); const user = this.user(id); return { ...config, ...user.prefs, enabled: config.enabled && user.enabled, proactiveEnabled: config.proactiveEnabled && (user.prefs.proactiveEnabled ?? config.proactiveEnabled) }; }
  invite() { const code = randomBytes(8).toString('hex'); this.db.prepare('INSERT INTO invites VALUES (?,?,0)').run(digest(code), this.now() + 86400000); return code; }
  join(openid, code) { return this.transaction(() => { const row = this.db.prepare('SELECT * FROM invites WHERE hash=?').get(digest(code)); if (!row || row.used || row.expires < this.now()) return null; const user = this.addUser(openid); this.db.prepare('UPDATE invites SET used=1 WHERE hash=?').run(row.hash); return user; }); }
  inbound(userId, remoteId, content, kind, at = this.now()) {
    if (this.db.prepare('SELECT 1 FROM receipts WHERE remote_id=?').get(remoteId)) return null;
    this.db.prepare('INSERT INTO receipts VALUES (?,?)').run(remoteId, this.now());
    const id = this.message(userId, 'user', content, { remoteId, kind, at });
    this.db.prepare('UPDATE users SET last_inbound=?, busy_until=0, pause_until=0, unanswered=0, revision=revision+1 WHERE id=?').run(this.now(), userId);
    return id;
  }
  message(userId, role, content, { remoteId = null, kind = 'text', at = this.now(), sources = [], memories = [] } = {}) {
    const id = randomUUID(); this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)').run(id, userId, remoteId, role, content.slice(0, 20000), kind, at, json(sources), json(memories)); return id;
  }
  messages(userId, { limit = 100, offset = 0, context = false } = {}) {
    return this.db.prepare(`SELECT * FROM messages WHERE user_id=? ${context ? "AND kind != 'command'" : ''} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`).all(userId, limit, offset).reverse().map(row => ({ ...row, sources: parse(row.sources), memories: parse(row.memories) }));
  }
  memories(userId) { return this.db.prepare('SELECT * FROM memories WHERE user_id=? ORDER BY at').all(userId).map(row => ({ ...row, sources: parse(row.sources) })); }
  remember(userId, text, sources = []) {
    const value = text.trim().slice(0, 500); if (!value) return;
    if (this.memories(userId).some(row => row.text === value)) return;
    const id = randomUUID(); this.db.prepare('INSERT INTO memories VALUES (?,?,?,?,?)').run(id, userId, value, json(sources), this.now()); return id;
  }
  forget(userId, { memoryId, messageId, keyword, replacement } = {}) {
    const result = this.transaction(() => {
      const memories = this.memories(userId);
      const selected = memories.filter(m => m.id === memoryId || (keyword && m.text.includes(keyword)));
      if (memoryId && selected.length === 0) throw new Error('记忆不存在。');
      const deletedMemory = new Set(selected.map(m => m.id));
      const deleted = new Set([messageId, ...selected.flatMap(m => m.sources)].filter(Boolean));
      const rows = this.db.prepare('SELECT * FROM messages WHERE user_id=?').all(userId);
      const reminders = this.db.prepare('SELECT * FROM reminders WHERE user_id=?').all(userId), deletedReminders = new Set();
      for (const row of rows) if (keyword && row.content.includes(keyword)) deleted.add(row.id);
      let changed = true;
      while (changed) {
        changed = false;
        for (const reminder of reminders) if (!deletedReminders.has(reminder.id) && ((keyword && reminder.text.includes(keyword)) || parse(reminder.source_ids).some(id => deleted.has(id)))) {
          deletedReminders.add(reminder.id); deleted.add(`reminder:${reminder.id}`); changed = true;
        }
        for (const m of memories) if (!deletedMemory.has(m.id) && m.sources.some(id => deleted.has(id))) { deletedMemory.add(m.id); changed = true; }
        for (const row of rows) if (!deleted.has(row.id) && (parse(row.sources).some(id => deleted.has(id)) || parse(row.memories).some(id => deletedMemory.has(id)))) { deleted.add(row.id); changed = true; }
      }
      let messageCount = 0;
      for (const id of deleted) messageCount += this.db.prepare('DELETE FROM messages WHERE id=? AND user_id=?').run(id, userId).changes;
      for (const id of deletedMemory) this.db.prepare('DELETE FROM memories WHERE id=? AND user_id=?').run(id, userId);
      for (const id of deletedReminders) this.db.prepare('DELETE FROM reminders WHERE id=? AND user_id=?').run(id, userId);
      for (const reminder of this.db.prepare('SELECT * FROM reminders WHERE user_id=?').all(userId)) {
        if (parse(reminder.delivery_sources).some(id => deleted.has(id)) || parse(reminder.delivery_memories).some(id => deletedMemory.has(id))) {
          this.db.prepare("UPDATE reminders SET delivery_text='', delivery_sources='[]', delivery_memories='[]' WHERE id=?").run(reminder.id);
        }
      }
      this.db.prepare('UPDATE users SET revision=revision+1 WHERE id=?').run(userId);
      if (replacement) this.remember(userId, replacement);
      return { messages: messageCount, memories: deletedMemory.size, reminders: deletedReminders.size };
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return result;
  }
  prune() { const cutoff = this.now() - this.config().retentionDays * 86400000; this.db.prepare('DELETE FROM messages WHERE at<?').run(cutoff); this.db.prepare('DELETE FROM replies WHERE at<?').run(this.now() - 86400000); this.db.prepare('DELETE FROM receipts WHERE at<?').run(this.now() - 30 * 86400000); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
  replySequence(remoteId) { return this.transaction(() => { const row = this.db.prepare('SELECT count FROM replies WHERE remote_id=?').get(remoteId); const next = (row?.count ?? 0) + 1; if (next > 4) throw new Error('本条消息回复额度已用完。'); this.db.prepare('INSERT INTO replies VALUES (?,?,?) ON CONFLICT(remote_id) DO UPDATE SET count=excluded.count').run(remoteId, next, this.now()); return next; }); }
  usage() {
    const config = this.config(); const spent = this.db.prepare('SELECT COALESCE(SUM(amount),0) total FROM usage WHERE month=?').get(monthKey(this.now())).total;
    const limit = Math.max(0, config.totalBudget - config.fixedReserve - config.safetyReserve);
    const percent = limit ? spent / limit * 100 : 100;
    return { month: monthKey(this.now()), spent, limit, percent, level: percent >= 100 ? 'stopped' : percent >= config.reducePercent ? 'reduced' : percent >= config.warnPercent ? 'warning' : 'normal' };
  }
  reserve(kind, amount, optional = false) {
    return this.transaction(() => { const usage = this.usage(); if ((optional && ['reduced', 'stopped'].includes(usage.level)) || usage.spent + amount > usage.limit || usage.level === 'stopped') throw new Error('预算额度不足，已暂停新的付费请求。'); const id = randomUUID(); this.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?)').run(id, monthKey(this.now()), kind, amount, 'reserved', this.now()); return id; });
  }
  settle(id, amount, status = 'settled') { if (Number.isFinite(amount) && amount >= 0) this.db.prepare('UPDATE usage SET amount=?, status=? WHERE id=?').run(amount, status, id); else this.db.prepare("UPDATE usage SET status='estimated' WHERE id=?").run(id); }
  reminder(userId, text, due, { sources = [] } = {}) {
    if (!Number.isFinite(due) || due <= this.now() || due > this.now() + 366 * 86400000) throw new Error('这个时间已经过去了，或者离现在太远了。换一个未来一年内的时间好吗？');
    const existing = this.db.prepare("SELECT id, source_ids FROM reminders WHERE user_id=? AND text=? AND due=? AND status='pending'").get(userId, text.slice(0, 500), due);
    if (existing) { this.db.prepare('UPDATE reminders SET source_ids=? WHERE id=?').run(json([...new Set([...parse(existing.source_ids), ...sources])]), existing.id); return existing.id; }
    const id = randomUUID(); this.db.prepare('INSERT INTO reminders(id,user_id,text,due,source_ids) VALUES (?,?,?,?,?)').run(id, userId, text.slice(0, 500), due, json(sources)); return id;
  }
  upcomingReminders(userId) { return this.db.prepare("SELECT * FROM reminders WHERE user_id=? AND status='pending' ORDER BY due LIMIT 50").all(userId); }
  prepareReminderDelivery(userId, id, text, { sources = [], memories = [] } = {}) {
    return this.db.prepare("UPDATE reminders SET delivery_text=?, delivery_sources=?, delivery_memories=? WHERE id=? AND user_id=? AND status='pending'").run(text.slice(0, 500), json(sources), json(memories), id, userId).changes;
  }
  reminders(userId) { return userId ? this.db.prepare('SELECT * FROM reminders WHERE user_id=? ORDER BY due DESC LIMIT 200').all(userId) : this.db.prepare('SELECT * FROM reminders ORDER BY due DESC LIMIT 200').all(); }
  cancelReminder(userId, id) { return this.db.prepare("UPDATE reminders SET status='cancelled' WHERE user_id=? AND id=? AND status='pending'").run(userId, id).changes; }
  dueReminders() { return this.db.prepare("SELECT * FROM reminders WHERE status='pending' AND due<=? AND next_try<=? ORDER BY due").all(this.now(), this.now()); }
  pendingReminder(id) { return this.db.prepare("SELECT * FROM reminders WHERE id=? AND status='pending'").get(id); }
  markReminder(id, status, note = '', nextTry = 0) { this.db.prepare('UPDATE reminders SET status=?, note=?, next_try=? WHERE id=?').run(status, note, nextTry, id); }
  busy(id) { this.db.prepare('UPDATE users SET busy_until=? WHERE id=?').run(this.now() + this.preferences(id).busyHours * 3600000, id); }
  initiated(id) {
    const user = this.user(id), p = this.preferences(id), day = chinaDate(this.now());
    const count = user.proactive_day === day ? user.proactive_count + 1 : 1;
    const unanswered = user.pause_until && user.pause_until <= this.now() ? 1 : user.unanswered + 1;
    this.db.prepare('UPDATE users SET proactive_day=?, proactive_count=?, last_proactive=?, unanswered=?, pause_until=? WHERE id=?').run(day, count, this.now(), unanswered, unanswered >= p.unansweredLimit ? this.now() + p.unansweredPauseHours * 3600000 : 0, id);
  }
}
