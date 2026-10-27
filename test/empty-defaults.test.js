'use strict';
// Issue #81: the configuration document — empty defaults, the publish protocol,
//
// the reader and lock rules, and a document that cannot be read.
//
// Split out of one file for #106: the real-CLI surfaces live in
// test/empty-defaults-cli.test.js. Nothing was removed in the split.
//
// The harness (CLI child env, scratch dirs, own-run helper) is shared with
// the other half: see test/helpers/empty-defaults-harness.js.

const { assert, crypto, fs, os, path, spawnSync, config, DEFAULTS, BUILT_IN_ROUTES, builtInRoute,
  loadConfig, saveConfig, configPath, vault, lifecycle, lockModule, getRuntimeSnapshot, cli,
  preload, MASTER, KEY_A, KEY_B, IS_ROOT, test, section, scratch, journals, envFor, run,
  inDataDir, upgradeWith, seeded, routeIds, freePort, underLock, PREV, docAt, deleteAt,
  ADD_AFTER, onReaderMiss, customDoc, OLD_DOC, NEW_DOC, nWriterSchedule, SIX_MISSES,
  countingAcquires, plantTicket, xiaomiPreload, churnRun, corruptRun, siteAt, readAt, OWN_READ,
  EXHAUSTED, xiaomiConfigured, CONFIG_READERS, configReaderCalls, keychainPreload,
  CORRUPT_NOTICE, RETRY_NOTICE, CORRUPT_DOCS, receipts, RECEIPT_ACK, freshReceipt,
  withLockedSecrets, REFUSAL, finish } = require('./helpers/empty-defaults-harness');

section('empty defaults');

test('DEFAULTS ships no routes, and the catalog holds the five built-ins', () => {
  assert.deepStrictEqual(DEFAULTS.routes, [], 'a fresh install must show no provider rows');
  assert.deepStrictEqual(BUILT_IN_ROUTES.map((r) => r.id), [
    'minimax-token-plan', 'kimi-code-plan', 'glm-coding-plan', 'deepseek-direct', 'openrouter-main',
  ], 'the offered built-ins are part of the contract');
  assert.ok(Object.isFrozen(BUILT_IN_ROUTES), 'the catalog must be frozen');
});

test('the catalog is frozen all the way down: no row and no match is mutable through the export', () => {
  // Object.isFrozen(BUILT_IN_ROUTES) alone passed while every row was mutable,
  // and builtInRoute() copies from those rows into setup and the migration.
  for (const row of BUILT_IN_ROUTES) {
    assert.ok(Object.isFrozen(row), `catalog row ${row.id} is mutable`);
    assert.ok(Object.isFrozen(row.match), `catalog row ${row.id}'s match is mutable`);
  }
  const kimi = BUILT_IN_ROUTES.find((r) => r.id === 'kimi-code-plan');
  assert.throws(() => { 'use strict'; kimi.match.model = 'changed-through-export'; }, TypeError,
    'a strict-mode write through the export must throw');
  assert.throws(() => { 'use strict'; kimi.provider = 'changed-through-export'; }, TypeError);
  assert.strictEqual(builtInRoute('kimi-code-plan').match.model, 'kimi',
    'a mutation through the export reached the copies setup writes');
  // Copies stay the caller's own, so freezing the source costs callers nothing.
  const copy = builtInRoute('kimi-code-plan');
  copy.match.model = 'mine';
  assert.strictEqual(builtInRoute('kimi-code-plan').match.model, 'kimi');
});

section('the write-level guard: only the migration may create config.json');

test('saveConfig refuses to CREATE config.json without the migration capability', () => {
  const dir = scratch();
  underLock(dir, () => {
    assert.throws(() => saveConfig({ routes: [] }), (e) => e.code === 'CONFIG_MIGRATION_PENDING');
    assert.throws(() => saveConfig({ routes: [] }, { capability: { capability: 'view-limits first config publish' } }),
      (e) => e.code === 'CONFIG_MIGRATION_PENDING', 'a look-alike capability must not pass: identity, not shape');
    assert.throws(() => saveConfig({ routes: [] }, { capability: 'view-limits first config publish' }),
      (e) => e.code === 'CONFIG_MIGRATION_PENDING', 'a string must not pass');
    assert.strictEqual(fs.existsSync(configPath()), false, 'a refused publish created config.json');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('config.json')), [],
      'a refused publish left a temp file or created anything');
    saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH });
    assert.deepStrictEqual(docAt(configPath()), { routes: [] });
    // The first publish is create-only: a second one loses, it never overwrites.
    assert.throws(() => saveConfig({ routes: ['x'] }, { capability: config.FIRST_PUBLISH }), (e) => e.code === 'EEXIST');
    assert.deepStrictEqual(docAt(configPath()), { routes: [] });
    // Once it exists, ordinary publishers replace it as before.
    saveConfig({ routes: [], gate: { mode: 'off' } });
    assert.deepStrictEqual(docAt(configPath()), { routes: [], gate: { mode: 'off' } });
  });
});

test('pin 1: no publish happens outside the provider mutation lock', () => {
  const dir = scratch();
  underLock(dir, () => saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH }));
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  inDataDir(dir, () => {
    assert.throws(() => saveConfig({ routes: [], gate: { mode: 'deny' } }), (e) => e.code === 'CONFIG_LOCK_REQUIRED');
    assert.throws(() => saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH }), (e) => e.code === 'CONFIG_LOCK_REQUIRED');
  });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before, 'an unlocked publish changed config.json');
  // Released means released: holding it once does not license a later publish.
  inDataDir(dir, () => assert.throws(() => saveConfig({ routes: [] }), (e) => e.code === 'CONFIG_LOCK_REQUIRED'));
});

test('pin 2: a normal publish leaves no .prev, so a later outside delete re-arms the migration', () => {
  const dir = upgradeWith('kimi-code-plan');
  underLock(dir, () => {
    saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH });
    saveConfig({ routes: [], gate: { mode: 'off' } });
  });
  assert.strictEqual(fs.existsSync(PREV(dir)), false, 'a normal publish left config.json.prev behind');
  // A stale .prev planted BESIDE config.json is a leftover, not a document:
  // the next publish removes it rather than letting it outlive config.json.
  fs.writeFileSync(PREV(dir), '{"routes":[{"id":"stale"}]}');
  underLock(dir, () => saveConfig({ routes: [], gate: { mode: 'off' } }));
  assert.strictEqual(fs.existsSync(PREV(dir)), false, 'a stale .prev survived a publish beside config.json');
  // Outside delete: nothing may keep the migration disarmed now.
  fs.unlinkSync(path.join(dir, 'config.json'));
  assert.strictEqual(inDataDir(dir, () => config.configPresence()), 'absent');
  const r = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'the migration stayed disarmed after the delete');
});

test('pin 3: a crash between move-aside and link is recovered by the next writer, never a lockout', () => {
  const dir = scratch();
  const prior = { routes: [{ id: 'custom-prior', provider: 'stepplan', monitor: { recipe: 'stepfun-plan' }, retention: 'keep-unmonitored' }],
    vault: { backend: 'file' }, gate: { mode: 'off' } };
  // Exactly what an interrupted publish leaves: config.json moved aside, the
  // new document never linked in.
  fs.writeFileSync(PREV(dir), JSON.stringify(prior));
  // Readers see the document, read-only — no transient empty config.
  assert.strictEqual(inDataDir(dir, () => config.configPresence()), 'present');
  assert.deepStrictEqual(inDataDir(dir, () => loadConfig().routes.map((r) => r.id)), ['custom-prior']);
  const list = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(list.status, 0, list.stderr);
  assert.deepStrictEqual(list.json.routes.map((r) => r.id), ['custom-prior']);
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, 'a read wrote config.json');
  // A normal writer proceeds from the recovered document.
  const add = run(dir, ['provider', 'add', '--label', 'after', '--provider', 'stepplan', '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
  assert.strictEqual(add.status, 0, `the crash state locked the user out: ${add.stdout}${add.stderr}`);
  assert.deepStrictEqual(routeIds(dir), ['custom-prior', 'custom-after']);
  assert.strictEqual(fs.existsSync(PREV(dir)), false, 'recovery left config.json.prev behind');
});

test('pin 4: config.json deleted right BEFORE the move-aside — refused (exit 8), and the migration still runs', () => {
  // The R3-1 interleaving: the publisher saw config.json, an outside actor
  // deletes it, and the publisher continues. It must not create the file.
  const dir = upgradeWith('kimi-code-plan');
  run(dir, ['provider', 'list', '--json']);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ routes: [], vault: { backend: 'file' }, gate: { mode: 'off' } }));
  assert.deepStrictEqual(routeIds(dir), [], 'premise: a config.json with no rows, and a stored Kimi credential');
  const { r, fired } = deleteAt(dir, 'before-move', ADD_AFTER);
  assert.deepStrictEqual(fired, [{ at: 'before-move', removed: true }], 'premise: the outside delete happened at the boundary');
  assert.strictEqual(r.status, 8, `a non-capability writer was not refused: ${r.stdout}${r.stderr}`);
  assert.ok(`${r.stdout}${r.stderr}`.includes(REFUSAL.slice('view-limits: '.length)), 'not the same refusal message');
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, 'the writer CREATED config.json and disarmed the migration');
  assert.strictEqual(fs.existsSync(PREV(dir)), false);
  const next = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(next.status, 0, next.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'the migration did not run after the delete');
});

test('pin 4: config.json deleted BETWEEN move-aside and link — nothing to delete; the replace completes', () => {
  const dir = seeded([]);
  const { r, fired } = deleteAt(dir, 'before-link', [...ADD_AFTER, '--json']);
  assert.deepStrictEqual(fired, [{ at: 'before-link', removed: false }],
    'config.json was still there to delete after it had been moved aside');
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepStrictEqual(routeIds(dir), ['custom-after'], 'this was a replace of an existing document');
  assert.strictEqual(fs.existsSync(PREV(dir)), false);
});

test('pin 5: no hard links means fail closed — no fallback to rename-over', () => {
  const dir = scratch();
  underLock(dir, () => saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH }));
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const realLink = fs.linkSync;
  const realRename = fs.renameSync;
  const renames = [];
  fs.linkSync = (from, to) => {
    if (path.basename(String(from)).startsWith('config.json.tmp.')) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
    return realLink(from, to);
  };
  fs.renameSync = (from, to) => { renames.push([path.basename(String(from)), path.basename(String(to))]); return realRename(from, to); };
  try {
    underLock(dir, () => assert.throws(() => saveConfig({ routes: [], gate: { mode: 'deny' } }), (e) => e.code === 'CONFIG_LINK_UNSUPPORTED'));
    const fresh = scratch();
    underLock(fresh, () => assert.throws(() => saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH }),
      (e) => e.code === 'CONFIG_LINK_UNSUPPORTED'));
    assert.strictEqual(fs.existsSync(path.join(fresh, 'config.json')), false);
  } finally {
    fs.linkSync = realLink;
    fs.renameSync = realRename;
  }
  assert.ok(!renames.some(([from, to]) => from.startsWith('config.json.tmp.') && to === 'config.json'),
    `a temp file was renamed over config.json: ${JSON.stringify(renames)}`);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before, 'the previous document was not restored');
  assert.strictEqual(fs.existsSync(PREV(dir)), false);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp.')), [], 'a temp file was left behind');
});

test('pin 6: a publish completing between the reader\'s two reads is read, never "no config" (round 4 F1)', async () => {
  const dir = scratch();
  // The writer has moved config.json aside; its link and .prev unlink are next.
  fs.writeFileSync(PREV(dir), JSON.stringify(OLD_DOC));
  // The shipped darwin default — what a fall-through to DEFAULTS would select.
  const forced = DEFAULTS.vault.backend;
  DEFAULTS.vault.backend = 'keychain';
  try {
    const { value, misses } = await onReaderMiss([() => underLock(dir, () => saveConfig(NEW_DOC))],
      () => inDataDir(dir, () => loadConfig()));
    assert.deepStrictEqual(misses, ['config.json', 'config.json.prev'],
      'premise: the reader missed config.json, the publish completed, then the reader missed .prev');
    assert.strictEqual(value.vault.backend, 'file',
      'a completed publish read as "no config": the vault backend fell back to the default');
    assert.deepStrictEqual(value.routes.map((r) => r.id), ['custom-new']);
  } finally {
    DEFAULTS.vault.backend = forced;
  }
});

test('pin 6: back-to-back publishes between reads — the reader keeps reading until it holds a document', async () => {
  // One extra read of config.json is not enough: a second publish can move it
  // aside again before that read, and then the document is .prev once more.
  const dir = scratch();
  fs.writeFileSync(PREV(dir), JSON.stringify(OLD_DOC));
  const { value, misses } = await onReaderMiss([
    () => underLock(dir, () => saveConfig(NEW_DOC)),
    () => fs.renameSync(path.join(dir, 'config.json'), PREV(dir)),
  ], () => inDataDir(dir, () => loadConfig()));
  assert.deepStrictEqual(misses, ['config.json', 'config.json.prev', 'config.json'],
    'premise: publish 1 completed between the first two reads, publish 2 moved config.json aside before the third');
  assert.deepStrictEqual(value.routes.map((r) => r.id), ['custom-new'], 'the reader gave up while a document existed');
});

test('pin 6: with no document the reader stops after a bounded number of reads, without a delay', async () => {
  // Lax: six lock-free reads, then INCONCLUSIVE — it cannot tell absent from a
  // publish it never caught. Strict: one more round under the lock, then ENOENT.
  const dir = scratch();
  const lax = await onReaderMiss([], () => {
    try { config.readConfigTextIn(dir); return null; } catch (e) { return e.code; }
  });
  assert.strictEqual(lax.value, 'CONFIG_INCONCLUSIVE', 'a lax reader claimed absence it cannot prove');
  assert.deepStrictEqual(lax.misses, ['config.json', 'config.json.prev', 'config.json', 'config.json.prev', 'config.json', 'config.json.prev']);
  const strict = await onReaderMiss([], () => {
    try { config.readConfigTextIn(dir, { strict: true }); return null; } catch (e) { return e.code; }
  });
  assert.strictEqual(strict.value, 'ENOENT', 'absence proven under the lock must surface as ENOENT');
  assert.strictEqual(strict.misses.length, 8, `six lock-free reads, then one round under the lock: ${strict.misses}`);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('config.json')), [], 'a read wrote config.json');
});

test('pin 7: the runtime snapshot reads the same logical document as loadConfig (round 4 F2)', async () => {
  const dir = scratch();
  // A lone .prev: a publish in flight, or one interrupted between its steps.
  fs.writeFileSync(PREV(dir), JSON.stringify(OLD_DOC));
  const before = fs.readdirSync(dir).sort();
  const s = await getRuntimeSnapshot({ refresh: false, dataDir: dir });
  assert.deepStrictEqual(s.routes.map((r) => r.id), ['custom-old'], 'the snapshot read a lone .prev as "no config"');
  assert.ok(!s.diagnostics.some((d) => d.code === 'config-corrupt'), JSON.stringify(s.diagnostics));
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'the snapshot wrote to the data dir');
  // And mid-publish: the publish completes between the snapshot's two reads.
  const { value, misses } = await onReaderMiss([() => underLock(dir, () => saveConfig(NEW_DOC))],
    () => getRuntimeSnapshot({ refresh: false, dataDir: dir }));
  assert.deepStrictEqual(misses, ['config.json', 'config.json.prev'], 'premise: the publish completed between the reads');
  assert.deepStrictEqual(value.routes.map((r) => r.id), ['custom-new']);
  // Corruption is still reported when the document being read is .prev.
  const bad = scratch();
  fs.writeFileSync(PREV(bad), '{not json');
  const c = await getRuntimeSnapshot({ refresh: false, dataDir: bad });
  assert.ok(c.diagnostics.some((d) => d.code === 'config-corrupt'), 'a corrupt .prev was not reported as corrupt');
});

test('pin 8: N writers exhaust every lock-free round — the strict read proves the document under the lock', async () => {
  const dir = scratch();
  fs.writeFileSync(PREV(dir), JSON.stringify(customDoc('custom-0')));
  const forced = DEFAULTS.vault.backend;
  DEFAULTS.vault.backend = 'keychain';
  try {
    const { value, count } = await countingAcquires(async () => {
      const r = await onReaderMiss(nWriterSchedule(dir, ['custom-1', 'custom-2', 'custom-3'].map(customDoc)),
        () => inDataDir(dir, () => config.loadConfigStrict()));
      assert.deepStrictEqual(r.misses, SIX_MISSES, 'premise: all six lock-free reads missed');
      return r.value;
    });
    assert.strictEqual(count, 1, 'the exhausted strict read must take the lock exactly once');
    assert.strictEqual(value.vault.backend, 'file', 'an exhausted strict read answered with DEFAULTS');
    assert.deepStrictEqual(value.routes.map((r) => r.id), ['custom-3']);
  } finally {
    DEFAULTS.vault.backend = forced;
  }
});

test('pin 8: the same schedule through the lax reader REFUSES by default; a display opt-in gets DEFAULTS marked inconclusive', async () => {
  const dir = scratch();
  fs.writeFileSync(PREV(dir), JSON.stringify(customDoc('custom-0')));
  // The default (owner ruling "fix by default"): CONFIG_INCONCLUSIVE, never DEFAULTS.
  const refused = await countingAcquires(() => onReaderMiss(
    nWriterSchedule(dir, ['custom-1', 'custom-2', 'custom-3'].map(customDoc)), () => inDataDir(dir, () => {
      try { return { cfg: loadConfig() }; } catch (e) { return { code: e && e.code }; }
    })));
  assert.deepStrictEqual(refused.value.misses, SIX_MISSES, 'premise');
  assert.strictEqual(refused.count, 0, 'the lax reader took the lock');
  assert.deepStrictEqual(refused.value.value, { code: 'CONFIG_INCONCLUSIVE' }, 'the default handed out DEFAULTS from an unconfirmed read');
  // An opted-in caller gets DEFAULTS, marked so it can surface the mark.
  fs.renameSync(path.join(dir, 'config.json'), PREV(dir));
  const { value, count } = await countingAcquires(() => onReaderMiss(
    nWriterSchedule(dir, ['custom-7', 'custom-8', 'custom-9'].map(customDoc)), () => inDataDir(dir, () => loadConfig({ display: true }))));
  assert.deepStrictEqual(value.misses, SIX_MISSES, 'premise');
  assert.strictEqual(count, 0, 'the lax reader took the lock');
  assert.strictEqual(config.configInconclusive(value.value), true, 'DEFAULTS from an unconfirmed read were not marked');
  assert.deepStrictEqual(value.value.routes, []);
  // A read that confirms the document is not marked.
  assert.strictEqual(config.configInconclusive(inDataDir(dir, () => loadConfig())), false);
  // The snapshot (report / recommend render it) carries the reason code.
  fs.renameSync(path.join(dir, 'config.json'), PREV(dir));
  const snap = await onReaderMiss(nWriterSchedule(dir, ['custom-4', 'custom-5', 'custom-6'].map(customDoc)),
    () => getRuntimeSnapshot({ refresh: false, dataDir: dir }));
  assert.deepStrictEqual(snap.value.diagnostics.filter((d) => d.scope === 'routes').map((d) => d.code), ['config-inconclusive']);
  assert.match(snap.value.diagnostics.find((d) => d.code === 'config-inconclusive').summary, /being replaced while it was read/);
  // The CLI display: `report` says the configuration could not be confirmed,
  // never "no credentials configured". An unreadable vault keeps config.json
  // absent (the migration cannot run), which a lax read cannot tell apart
  // from a publish in flight.
  const pending = upgradeWith('kimi-code-plan');
  if (!IS_ROOT) {
    fs.chmodSync(path.join(pending, 'secrets'), 0o000);
    try {
      const r = run(pending, ['report']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /config\.json could not be confirmed/, `report output: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /no credentials configured/i);
    } finally {
      fs.chmodSync(path.join(pending, 'secrets'), 0o700);
    }
  }
});

test('pin 8: the uncontended read path never takes the lock — before and after the exhaustion branch', async () => {
  const present = seeded([]);
  const lone = scratch();
  fs.writeFileSync(PREV(lone), JSON.stringify(customDoc('custom-lone')));
  inDataDir(present, () => vault.set('kimi-code-plan', KEY_A));
  const workload = async () => {
    for (const dir of [present, lone]) {
      inDataDir(dir, () => {
        loadConfig();
        config.loadConfigStrict();
        config.readConfigTextIn(dir);
        config.readConfigTextIn(dir, { strict: true });
        vault.probe('kimi-code-plan');
        vault.get('kimi-code-plan');
      });
      await getRuntimeSnapshot({ refresh: false, dataDir: dir });
    }
  };
  const { count } = await countingAcquires(async (acquires) => {
    await workload();
    assert.strictEqual(acquires(), 0, 'a read of a present or lone-.prev document took the lock');
    // The exhaustion branch takes it exactly once ...
    const churn = scratch();
    fs.writeFileSync(PREV(churn), JSON.stringify(customDoc('custom-0')));
    await onReaderMiss(nWriterSchedule(churn, ['custom-1', 'custom-2', 'custom-3'].map(customDoc)),
      () => inDataDir(churn, () => config.loadConfigStrict()));
    assert.strictEqual(acquires(), 1);
    // ... and leaves nothing behind that puts the lock on the hot path.
    await workload();
    assert.strictEqual(acquires(), 1, 'the hot path took the lock after an exhaustion');
  });
  assert.strictEqual(count, 1);
});

test('pin 8: a strict read while THIS process holds the lock proves absence without re-acquiring it', async () => {
  // The migration and every in-protocol writer read config while holding the
  // lock: no other publish can be in flight, so a miss is already proof.
  const dir = scratch();
  const { value, count } = await countingAcquires(() => underLock(dir, () => {
    try { config.readConfigTextIn(dir, { strict: true }); return null; } catch (e) { return e.code; }
  }));
  assert.strictEqual(value, 'ENOENT');
  assert.strictEqual(count, 0, 'the strict read re-acquired a lock this process already holds');
});

test('pin 8: the lock held by a live process — every vault operation hard-fails INCONCLUSIVE, none falls back', async () => {
  const dir = scratch();
  // process.ppid is alive and is not this process: a live foreign holder.
  plantTicket(dir, process.ppid);
  const started = Date.now();
  const read = (() => {
    try { config.readConfigTextIn(dir, { strict: true }); return null; } catch (e) { return e.code; }
  })();
  const waited = Date.now() - started;
  assert.strictEqual(read, 'CONFIG_INCONCLUSIVE', 'absence was claimed without the lock');
  assert.ok(waited >= 900 && waited < 5000, `the bounded wait was ${waited}ms`);
  inDataDir(dir, () => {
    assert.strictEqual(vault.probe('kimi-code-plan'), 'inconclusive', 'probe must not report absent');
    for (const op of [() => vault.set('kimi-code-plan', KEY_A), () => vault.get('kimi-code-plan'), () => vault.remove('kimi-code-plan')]) {
      assert.throws(op, (e) => e.code === 'CONFIG_INCONCLUSIVE', 'a vault operation chose a backend from DEFAULTS');
    }
  });
  assert.strictEqual(fs.existsSync(path.join(dir, 'secrets')), false, 'a credential was written to the default backend');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('config.json')), []);
});

test('pin 8: a lock left by a dead process is reclaimed by the existing liveness check, and the strict read converges', async () => {
  const dir = scratch();
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.strictEqual(child.status, 0);
  const stale = plantTicket(dir, child.pid);
  const started = Date.now();
  const { value, count } = await countingAcquires(() => {
    try { config.readConfigTextIn(dir, { strict: true }); return null; } catch (e) { return e.code; }
  });
  assert.strictEqual(value, 'ENOENT', 'a dead holder left the strict read inconclusive');
  assert.strictEqual(count, 1, 'reclaimed on the first attempt, not by waiting out the timeout');
  assert.ok(Date.now() - started < 900, 'the reclaim waited out the timeout');
  assert.strictEqual(fs.existsSync(stale), false, 'the dead ticket was not reaped');
});

test('pin 8: every vault operation chooses its backend through the strict reader', () => {
  // The grep is the audit; this pins it. Each backend decision is vaultCfg(),
  // and vaultCfg is the strict read — no operation reads the lax config.
  const src = fs.readFileSync(path.join(__dirname, '../lib/vault.js'), 'utf8');
  assert.match(src, /function vaultCfg\(\) \{\n {2}return loadConfigStrict\(\)\.vault;\n\}/);
  assert.doesNotMatch(src, /\bloadConfig\(/, 'the vault reads the lax config somewhere');
  for (const op of ['set', 'get', 'probe', 'remove']) {
    const body = src.slice(src.indexOf(`function ${op}(`)).split('\n}\n')[0];
    assert.match(body, /vaultCfg\(\)/, `vault.${op} does not choose its backend through vaultCfg`);
  }
});

test('pin 8: the PreToolUse gate path never reads strictly, never takes The lock and never touches the vault', () => {
  const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-strict-')), 'journal');
  const status = (dir) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    routes: { 'kimi-code-plan': {
      routeId: 'kimi-code-plan', observedAt: new Date(Date.now() - 60000).toISOString(),
      freshUntil: new Date(Date.now() + 300000).toISOString(), source: 'kimi',
      status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
    } },
  }));
  const doc = JSON.stringify({ gate: { mode: 'deny', injectContext: true }, routes: [builtInRoute('kimi-code-plan')], vault: { backend: 'file' } });
  const present = scratch();
  fs.writeFileSync(path.join(present, 'config.json'), doc);
  status(present);
  const lone = scratch();
  fs.writeFileSync(PREV(lone), doc);
  status(lone);
  const absent = scratch();
  for (const [dir, expectDeny] of [[present, true], [lone, true], [absent, false]]) {
    const r = spawnSync(process.execPath, [cli, 'gate'], {
      input: JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }),
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, VL_STRICT_JOURNAL: journal,
        NODE_OPTIONS: `--require=${path.join(__dirname, 'fixtures/strict-journal.cjs')}` },
      encoding: 'utf8', timeout: 20000,
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(/"permissionDecision":"deny"/.test(r.stdout), expectDeny, `premise: the gate ran its path: ${r.stdout}`);
  }
  const calls = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean) : [];
  assert.deepStrictEqual(calls, [], 'the gate path reached the strict reader, the lock or the vault');
  assert.strictEqual(fs.existsSync(path.join(absent, lockModule.LOCK_DIR)), false, 'the gate wrote a lock ticket');
});

test('pin 8: UNCONTENDED READ WORKLOAD — gate, report, snapshot, check and session-start take the lock 0 times', () => {
  // The load-bearing hot-path property, as its own test. The PreToolUse gate,
  // report (/view-limits), snapshot, check and session-start run for real —
  // the real file vault (they read credentials), outbound network refused —
  // on a present config and on a lone .prev. Every lock acquire in each
  // process is journaled; acquireCount must be 0 for every one.
  const doc = { routes: [builtInRoute('kimi-code-plan')], vault: { backend: 'file' }, gate: { mode: 'deny' } };
  // The document first: a strict credential write with NO document proves
  // absence under the lock, which would leave the lock directory behind.
  const present = scratch();
  fs.writeFileSync(path.join(present, 'config.json'), JSON.stringify(doc));
  inDataDir(present, () => vault.set('kimi-code-plan', KEY_A));
  const lone = scratch();
  fs.writeFileSync(PREV(lone), JSON.stringify(doc));
  inDataDir(lone, () => vault.set('kimi-code-plan', KEY_A));
  for (const dir of [present, lone]) {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
      updatedAt: new Date().toISOString(),
      routes: { 'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date(Date.now() - 60000).toISOString(),
        freshUntil: new Date(Date.now() + 300000).toISOString(), source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      } },
    }));
  }
  const strictJournal = path.join(__dirname, 'fixtures/strict-journal.cjs');
  for (const dir of [present, lone]) {
    for (const args of [['gate'], ['report'], ['snapshot', '--json'], ['check', 'kimi-code-plan'], ['session-start'], ['config'], ['provider', 'list', '--json']]) {
      const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-strict-')), 'journal');
      const j = journals();
      const r = spawnSync(process.execPath, [cli, ...args], {
        env: envFor(dir, j, {
          NODE_OPTIONS: `--require=${preload} --require=${strictJournal}`,
          VL_STRICT_JOURNAL: journal, VL_STRICT_JOURNAL_VAULT: 'pass',
        }),
        input: args[0] === 'gate' ? JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }) : '',
        encoding: 'utf8', timeout: 20000,
      });
      assert.ok(r.status !== null, `${args.join(' ')} did not finish`);
      if (args[0] === 'gate') assert.match(r.stdout, /"permissionDecision":"deny"/, `premise: the gate ran its full path: ${r.stdout}${r.stderr}`);
      const calls = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean) : [];
      assert.deepStrictEqual(calls.filter((c) => c.startsWith('acquireMutationLock')), [],
        `${args.join(' ')} on ${dir === lone ? 'a lone .prev' : 'a present config'} took the lock: ${calls}`);
      assert.ok(args[0] !== 'session-start' || calls.includes('vault.has'), `premise: session-start read the credential: ${calls}`);
    }
    assert.strictEqual(fs.existsSync(path.join(dir, lockModule.LOCK_DIR)), false, 'a read command wrote a lock ticket');
  }
});

test('pin 8: lib/lock.js requires nothing in lib/, and only lib/config.js and lib/provider-lifecycle.js require it', () => {
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'lib/lock.js'), 'utf8');
  const deps = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepStrictEqual(deps.sort(), ['crypto', 'fs', 'path'], `lib/lock.js requires: ${deps}`);
  const importers = [];
  for (const sub of ['lib', 'bin', 'harness']) {
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js') && /require\((['"])[./]*(lib\/)?lock(\.js)?\1\)/.test(fs.readFileSync(p, 'utf8'))) {
          importers.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, sub));
  }
  assert.deepStrictEqual(importers.sort(), ['lib/config.js', 'lib/provider-lifecycle.js']);
});

test('pin 9: config and provider list on an unconfirmed read — the notice, exit 9, never DEFAULTS or an empty list', () => {
  for (const args of [['config'], ['provider', 'list', '--json'], ['provider', 'list']]) {
    const dir = seeded([builtInRoute('kimi-code-plan')]);
    const { r, steps, acquires } = churnRun(dir, args, { at: OWN_READ(args) });
    assert.ok(EXHAUSTED(steps), `premise: three publishes exhausted every lock-free round: ${JSON.stringify(steps)}`);
    assert.strictEqual(r.status, 9, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.strictEqual(r.stdout, '', `${args.join(' ')} presented an unconfirmed configuration: ${r.stdout}`);
    assert.match(r.stderr, /config unreadable mid-write; retry/);
    assert.deepStrictEqual(acquires, [], `${args.join(' ')} took the lock to display`);
    assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan', 'custom-w3'], 'premise: the third writer\'s document is committed');
  }
});

test('pin 9: check/remove/setup/update <id> on an unconfirmed read — exit 9 and nothing touched, never "unknown route"', () => {
  for (const args of [['check', 'kimi-code-plan'], ['remove', 'kimi-code-plan'], ['setup', 'kimi-code-plan', '--key', KEY_B],
    ['update', 'kimi-code-plan', '--key', KEY_B], ['provider', 'remove', 'custom-w1']]) {
    const dir = seeded([builtInRoute('kimi-code-plan')]);
    inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
    const { r, steps, acquires } = churnRun(dir, args, { at: OWN_READ(args) });
    assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
    assert.strictEqual(r.status, 9, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /config unreadable mid-write; retry/);
    assert.doesNotMatch(r.stderr, /unknown route|not configured/i);
    assert.deepStrictEqual(acquires, [], `${args.join(' ')} took the lock on its refusal path`);
    assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan', 'custom-w3'], `${args.join(' ')} changed config.json`);
    assert.strictEqual(inDataDir(dir, () => vault.get('kimi-code-plan')), KEY_A, `${args.join(' ')} changed the stored credential`);
  }
});

test('pin 9: Xiaomi setup reads, modifies and publishes under ONE lock hold — a concurrent publisher cannot interleave', () => {
  // Read 3 is the route-list read inside planXiaomiConfig (1: setup's own;
  // 2: the plan's base document). A writer that tries to begin there
  // cannot take the lock, so the plan is built from — and written back over —
  // exactly the document it read.
  const dir = seeded([builtInRoute('kimi-code-plan'), customDoc('custom-keep').routes[0]]);
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const chrome = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-chrome-'));
  const { r, steps } = churnRun(dir, ['setup', 'xiaomi-token-plan', '--chrome-source', chrome, '--profile', 'Profile 46'],
    { at: 3, preloads: [xiaomiPreload], extra: { HOME: path.join(dir, 'home') } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(steps, [{ step: 'blocked', writer: 1 }], `a publisher interleaved with the Xiaomi read-modify-write: ${JSON.stringify(steps)}`);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan', 'custom-keep', 'xiaomi-token-plan'], 'a non-Xiaomi route was dropped');
  // And an unconfirmed read before the plan: refused, nothing written.
  const early = seeded([builtInRoute('kimi-code-plan'), customDoc('custom-keep').routes[0]]);
  fs.mkdirSync(path.join(early, 'home'), { recursive: true });
  const e = churnRun(early, ['setup', 'xiaomi-token-plan', '--chrome-source', chrome, '--profile', 'Profile 46'],
    { at: 1, preloads: [xiaomiPreload], extra: { HOME: path.join(early, 'home') } });
  assert.ok(EXHAUSTED(e.steps), `premise: ${JSON.stringify(e.steps)}`);
  assert.strictEqual(e.r.status, 9, e.r.stderr);
  assert.deepStrictEqual(routeIds(early), ['kimi-code-plan', 'custom-w3'], 'an unconfirmed read wrote a Xiaomi document');
  assert.strictEqual(fs.existsSync(path.join(early, 'bin')), false, 'the helper was built on an unconfirmed read');
});

test('pin 9: the Xiaomi revalidation and removal writers also read-modify-write under ONE lock hold', () => {
  // Read 2 is each writer's base-document read, inside its hold (1: the
  // command's own).
  const upd = xiaomiConfigured();
  const u = churnRun(upd.dir, ['update', 'xiaomi-token-plan', '--profile', 'Profile 47'],
    { at: 2, preloads: [xiaomiPreload], extra: { HOME: path.join(upd.dir, 'home') } });
  assert.strictEqual(u.r.status, 0, u.r.stderr);
  assert.deepStrictEqual(u.steps, [{ step: 'blocked', writer: 1 }], `a publisher interleaved with the revalidation write: ${JSON.stringify(u.steps)}`);
  assert.deepStrictEqual(routeIds(upd.dir), ['kimi-code-plan', 'custom-keep', 'xiaomi-token-plan'], 'revalidation dropped a route');
  assert.strictEqual(docAt(path.join(upd.dir, 'config.json')).xiaomi.chromeProfile, 'Profile 47');
  const rem = xiaomiConfigured();
  const m = churnRun(rem.dir, ['remove', 'xiaomi-token-plan'],
    { at: 2, preloads: [xiaomiPreload], extra: { HOME: path.join(rem.dir, 'home') } });
  assert.strictEqual(m.r.status, 0, m.r.stderr);
  assert.deepStrictEqual(m.steps, [{ step: 'blocked', writer: 1 }], `a publisher interleaved with the removal write: ${JSON.stringify(m.steps)}`);
  assert.deepStrictEqual(routeIds(rem.dir), ['kimi-code-plan', 'custom-keep'], 'removal dropped a non-Xiaomi route');
});

test('pin 9: err() inside a Xiaomi lock hold RELEASES the lock on exit — no ticket left for a later reclaim', () => {
  // A denied Keychain grant exits through err() while setup holds the lock.
  const { dir, chrome } = xiaomiConfigured();
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const r = run(dir, ['setup', 'xiaomi-token-plan', '--chrome-source', chrome, '--profile', 'Profile 46'], journals(), {
    NODE_OPTIONS: `--require=${preload} --require=${xiaomiPreload}`, HOME: path.join(dir, 'home'), VL_XIAOMI_GRANT_MODE: 'denied',
  });
  assert.strictEqual(r.status, 1, `premise: the grant denial exits through err(): ${r.stderr}`);
  assert.match(r.stderr, /Chrome key access was not granted/);
  // Released, not merely reclaimable: the lock directory is empty BEFORE any
  // other contender looks at it, so nothing depended on the dead-pid reaping.
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, lockModule.LOCK_DIR)), [], 'err() left its lock ticket behind');
  const next = lockModule.acquireMutationLock(dir);
  assert.ok(next.ok, 'a later writer could not take the lock');
  next.release();
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before, 'a denied setup changed config.json');
});

// Round-6 re-review C1: the entry guard covers a command's own first read only.
// Commands that were not wired, and later rereads inside a wired command, are
// pinned here, each with the churn aimed at exactly that read.
test('pin 9: refresh on an unconfirmed read — exit 9 and the notice, never "no credentials configured yet"', () => {
  const dir = seeded([builtInRoute('kimi-code-plan')]);
  inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
  const { r, steps, reads, acquires } = churnRun(dir, ['refresh'], { at: OWN_READ(['refresh']) });
  assert.strictEqual(siteAt(reads, 1), 'refresh', `premise: the churn starts at refresh's own read: ${JSON.stringify(reads)}`);
  assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
  assert.strictEqual(r.status, 9, `${r.stdout}${r.stderr}`);
  assert.strictEqual(r.stdout, '', `refresh presented an unconfirmed configuration: ${r.stdout}`);
  assert.match(r.stderr, /config unreadable mid-write; retry/);
  assert.doesNotMatch(r.stdout + r.stderr, /no credentials configured/i);
  assert.deepStrictEqual(r.j.read(r.j.net), [], 'refresh called a provider on an unconfirmed read');
  assert.deepStrictEqual(acquires, [], 'refresh took the lock on its refusal path');
  // The async SessionStart warm-up stays a silent no-op (exit 0): a hook that
  // fails would surface as a hook error, and the separate session-start hook
  // is what reports the notice.
  const warmArgs = ['refresh', '--quiet', '--session-start'];
  const warmDir = seeded([builtInRoute('kimi-code-plan')]);
  inDataDir(warmDir, () => vault.set('kimi-code-plan', KEY_A));
  const warm = churnRun(warmDir, warmArgs, { at: OWN_READ(warmArgs) });
  assert.strictEqual(siteAt(warm.reads, 1), 'refresh', `premise: ${JSON.stringify(warm.reads)}`);
  assert.ok(EXHAUSTED(warm.steps), `premise: ${JSON.stringify(warm.steps)}`);
  assert.strictEqual(warm.r.status, 0, `the SessionStart warm-up failed the hook: ${warm.r.stderr}`);
  assert.strictEqual(warm.r.stdout + warm.r.stderr, '');
  assert.deepStrictEqual(warm.r.j.read(warm.r.j.net), [], 'the warm-up called a provider on an unconfirmed read');
});

test('pin 9: serve on an unconfirmed read — exit 9 before it listens, never "unknown route" for a route that exists', async () => {
  const dir = seeded([builtInRoute('kimi-code-plan')]);
  // custom-w3 is in the document the writers commit; DEFAULTS do not offer it.
  const args = ['serve', String(await freePort()), 'nonce-81', 'custom-w3'];
  const { r, steps, reads, acquires } = churnRun(dir, args, { at: OWN_READ(args) });
  assert.strictEqual(siteAt(reads, 1), 'serve', `premise: the churn starts at serve's own read: ${JSON.stringify(reads)}`);
  assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
  assert.strictEqual(r.status, 9, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /config unreadable mid-write; retry/);
  assert.doesNotMatch(r.stderr, /unknown route/i);
  assert.deepStrictEqual(acquires, [], 'serve took the lock on its refusal path');
  assert.ok(routeIds(dir).includes('custom-w3'), 'premise: the route the form named exists');
});

test('pin 9: setup <id> --key stores the key, then an unconfirmed reread — exit 9, neither "not configured" nor success', () => {
  const args = ['setup', 'kimi-code-plan', '--key', KEY_A];
  const prepare = () => seeded([]);
  const at = readAt(prepare, args, 'requireRowAfterStore');
  const dir = prepare();
  const { r, steps, reads } = churnRun(dir, args, { at });
  assert.strictEqual(siteAt(reads, at), 'requireRowAfterStore', `premise: ${JSON.stringify(reads)}`);
  assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
  assert.strictEqual(r.status, 9, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /stored credential for "kimi-code-plan"/);
  assert.match(r.stderr, /config unreadable mid-write; retry/);
  assert.doesNotMatch(r.stderr, /not configured/i);
  assert.strictEqual(inDataDir(dir, () => vault.get('kimi-code-plan')), KEY_A, 'premise: the store succeeded');
});

test('pin 9: bare setup with an unconfirmed post-state reread — exit 9, never "still have no route" or "all present"', () => {
  // Every built-in configured and stored: nothing is missing, so no form opens.
  const prepare = () => {
    const ids = BUILT_IN_ROUTES.map((r) => r.id);
    const dir = seeded(ids.map((id) => builtInRoute(id)));
    inDataDir(dir, () => { for (const id of ids) vault.set(id, `sk-${id}-TEST-81`); });
    return dir;
  };
  const at = readAt(prepare, ['setup'], 'setup');
  const dir = prepare();
  const { r, steps, reads } = churnRun(dir, ['setup'], { at });
  assert.ok(at > OWN_READ(['setup']), `premise: the post-state reread is a later read than setup's own: ${at}`);
  assert.strictEqual(siteAt(reads, at), 'setup', `premise: ${JSON.stringify(reads)}`);
  assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
  assert.strictEqual(r.status, 9, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /config unreadable mid-write; retry/);
  assert.doesNotMatch(r.stderr, /still have no route|all credentials present/);
  assert.deepStrictEqual(r.j.read(r.j.browser), [], 'bare setup opened a form');
});

// ---- owner ruling "fix by default": loadConfig refuses unless the call site opts in ----
//
// Every opt-in site surfaces the mark itself. Each test below runs the real CLI
// under the same churn, aimed at that site's own read, and fails if the opt-in
// is removed (the site would exit 9) as well as if the site shows DEFAULTS.
test('opt-in: the gate on an unconfirmed read stays fail-open — exit 0, nothing denied', () => {
  const dir = seeded([builtInRoute('kimi-code-plan')]);
  const { r, steps, reads, acquires } = churnRun(dir, ['gate'], { at: OWN_READ() });
  assert.strictEqual(siteAt(reads, 1), 'gate', `premise: ${JSON.stringify(reads)}`);
  assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
  assert.strictEqual(r.status, 0, `the gate did not fail open: ${r.stdout}${r.stderr}`);
  assert.strictEqual(r.stdout, '', `the gate emitted a decision on an unconfirmed read: ${r.stdout}`);
  assert.deepStrictEqual(acquires, [], 'the gate took the lock');
});

test('opt-in: report on an unconfirmed read prints the notice, exit 0, never "no credentials configured"', () => {
  const dir = seeded([builtInRoute('kimi-code-plan')]);
  inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
  const { r, steps, reads, acquires } = churnRun(dir, ['report'], { at: OWN_READ() });
  assert.strictEqual(siteAt(reads, 1), 'reportCmd', `premise: ${JSON.stringify(reads)}`);
  assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /config unreadable mid-write; retry/);
  assert.doesNotMatch(r.stdout, /no credentials configured|could not be read or parsed/i);
  assert.deepStrictEqual(r.j.read(r.j.net), [], 'report called a provider on an unconfirmed read');
  assert.deepStrictEqual(acquires, [], 'report took the lock');
});

test('opt-in: session-start on an unconfirmed read reports the notice as its systemMessage, exit 0', () => {
  const dir = seeded([builtInRoute('kimi-code-plan')]);
  const { r, steps, reads, acquires } = churnRun(dir, ['session-start'], { at: OWN_READ() });
  assert.strictEqual(siteAt(reads, 1), 'sessionStart', `premise: ${JSON.stringify(reads)}`);
  assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
  assert.strictEqual(r.status, 0, `the SessionStart hook failed: ${r.stderr}`);
  assert.match(JSON.parse(r.stdout).systemMessage, /config unreadable mid-write; retry/);
  assert.doesNotMatch(r.stdout, /could not be read or parsed/, 'a publish in flight was reported as a corrupt file');
  assert.deepStrictEqual(acquires, [], 'session-start took the lock to display');
});

test('opt-in: recommend on an unconfirmed read fails safe — exit 0, Jev handed {} behind its gate', () => {
  const dir = seeded([builtInRoute('kimi-code-plan')]);
  const { r, steps, reads, acquires } = churnRun(dir, ['recommend', '--json'], { at: OWN_READ() });
  assert.strictEqual(siteAt(reads, 1), 'recommendCmd', `premise: ${JSON.stringify(reads)}`);
  assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.json && typeof r.json === 'object', `recommend printed no document: ${r.stdout}`);
  assert.deepStrictEqual(r.j.read(r.j.net), [], 'recommend reached the network (Jev) on an unconfirmed read');
  assert.deepStrictEqual(acquires, [], 'recommend took the lock');
});

test('setup <id> --headless exits 1 when its row does not materialize, as setup <id> --key does (CodeRabbit)', () => {
  const dir = seeded([]);
  const held = lifecycle.acquireMutationLock(dir);
  assert.ok(held.ok);
  try {
    const j = journals();
    const r = spawnSync(process.execPath, [cli, 'setup', 'kimi-code-plan', '--headless'], {
      env: envFor(dir, j), encoding: 'utf8', timeout: 20000, input: `${KEY_A}\n`,
    });
    assert.strictEqual(inDataDir(dir, () => vault.get('kimi-code-plan')), KEY_A, `premise: the credential was stored: ${r.stderr}`);
    assert.ok(!routeIds(dir).includes('kimi-code-plan'), 'premise: the row did not materialize');
    assert.strictEqual(r.status, 1, `a row-less headless store reported success: ${r.stderr}`);
    assert.match(r.stderr, /the credential for "kimi-code-plan" is stored, but its route is not configured yet/);
  } finally {
    held.release();
  }
});

test('guard: every config reader in bin/, lib/ and harness/ is exactly the reviewed table — no unlisted site, no widened opt-in', () => {
  const { calls, bypasses } = configReaderCalls();
  assert.deepStrictEqual(calls.slice().sort(), CONFIG_READERS.slice().sort(),
    'the config readers changed: classify the new or changed site in CONFIG_READERS (and the PR table) — a strict-default loadConfig() needs no opt-in; an opt-in must surface the mark itself');
  assert.deepStrictEqual(bypasses, [], 'a config.json read bypasses the shared reader');
});

test('guard: lib loadConfig honors only the two named opt-ins; anything else is the strict default', () => {
  const dir = scratch();
  inDataDir(dir, () => {
    for (const opts of [undefined, {}, { display: 'yes' }, { display: 1 }, { sessionWarmup: 'true' }, { strict: false }]) {
      assert.throws(() => loadConfig(opts), (e) => e && e.code === 'CONFIG_INCONCLUSIVE', `opted in with ${JSON.stringify(opts)}`);
    }
    for (const opts of [{ display: true }, { sessionWarmup: true }]) {
      assert.strictEqual(config.configInconclusive(loadConfig(opts)), true);
    }
  });
  // The same two opt-ins, and only they, let a corrupt document through.
  const broken = scratch();
  fs.writeFileSync(path.join(broken, 'config.json'), '{ "routes": [ ');
  inDataDir(broken, () => {
    for (const opts of [undefined, {}, { display: 'yes' }, { display: 1 }, { sessionWarmup: 'true' }, { strict: false }]) {
      assert.throws(() => loadConfig(opts), (e) => e && e.code === 'CONFIG_CORRUPT', `opted in with ${JSON.stringify(opts)}`);
    }
    for (const opts of [{ display: true }, { sessionWarmup: true }]) {
      assert.strictEqual(config.configCorrupt(loadConfig(opts)), true);
    }
  });
});

test('A: both variants refuse a corrupt config.json with CONFIG_CORRUPT; opt-ins get DEFAULTS marked corrupt, never inconclusive', () => {
  for (const raw of CORRUPT_DOCS) {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'config.json'), raw);
    inDataDir(dir, () => {
      assert.throws(() => config.loadConfigStrict(), (e) => e && e.code === 'CONFIG_CORRUPT', `strict on ${raw}`);
      assert.throws(() => loadConfig(), (e) => e && e.code === 'CONFIG_CORRUPT', `default on ${raw}`);
      for (const opts of [{ display: true }, { sessionWarmup: true }]) {
        const shown = loadConfig(opts);
        assert.strictEqual(config.configCorrupt(shown), true, `${JSON.stringify(opts)} on ${raw}`);
        assert.strictEqual(config.configInconclusive(shown), false, 'a corrupt document was also marked inconclusive');
        assert.deepStrictEqual(shown.routes, []);
      }
    });
  }
  // A read error other than ENOENT: a directory where the file should be.
  const isDir = scratch();
  fs.mkdirSync(path.join(isDir, 'config.json'));
  inDataDir(isDir, () => {
    assert.throws(() => config.loadConfigStrict(), (e) => e && e.code === 'CONFIG_CORRUPT');
    assert.strictEqual(config.configCorrupt(loadConfig({ display: true })), true);
  });
  if (!IS_ROOT) {
    const unreadable = seeded([builtInRoute('kimi-code-plan')]);
    fs.chmodSync(path.join(unreadable, 'config.json'), 0o000);
    try {
      inDataDir(unreadable, () => {
        assert.throws(() => config.loadConfigStrict(), (e) => e && e.code === 'CONFIG_CORRUPT', 'EACCES');
        assert.throws(() => loadConfig(), (e) => e && e.code === 'CONFIG_CORRUPT', 'EACCES');
      });
    } finally {
      fs.chmodSync(path.join(unreadable, 'config.json'), 0o600);
    }
  }
  // The marks are mutually exclusive, and a document that was read carries neither.
  const fine = seeded([builtInRoute('kimi-code-plan')]);
  inDataDir(fine, () => {
    const cfg = loadConfig({ display: true });
    assert.strictEqual(config.configCorrupt(cfg) || config.configInconclusive(cfg), false);
  });
  const absent = scratch();
  inDataDir(absent, () => {
    const cfg = loadConfig({ display: true });
    assert.strictEqual(config.configInconclusive(cfg), true);
    assert.strictEqual(config.configCorrupt(cfg), false, 'an unconfirmed read was also marked corrupt');
  });
});

test('A: the vault picks NO backend from a corrupt config.json — set/get/probe throw CONFIG_CORRUPT and no blob is written', () => {
  for (const raw of CORRUPT_DOCS) {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'config.json'), raw);
    inDataDir(dir, () => {
      // This process forces DEFAULTS' backend to the file vault, so a fallback
      // to DEFAULTS would show up as a blob written here.
      assert.throws(() => vault.set('kimi-code-plan', KEY_A), (e) => e && e.code === 'CONFIG_CORRUPT', `set on ${raw}`);
      assert.throws(() => vault.get('kimi-code-plan'), (e) => e && e.code === 'CONFIG_CORRUPT', `get on ${raw}`);
      assert.throws(() => vault.probe('kimi-code-plan'), (e) => e && e.code === 'CONFIG_CORRUPT', `probe on ${raw}`);
    });
    assert.strictEqual(fs.existsSync(path.join(dir, 'secrets')), false, `a credential was written on ${raw}`);
  }
});

test('A end to end: a file-vault user with a malformed config.json — setup/update/remove write to NEITHER backend, exit 10', () => {
  // The real darwin default (the Keychain) is restored, and every `security`
  // call is refused and journaled: a fallback to DEFAULTS would show up there.
  for (const args of [['setup', 'kimi-code-plan', '--key', KEY_B], ['update', 'kimi-code-plan', '--key', KEY_B], ['remove', 'kimi-code-plan']]) {
    const dir = seeded([builtInRoute('kimi-code-plan')]);
    inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
    const blob = fs.readFileSync(path.join(dir, 'secrets', 'kimi-code-plan.enc'));
    // The user's file-vault document, with one typo.
    const broken = '{ "routes": [ { "id": "kimi-code-plan", "provider": "kimi" } ], "vault": { "backend": "file" }, }';
    fs.writeFileSync(path.join(dir, 'config.json'), broken);
    const keychain = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-keychain-')), 'journal');
    const r = run(dir, args, journals(), {
      NODE_OPTIONS: `--require=${preload} --require=${keychainPreload}`, VL_KEYCHAIN_JOURNAL: keychain,
    });
    assert.strictEqual(r.status, 10, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, CORRUPT_NOTICE);
    assert.strictEqual(fs.existsSync(keychain) ? fs.readFileSync(keychain, 'utf8') : '', '', `${args.join(' ')} reached the Keychain`);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'secrets')), ['kimi-code-plan.enc'], `${args.join(' ')} changed the file vault`);
    assert.ok(fs.readFileSync(path.join(dir, 'secrets', 'kimi-code-plan.enc')).equals(blob), `${args.join(' ')} rewrote the stored credential`);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), broken, `${args.join(' ')} rewrote config.json`);
  }
});

test('A: each opt-in site surfaces the CORRUPT notice for a corrupt document — never the retry notice, never DEFAULTS', () => {
  const broken = '{ "routes": [ ';
  const at = (args) => {
    const dir = seeded([builtInRoute('kimi-code-plan')]);
    fs.writeFileSync(path.join(dir, 'config.json'), broken);
    return run(dir, args);
  };
  const rep = at(['report']);
  assert.strictEqual(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, CORRUPT_NOTICE);
  assert.doesNotMatch(rep.stdout, /no credentials configured|retry\./i);
  const ss = at(['session-start']);
  assert.strictEqual(ss.status, 0, ss.stderr);
  assert.match(JSON.parse(ss.stdout).systemMessage, CORRUPT_NOTICE);
  assert.doesNotMatch(ss.stdout, RETRY_NOTICE);
  const gate = at(['gate']);
  assert.strictEqual(gate.status, 0, gate.stderr);
  assert.strictEqual(gate.stdout, '');
  const rec = at(['recommend', '--json']);
  assert.strictEqual(rec.status, 0, rec.stderr);
  assert.ok(rec.json && typeof rec.json === 'object');
  const warm = at(['refresh', '--quiet', '--session-start']);
  assert.strictEqual(warm.status, 0, warm.stderr);
  assert.strictEqual(warm.stdout + warm.stderr, '');
  // And a strict-default command refuses it with exit 10, not 9.
  for (const args of [['refresh'], ['check', 'kimi-code-plan'], ['config'], ['provider', 'list']]) {
    const r = at(args);
    assert.strictEqual(r.status, 10, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, CORRUPT_NOTICE);
    assert.doesNotMatch(r.stderr, RETRY_NOTICE);
  }
  for (const r of [rep, ss, gate, rec, warm]) assert.deepStrictEqual(r.j.read(r.j.net), [], 'a provider was called on a corrupt document');
});

test('A1: a corrupt config.json plus a fresh receipt — session-start reports BOTH the rotation and the corrupt notice', () => {
  // The reviewer's reproduction: a broken file-vault document, a receipt from
  // the real writer, the real darwin default (Keychain) restored and refused.
  const broken = '{ "vault": { "backend": "file" }, "routes": [ ';
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'config.json'), broken);
  freshReceipt(dir);
  const keychain = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-keychain-')), 'journal');
  const r = run(dir, ['session-start'], journals(), {
    NODE_OPTIONS: `--require=${preload} --require=${keychainPreload}`, VL_KEYCHAIN_JOURNAL: keychain,
  });
  assert.strictEqual(r.status, 0, `the SessionStart hook failed: ${r.stderr}`);
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.match(msg, RECEIPT_ACK, 'the rotation was not acknowledged');
  assert.match(msg, CORRUPT_NOTICE, 'the receipt branch dropped the corrupt notice');
  assert.doesNotMatch(msg, /Run \/view-limits to refresh/, 'refresh guidance was given for a document that was not read');
  assert.doesNotMatch(msg, RETRY_NOTICE);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(receipts.formatReceipt(receipts.receiptFact(dir)), null, 'the receipt was not consumed');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), broken, 'config.json changed');
  assert.strictEqual(fs.existsSync(keychain) ? fs.readFileSync(keychain, 'utf8') : '', '', 'session-start reached the Keychain');
  assert.deepStrictEqual(r.j.read(r.j.net), [], 'a provider was called');
});

// The sweep: every early exit of sessionStart. Each exit either carries the
// notice or defers to it; none acknowledges something else and leaves the
// user without it. The vault probe in the migration reads config.json first,
// so the fault is aimed at sessionStart's OWN read, found by a clean run of
// an identically prepared dir.
test('A1 sweep: every early exit of session-start carries a corrupt notice — receipt, vault-unreadable, lock-busy', () => {
  const lockHeld = (dir, fn) => {
    const held = lifecycle.acquireMutationLock(dir);
    assert.ok(held.ok, 'premise: the test holds the lock');
    try { return fn(); } finally { held.release(); }
  };
  const branches = [
    { name: 'receipt', prepare: () => { const dir = seeded([builtInRoute('kimi-code-plan')]); freshReceipt(dir); return dir; },
      also: RECEIPT_ACK, around: (dir, fn) => fn() },
    { name: 'vault-unreadable', skip: IS_ROOT, prepare: () => upgradeWith('kimi-code-plan'),
      also: /the credential vault could not be read/, around: withLockedSecrets },
    { name: 'lock-busy', prepare: () => upgradeWith('kimi-code-plan'), also: null, around: lockHeld },
  ];
  for (const b of branches) {
    if (b.skip) { console.log(`    (${b.name} skipped: root ignores mode bits)`); continue; }
    const probe = b.prepare();
    const { reads } = b.around(probe, () => corruptRun(probe, ['session-start'], 0));
    const own = reads.find((s) => s.site === 'sessionStart');
    assert.ok(own, `premise: ${b.name}: sessionStart reads config.json: ${JSON.stringify(reads)}`);
    const dir = b.prepare();
    const { r, steps } = b.around(dir, () => corruptRun(dir, ['session-start'], own.attempt));
    assert.deepStrictEqual(steps, [{ step: 'corrupt', attempt: own.attempt, name: 'config.json' }], `premise: ${b.name}: only sessionStart's read was broken`);
    assert.strictEqual(r.status, 0, `${b.name}: ${r.stderr}`);
    const msg = JSON.parse(r.stdout).systemMessage;
    assert.match(msg, CORRUPT_NOTICE, `${b.name}: the corrupt notice is missing: ${msg}`);
    assert.doesNotMatch(msg, RETRY_NOTICE, `${b.name}: the retry notice`);
    if (b.also) assert.match(msg, b.also, `${b.name}: the branch's own message was dropped: ${msg}`);
    assert.doesNotMatch(msg, /no credentials configured yet|Run \/view-limits to refresh/, `${b.name}: guidance for a document that was not read`);
  }
});

test('A1 sweep: an inconclusive read plus a fresh receipt reports both; the migration branches keep their output for an absent config', () => {
  const dir = seeded([builtInRoute('kimi-code-plan')]);
  freshReceipt(dir);
  const { r, steps } = churnRun(dir, ['session-start'], { at: OWN_READ() });
  assert.ok(EXHAUSTED(steps), `premise: ${JSON.stringify(steps)}`);
  assert.strictEqual(r.status, 0, r.stderr);
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.match(msg, RECEIPT_ACK, 'the rotation was not acknowledged');
  assert.match(msg, RETRY_NOTICE, 'the receipt branch dropped the retry notice');
  assert.doesNotMatch(msg, /Run \/view-limits to refresh/);
  // There config.json was just found absent, and the inconclusive mark on an
  // absent file is that same absence: the vault notice stays exact (pinned
  // below by "session-start reports an unreadable vault…") and lock-busy stays silent.
  const busy = upgradeWith('kimi-code-plan');
  const held = lifecycle.acquireMutationLock(busy);
  assert.ok(held.ok, 'premise: the test holds the lock');
  let quiet;
  try { quiet = run(busy, ['session-start']); } finally { held.release(); }
  assert.strictEqual(quiet.status, 0, quiet.stderr);
  assert.strictEqual(quiet.stdout, '', 'lock-busy spoke while another process may be migrating');
});

test('A (second fallback): a Xiaomi writer whose base read finds config.json unparseable refuses — it never publishes from {}', () => {
  // Read 2 is the in-hold base-document read (readUserConfig). Without the
  // refusal the writer started from {} and replaced the whole document.
  const upd = xiaomiConfigured();
  const before = fs.readFileSync(path.join(upd.dir, 'config.json'), 'utf8');
  const { r, steps, reads } = corruptRun(upd.dir, ['update', 'xiaomi-token-plan', '--profile', 'Profile 47'], 2,
    { preloads: [xiaomiPreload], extra: { HOME: path.join(upd.dir, 'home') } });
  assert.strictEqual(siteAt(reads, 2), 'readUserConfig', `premise: ${JSON.stringify(reads)}`);
  assert.deepStrictEqual(steps, [{ step: 'corrupt', attempt: 2, name: 'config.json' }]);
  assert.strictEqual(r.status, 10, r.stderr);
  assert.match(r.stderr, CORRUPT_NOTICE);
  assert.strictEqual(fs.readFileSync(path.join(upd.dir, 'config.json'), 'utf8'), before, 'the Xiaomi writer published over the document');
  assert.deepStrictEqual(fs.readdirSync(path.join(upd.dir, lockModule.LOCK_DIR)), [], 'the refusal left its lock ticket behind');
});

test('the lifecycle publish path, called directly with the migration pending, is refused', async () => {
  // No dispatcher in front: persistRoute -> io.saveConfig must not create
  // config.json, and reports the same migration-pending status.
  const dir = scratch();
  const prev = { data: process.env.CLAUDE_PLUGIN_DATA, key: process.env.VIEW_LIMITS_MASTER_KEY };
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = MASTER;
  try {
    const r = await lifecycle.setupProvider({
      label: 'direct', provider: 'stepplan', recipe: 'stepfun-plan', retention: lifecycle.RETENTION.KEEP,
    }, {
      effectiveRoutes: () => [], readUserConfig: () => ({}), readUserConfigStrict: () => ({ ok: true, doc: {} }),
      saveConfig, lock: () => lifecycle.acquireMutationLock(dir),
      vault: { assertWritable() {}, get: () => null, set() {}, remove() {}, probe: () => 'absent' },
      readCache: () => ({ routes: {} }), writeCache() {},
    });
    assert.strictEqual(r.status, lifecycle.STATUS.MIGRATION_PENDING, `the lifecycle publish was not refused: ${JSON.stringify(r)}`);
    assert.strictEqual(lifecycle.exitCodeFor(r.status), 8);
    assert.strictEqual(fs.existsSync(configPath()), false, 'the lifecycle created config.json with the migration pending');
  } finally {
    if (prev.data === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev.data;
    if (prev.key === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prev.key;
  }
});

test('setup <id> --key exits 1 when its row does not materialize, as bare setup does', () => {
  // The credential is stored; the row is not (the lock is busy). Exit 0 here
  // would tell a script the route exists while the gate stays fail-open.
  const dir = seeded([]);
  const held = lifecycle.acquireMutationLock(dir);
  assert.ok(held.ok);
  try {
    const r = run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
    assert.strictEqual(r.status, 1, `a row-less store reported success: ${r.stderr}`);
    assert.match(r.stderr, /the credential for "kimi-code-plan" is stored, but its route is not configured yet — run: vl\.js setup \(with no route id\) to add it\./);
    assert.strictEqual(inDataDir(dir, () => vault.get('kimi-code-plan')), KEY_A, 'premise: the credential was stored');
    assert.ok(!routeIds(dir).includes('kimi-code-plan'), 'premise: the row did not materialize');
  } finally {
    held.release();
  }
  const ok = run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.ok(routeIds(dir).includes('kimi-code-plan'));
});

test('a fresh install: the default read refuses, a display read loads zero routes marked, and reading writes nothing', () => {
  // A lax read cannot tell an absent config.json from one being replaced.
  const dir = scratch();
  inDataDir(dir, () => {
    assert.throws(() => loadConfig(), (e) => e && e.code === 'CONFIG_INCONCLUSIVE');
    const shown = loadConfig({ display: true });
    assert.deepStrictEqual(shown.routes, []);
    assert.strictEqual(config.configInconclusive(shown), true);
    assert.strictEqual(fs.existsSync(configPath()), false);
  });
});

test('builtInRoute hands out deep copies, never the catalog itself', () => {
  const a = builtInRoute('kimi-code-plan');
  a.ttlSeconds = 99999;
  a.match.model = 'mutated';
  const b = builtInRoute('kimi-code-plan');
  assert.strictEqual(b.ttlSeconds, 180, 'the catalog was mutated through a handed-out route');
  assert.strictEqual(b.match.model, 'kimi', 'a nested catalog field was mutated');
  assert.strictEqual(builtInRoute('custom-acme-plan'), null);
  assert.strictEqual(builtInRoute(undefined), null);
});


finish('empty-defaults');
