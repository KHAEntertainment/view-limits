'use strict';
// Issue #81: the real-CLI surfaces — the one-time migration, the refusal of
//
// every writer while it is unresolved, the repair of a row-less credential,
// the setup form, and provider add/update/remove.
//
// Split out of one file for #106: the configuration document itself lives in
// test/empty-defaults.test.js. Nothing was removed in the split.
//
// The harness (CLI child env, scratch dirs, own-run helper) is shared with
// the other half: see test/helpers/empty-defaults-harness.js.

const { assert, fs, http, os, path, spawn, spawnSync, config, BUILT_IN_ROUTES, builtInRoute,
  saveConfig, vault, lifecycle, cli, preload, KEY_A, KEY_B, IS_ROOT, test, section, scratch,
  journals, envFor, run, inDataDir, upgradeWith, seeded, routeIds, tree, freePort, request,
  waitListening, fakeIo, corruptRun, siteAt, readAt, realPresence, UNREADABLE_NOTICE,
  INCONCLUSIVE_NOTICE, NO_CREDS_NUDGE, withLockedSecrets, REFUSAL, CONFIG_WRITERS, READERS,
  assertRefused, setUpOthers, rowlessKimi, finish } = require('./helpers/empty-defaults-harness');

section('migrateFromVault — publication is all or nothing');

test('absent config + stored credentials -> rows for exactly those providers, catalog rows in full', () => {
  const io = fakeIo({ states: { 'kimi-code-plan': 'present', 'openrouter-main': 'present' } });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: true, ids: ['kimi-code-plan', 'openrouter-main'] });
  assert.deepStrictEqual(io.calls.saves, [{ routes: [builtInRoute('kimi-code-plan'), builtInRoute('openrouter-main')] }]);
  assert.deepStrictEqual(io.calls.probes, BUILT_IN_ROUTES.map((x) => x.id), 'every built-in is asked exactly once');
});

test('a definitive all-absent publishes routes: [] so the vault is not re-probed forever', () => {
  const io = fakeIo();
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: true, ids: [] });
  assert.deepStrictEqual(io.calls.saves, [{ routes: [] }]);
});

test('UNREADABLE is never absent: one unreadable built-in aborts the whole migration', () => {
  // kimi is provably stored. If the unreadable glm were skipped and the rest
  // published, the document would disarm the trigger with glm lost for good.
  const io = fakeIo({ states: { 'kimi-code-plan': 'present', 'glm-coding-plan': 'unreadable' } });
  const r = lifecycle.migrateFromVault(io);
  assert.strictEqual(r.migrated, false);
  assert.strictEqual(r.reason, 'vault-unreadable');
  assert.strictEqual(r.retry, true);
  assert.deepStrictEqual(io.calls.saves, [], 'a partial set was published, disarming the trigger');
});

test('an unreadable vault with NOTHING present still publishes nothing', () => {
  // The exact shape of the reverted bug: every probe unreadable read as
  // "no credentials" and published routes: [] — permanently.
  const io = fakeIo({ states: Object.fromEntries(BUILT_IN_ROUTES.map((x) => [x.id, 'unreadable'])) });
  const r = lifecycle.migrateFromVault(io);
  assert.strictEqual(r.reason, 'vault-unreadable');
  assert.deepStrictEqual(io.calls.saves, [], 'unreadable was read as absent and routes: [] was published');
});

test('a probe that throws, or returns anything unexpected, is not proof of absence', () => {
  for (const bad of [new Error('keychain locked'), undefined, null, true, 'yes', 1]) {
    const io = fakeIo({ states: { 'deepseek-direct': bad } });
    const r = lifecycle.migrateFromVault(io);
    assert.strictEqual(r.reason, 'vault-unreadable', `probe value ${String(bad)} was accepted`);
    assert.deepStrictEqual(io.calls.saves, [], `probe value ${String(bad)} led to a publication`);
  }
});

test('a present config is never touched: no lock, no vault access', () => {
  const io = fakeIo({ presence: ['present'] });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: false, reason: 'config-present' });
  assert.strictEqual(io.calls.locks, 0);
  assert.deepStrictEqual(io.calls.probes, []);
});

test('a config that cannot even be stat-ed is not absent, so nothing migrates', () => {
  for (const presence of [['unreadable'], [new Error('EACCES')], ['maybe']]) {
    const io = fakeIo({ presence });
    const r = lifecycle.migrateFromVault(io);
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(r.reason, 'config-unreadable');
    assert.deepStrictEqual(io.calls.saves, []);
    assert.deepStrictEqual(io.calls.probes, []);
  }
});

test('absence is re-checked INSIDE the lock: a writer that got there first wins', () => {
  // Absent at the pre-check, present by the time we hold the lock.
  const io = fakeIo({ presence: ['absent', 'present'], states: { 'kimi-code-plan': 'present' } });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: false, reason: 'config-present' });
  assert.deepStrictEqual(io.calls.saves, [], 'published over a document another writer had just written');
  assert.deepStrictEqual(io.calls.probes, [], 'the vault was probed after the re-check said present');
});

test('a busy lock writes nothing and stays armed for the next command', () => {
  const io = fakeIo({ lockOk: false, states: { 'kimi-code-plan': 'present' } });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: false, reason: 'lock-busy', retry: true });
  assert.deepStrictEqual(io.calls.saves, []);
  assert.deepStrictEqual(io.calls.probes, [], 'the vault was read without holding the lock');
});

test('the lock is released on every path that took it', () => {
  const cases = [
    { name: 'success', opts: { states: { 'kimi-code-plan': 'present' } } },
    { name: 'unreadable', opts: { states: { 'kimi-code-plan': 'unreadable' } } },
    { name: 'probe throws', opts: { states: { 'kimi-code-plan': new Error('boom') } } },
    { name: 'write fails', opts: { saveThrows: true } },
    { name: 're-check present', opts: { presence: ['absent', 'present'] } },
  ];
  for (const c of cases) {
    const io = fakeIo(c.opts);
    lifecycle.migrateFromVault(io);
    assert.strictEqual(io.calls.locks, 1, `${c.name}: lock taken ${io.calls.locks}x`);
    assert.strictEqual(io.calls.releases, 1, `${c.name}: a leaked ticket would be lock-busy for the rest of the process`);
  }
});

test('a failed write reports retry and publishes nothing', () => {
  const io = fakeIo({ saveThrows: true, states: { 'kimi-code-plan': 'present' } });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: false, reason: 'write-failed', retry: true });
});

test('an io without the strict pieces is refused rather than guessed at', () => {
  for (const io of [null, {}, { ...fakeIo(), vault: {} }, { ...fakeIo(), configPresence: undefined }]) {
    assert.strictEqual(lifecycle.migrateFromVault(io).reason, 'unsupported-io');
  }
});

section('migration under the ownership boundary (real lock, real saveConfig)');

test('a provider add that completes before the migration locks is never erased', () => {
  // The round-3 P1-1 interleaving, with the real lock and the real atomic
  // publish: the migration's pre-check sees no config; a `provider add` then
  // takes the lock, publishes its route and releases; the migration locks.
  const dir = scratch();
  inDataDir(dir, () => {
    let addDone = false;
    const io = {
      configPresence: realPresence(dir),
      lock: () => {
        if (!addDone) {
          addDone = true;
          const theirs = lifecycle.acquireMutationLock(dir);
          assert.ok(theirs.ok, 'premise: the concurrent writer took the lock');
          // Another process whose migration won: only a migration may CREATE
          // config.json (the write-level guard), so it holds the capability.
          saveConfig({ routes: [{ id: 'custom-theirs', provider: 'stepplan', monitor: { recipe: 'stepfun-plan' } }] },
            { capability: config.FIRST_PUBLISH });
          assert.strictEqual(theirs.release(), true);
        }
        return lifecycle.acquireMutationLock(dir);
      },
      vault: { probe: () => 'present' },
      saveConfig,
    };
    const r = lifecycle.migrateFromVault(io);
    assert.strictEqual(r.reason, 'config-present');
    assert.deepStrictEqual(routeIds(dir), ['custom-theirs'],
      "the migration replaced a provider add that had already completed");
  });
});

test('while the migration holds the lock, a concurrent writer is refused rather than racing', () => {
  const dir = scratch();
  inDataDir(dir, () => {
    const attempts = [];
    const io = {
      configPresence: realPresence(dir),
      lock: () => lifecycle.acquireMutationLock(dir),
      // Called only while the migration holds the lock: any other writer must
      // be turned away, so it retries after rather than interleaving.
      vault: {
        probe: (id) => {
          const other = lifecycle.acquireMutationLock(dir);
          attempts.push(other.ok);
          if (other.ok) other.release();
          return id === 'kimi-code-plan' ? 'present' : 'absent';
        },
      },
      saveConfig,
    };
    const r = lifecycle.migrateFromVault(io);
    assert.deepStrictEqual(r, { migrated: true, ids: ['kimi-code-plan'] });
    assert.strictEqual(attempts.length, BUILT_IN_ROUTES.length);
    assert.ok(attempts.every((ok) => ok === false), 'another writer acquired the lock during the migration');
    assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, lifecycle.LOCK_DIR)), [], 'a ticket leaked');
  });
});

section('real CLI — the one-time migration');

test('an upgrade migrates on its first allowlisted command, for exactly the stored credentials', () => {
  const dir = upgradeWith('kimi-code-plan');
  const r = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
  assert.deepStrictEqual(r.json.routes.map((x) => x.id), ['kimi-code-plan']);
  assert.match(r.stderr, /migrated existing credentials into routes: kimi-code-plan/);
  assert.deepStrictEqual(r.j.read(r.j.net), [], 'a migration path made a network call');
});

test('it runs once: the second command neither re-migrates nor rewrites', () => {
  const dir = upgradeWith('kimi-code-plan');
  run(dir, ['provider', 'list', '--json']);
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const r = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /migrated/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
});

test('a credential-free fresh install gains routes: [] on its first allowlisted command', () => {
  // Disclosed in docs/configuration.md: "fresh install" resolves on first use. The document
  // is what stops the vault being re-probed on every later command.
  const dir = scratch();
  const r = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.json.routes, [], 'a fresh install must show no provider rows');
  assert.deepStrictEqual(routeIds(dir), []);
});

test('a TRANSIENTLY UNREADABLE real vault migrates nothing, and migrates once it is readable', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  const secrets = path.join(dir, 'secrets');
  fs.chmodSync(secrets, 0o000);
  try {
    // Premise, read off the REAL vault: this is unreadable, not absent.
    assert.strictEqual(inDataDir(dir, () => vault.probe('kimi-code-plan')), 'unreadable',
      'premise: the real file vault reports unreadable, not absent');
    const r = run(dir, ['provider', 'list', '--json']);
    // config.json stays absent, which a lock-free read cannot tell apart from
    // a publish in flight: the list refuses (exit 9) rather than present an
    // empty list as the configuration (PR #82 round 6 ruling).
    assert.strictEqual(r.status, 9, r.stderr);
    assert.strictEqual(r.stdout, '', 'an unconfirmed configuration was listed');
    assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false,
      'an unreadable vault published a config, which disarms the migration forever');
    assert.strictEqual(r.stderr, `${UNREADABLE_NOTICE}\n${INCONCLUSIVE_NOTICE}\n`, 'the notices changed shape or gained text');
  } finally {
    fs.chmodSync(secrets, 0o700);
  }
  const later = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(later.status, 0, later.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'],
    'the stored credential was never migrated once the vault came back');
});

test('an unparseable config is present: refused and left byte-identical', () => {
  const dir = upgradeWith('kimi-code-plan');
  const broken = '{ "routes": [ { "id": "mine", } ] }';
  fs.writeFileSync(path.join(dir, 'config.json'), broken);
  run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), broken);
});

test('routes: [] and {} are choices, never resurrected from the vault', () => {
  for (const doc of ['{"routes":[]}', '{}']) {
    const dir = upgradeWith('kimi-code-plan');
    fs.writeFileSync(path.join(dir, 'config.json'), doc);
    run(dir, ['provider', 'list', '--json']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), doc, `${doc} was rewritten`);
  }
});

section('real CLI — the unreadable-vault notice: where it lands, what it says, when');

test('session-start reports an unreadable vault in its systemMessage, exactly, and nowhere else', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  const r = withLockedSecrets(dir, () => run(dir, ['session-start']));
  assert.strictEqual(r.status, 0, r.stderr);
  // stdout is the hook's JSON. systemMessage is shown to the user; nothing
  // goes to additionalContext, so nothing enters the model's context.
  assert.strictEqual(r.stdout, JSON.stringify({ systemMessage: UNREADABLE_NOTICE }));
  assert.strictEqual(r.stderr, '', 'session-start must not also print the notice to stderr');
  assert.ok(!r.stdout.includes(dir), 'the notice carried a data-dir path');
  assert.doesNotMatch(r.stdout, /EACCES|EPERM|Error|sk-/, 'the notice carried error text or credential material');
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, 'an unreadable vault published a config');
});

test('negative: a readable fresh install gets the setup nudge, never the unreadable notice', () => {
  const dir = scratch();
  const r = run(dir, ['session-start']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, NO_CREDS_NUDGE);
  assert.strictEqual(r.stderr, '');
  assert.deepStrictEqual(routeIds(dir), [], 'the fresh install was not resolved to routes: []');
});

test('negative: a configured install with an unreadable vault never shows the migration notice', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  run(dir, ['provider', 'list', '--json']);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'premise: the install is configured');
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  for (const args of [['session-start'], ['provider', 'list', '--json']]) {
    const r = withLockedSecrets(dir, () => run(dir, args));
    assert.ok(!`${r.stdout}${r.stderr}`.includes('could not be read, so stored credentials'),
      `${args[0]} showed the migration notice on a configured install`);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before, `${args[0]} rewrote config.json`);
  }
});

section('real CLI — an unresolved migration refuses every command that writes config');

test('with the vault unreadable, every config-writing command is refused: exit 8, nothing written', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  withLockedSecrets(dir, () => {
    for (const args of CONFIG_WRITERS) {
      const r = run(dir, args);
      assertRefused(dir, args, r);
      assert.ok(r.stderr.includes(`${REFUSAL}\n`), `${args.join(' ')}: the refusal text changed shape: ${r.stderr}`);
    }
    // --json keeps stdout machine-readable: one document with a stable status.
    const j = run(dir, ['provider', 'add', '--label', 'new-plan', '--provider', 'stepplan',
      '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
    assertRefused(dir, ['provider', 'add', '--json'], j);
    assert.deepStrictEqual(j.json, { command: 'add', ok: false, status: 'migration-pending', error: REFUSAL.slice('view-limits: '.length) });
  });
  // Access returns: the migration was never disarmed, so it completes.
  const later = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(later.status, 0, later.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'the stored credential lost its route');
});

test('with the vault unreadable, read-only and cache-only commands still run and write no config', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  withLockedSecrets(dir, () => {
    for (const args of READERS) {
      const r = run(dir, args);
      assert.notStrictEqual(r.status, 8, `${args.join(' ')} was refused, but it never writes config`);
      assert.notStrictEqual(r.status, null, `${args.join(' ')} timed out`);
      assert.ok(!r.stderr.includes('not run: stored credentials'), `${args.join(' ')} printed the refusal`);
      assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, `${args.join(' ')} wrote config.json`);
    }
  });
});

test('a migration that is lock-busy refuses config writers the same way (keyed on retry, not the reason)', () => {
  const dir = upgradeWith('kimi-code-plan');
  const held = lifecycle.acquireMutationLock(dir);
  assert.ok(held.ok, 'premise: the test holds the mutation lock');
  try {
    const args = ['provider', 'add', '--label', 'new-plan', '--provider', 'stepplan', '--recipe', 'stepfun-plan', '--keep-unmonitored'];
    const r = run(dir, args);
    assertRefused(dir, args, r);
    assert.notStrictEqual(r.status, 6, 'an unresolved migration is not an ordinary lock-busy');
  } finally {
    held.release();
  }
});

test('negative: a READABLE vault never triggers the refusal', () => {
  for (const dir of [upgradeWith('kimi-code-plan'), scratch()]) {
    const r = run(dir, ['provider', 'add', '--label', 'new-plan', '--provider', 'stepplan',
      '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!`${r.stdout}${r.stderr}`.includes('not run: stored credentials'));
    assert.ok(routeIds(dir).includes('custom-new-plan'));
  }
});

test('a DIRECTLY invoked serve is refused before it listens, and writes nothing', async () => {
  // Not through setup: a parent-path test passes while the bypass stays open.
  // `serve <port> <nonce> <ids…>` is a command the dispatcher accepts, and its
  // POST materializes a built-in row, so it is a config writer like the rest.
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  const port = await freePort();
  const r = withLockedSecrets(dir, () => run(dir, ['serve', String(port), 'nonce-81', 'glm-coding-plan']));
  assert.notStrictEqual(r.status, null, 'serve started listening instead of refusing (timed out)');
  assertRefused(dir, ['serve'], r);
  assert.ok(r.stderr.includes(`${REFUSAL}\n`), `the refusal text changed shape: ${r.stderr}`);
  const probe = await request(port, 'GET');
  assert.strictEqual(probe.status, 0, 'something is listening on the refused form port');
  assert.strictEqual(probe.error, 'ECONNREFUSED');
  // Access returns: the migration was never disarmed.
  const later = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(later.status, 0, later.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
});

section('real CLI — a stored credential whose row failed to materialize is repaired by bare setup');

test('lock busy after the vault write, then a bare setup rerun, and the row exists', () => {
  const { dir, held } = rowlessKimi();
  // Still busy: bare setup must not claim everything is present.
  const busy = run(dir, ['setup']);
  assert.strictEqual(busy.status, 1, busy.stderr);
  assert.match(busy.stderr, /stored credentials still have no route: kimi-code-plan/);
  assert.doesNotMatch(busy.stderr, /all credentials present/, 'a false "all present" while a credential has no row');
  held.release();
  const r = run(dir, ['setup']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(routeIds(dir).includes('kimi-code-plan'), 'bare setup did not repair the row its own message promised');
  assert.match(r.stderr, /added the missing route for stored credentials: kimi-code-plan/);
  assert.match(r.stderr, /all credentials present\./);
  assert.deepStrictEqual(r.j.read(r.j.browser), [], 'nothing was missing, so no form should open');
});

// Issue #83: the other two repair failure modes. Each must reach the post-loop
// disk re-read and report its own reason; success is read from disk, never
// inferred from having attempted the repair. Real file vault, nothing stubbed.
// #83 mode 1 moved forward with CodeRabbit finding A: a config.json that is
// really broken is now refused at entry (exit 10), so the repair loop's
// unparseable branch is reached by breaking ONLY the repair's own read.
test('#83 (1a): bare setup on a really unparseable config.json refuses at entry — exit 10, nothing written, file byte-identical', () => {
  const dir = setUpOthers();
  inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
  const broken = '{ "routes": [ { "id": "mine", } ] }';
  fs.writeFileSync(path.join(dir, 'config.json'), broken);
  const r = run(dir, ['setup']);
  assert.strictEqual(r.status, 10, r.stderr);
  assert.match(r.stderr, /config\.json could not be read or parsed — fix it or move it aside, then rerun/);
  assert.doesNotMatch(r.stderr, /all credentials present|retry\./);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), broken, 'bare setup rewrote an unparseable config.json');
  assert.deepStrictEqual(r.j.read(r.j.browser), [], 'a refused setup opened a form');
});

test('#83 (1b): the repair\'s own read finds config.json unparseable — the row-less credential is reported, exit 1, file byte-identical', () => {
  // The other four configured and stored; only kimi is row-less. Only the
  // repair's strict base read (readUserConfigStrict, in materializeBuiltInRoute)
  // sees a broken document; setup's entry read and its post-state reread see
  // the real file.
  const prepare = () => {
    const dir = setUpOthers();
    inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
    return dir;
  };
  const at = readAt(prepare, ['setup'], 'readUserConfigStrict');
  const dir = prepare();
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const { r, steps, reads } = corruptRun(dir, ['setup'], at);
  assert.strictEqual(siteAt(reads, at), 'readUserConfigStrict', `premise: ${JSON.stringify(reads)}`);
  assert.deepStrictEqual(steps, [{ step: 'corrupt', attempt: at, name: 'config.json' }], 'premise: exactly the repair read was broken');
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /stored credentials still have no route: kimi-code-plan/);
  assert.match(r.stderr, /config\.json could not be read \(malformed\) — fix it and rerun to add the "kimi-code-plan" route\./);
  assert.doesNotMatch(r.stderr, /all credentials present/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before, 'config.json changed');
  assert.deepStrictEqual(r.j.read(r.j.browser), [], 'nothing was missing, so no form should open');
});

test('#83: bare setup whose config publish really fails reports the row-less credential, exit 1, config.json unchanged', () => {
  if (IS_ROOT) return; // root ignores the directory mode the fault relies on
  // The other four configured and stored; only kimi is row-less.
  const dir = setUpOthers();
  inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  // The fault: a read-only data dir, made so AFTER the lock directory exists.
  // A lock ticket is written inside that directory, so the lock can still be
  // taken; the atomic temp-file write of config.json beside it cannot.
  const once = lifecycle.acquireMutationLock(dir);
  assert.ok(once.ok, 'premise: the lock directory was created');
  once.release();
  fs.chmodSync(dir, 0o500);
  let r;
  try {
    r = run(dir, ['setup']);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /the "kimi-code-plan" route could not be added to config\.json/);
  assert.match(r.stderr, /stored credentials still have no route: kimi-code-plan/);
  assert.doesNotMatch(r.stderr, /all credentials present/);
  assert.doesNotMatch(r.stderr, /another provider mutation holds the lock/, 'premise: the lock was taken; the publish itself failed');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before, 'config.json changed');
  assert.deepStrictEqual(r.j.read(r.j.browser), [], 'nothing was missing, so no form should open');
});

test('update points a row-less stored credential at bare setup instead of "unknown route"', () => {
  const { dir, held } = rowlessKimi();
  held.release();
  const one = run(dir, ['update', 'kimi-code-plan']);
  assert.strictEqual(one.status, 1);
  assert.match(one.stderr, /"kimi-code-plan" has a stored credential but no route yet — run: vl\.js setup \(with no route id\) to add it\./);
  assert.doesNotMatch(one.stderr, /unknown route/);
  // Nothing else stored, so bare update has no form to open.
  const alone = scratch();
  fs.writeFileSync(path.join(alone, 'config.json'), JSON.stringify({ routes: [], vault: { backend: 'file' }, gate: { mode: 'off' } }));
  inDataDir(alone, () => vault.set('kimi-code-plan', KEY_A));
  const bare = run(alone, ['update']);
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.match(bare.stderr, /stored credentials with no route yet: kimi-code-plan — run: vl\.js setup \(with no route id\) to add them\./);
  assert.doesNotMatch(bare.stderr, /no credentials to update/, 'a false "no credentials" while one is stored');
  assert.ok(!routeIds(alone).includes('kimi-code-plan'), 'update must point at the repair, not perform it');
});

test('a credential removed between the repair scan and its lock gets no row, and no "added" report', () => {
  // Deterministic, not a sleep: the preload runs a REAL `provider remove` to
  // completion at setup's first lock acquire — after the repair loop decided
  // Kimi was owed a row, before materializeBuiltInRoute holds the lock.
  const dir = setUpOthers();
  inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
  assert.ok(!routeIds(dir).includes('kimi-code-plan'), 'premise: kimi is row-less');
  const hook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-hook-')), 'hook');
  const r = run(dir, ['setup', '--headless'], journals(), {
    VL_TEST_BEFORE_FIRST_LOCK: JSON.stringify(['provider', 'remove', 'kimi-code-plan', '--json']),
    VL_TEST_HOOK_JOURNAL: hook,
  });
  assert.notStrictEqual(r.status, null, `setup timed out: ${r.stderr}`);
  const fired = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.strictEqual(fired.length, 1, 'premise: the interleaved remove never ran');
  assert.strictEqual(fired[0].status, 0, `premise: the interleaved remove failed: ${fired[0].stdout}`);
  assert.strictEqual(inDataDir(dir, () => vault.probe('kimi-code-plan')), 'absent', 'premise: the remove cleared the credential');
  assert.ok(!routeIds(dir).includes('kimi-code-plan'), 'a row was published for a credential that is no longer stored');
  assert.match(r.stderr, /the "kimi-code-plan" credential is no longer stored, so its route was not added\./);
  assert.doesNotMatch(r.stderr, /added the missing route/, 'a false "added" report for a row that does not exist');
});

section('real CLI — lock order: migration, then the command, in one process');

// A nested acquire cannot hang (the lock never waits) but would surface as a
// spurious lock-busy, exit 6. Both orders below force migration first.
test('provider add on an upgrade succeeds: migration released before the add locked', () => {
  const dir = upgradeWith('kimi-code-plan');
  const r = run(dir, ['provider', 'add', '--label', 'solo', '--provider', 'stepplan',
    '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
  assert.notStrictEqual(r.status, 6, `nested lock acquisition: ${r.stderr}`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan', 'custom-solo']);
  assert.deepStrictEqual(r.j.read(r.j.net), [], 'an unmonitored add made a network call');
});

test('setup --key on an upgrade succeeds: migration released before the row was materialized', () => {
  const dir = upgradeWith('kimi-code-plan');
  const r = run(dir, ['setup', 'glm-coding-plan', '--key', KEY_B]);
  assert.notStrictEqual(r.status, 6, `nested lock acquisition: ${r.stderr}`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan', 'glm-coding-plan']);
});

section('real CLI — cache-only reads never migrate and write nothing');

test('gate on an upgrade fails open and leaves the data dir byte-identical', () => {
  const dir = upgradeWith('kimi-code-plan', 'openrouter-main');
  const before = tree(dir);
  const j = journals();
  const r = spawnSync(process.execPath, [cli, 'gate'], {
    env: envFor(dir, j), encoding: 'utf8', timeout: 20000,
    input: JSON.stringify({ tool_name: 'Task', tool_input: { model: 'kimi-k2' } }),
  });
  assert.strictEqual(r.status, 0, `the gate must fail open with no routes; stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '', 'no route resolved, so the gate must say nothing');
  assert.deepStrictEqual(tree(dir), before, 'gate created or modified a file under the data dir');
});

test('report, status, snapshot and recommend write nothing either', () => {
  for (const args of [['report'], ['status'], ['snapshot', '--json'], ['recommend', '--json']]) {
    const dir = upgradeWith('kimi-code-plan');
    const before = tree(dir);
    const r = run(dir, args);
    assert.notStrictEqual(r.status, null, `${args[0]} timed out`);
    assert.deepStrictEqual(tree(dir), before, `${args.join(' ')} wrote under the data dir`);
  }
});

section('real CLI — the setup form on a fresh install (the documented primary path)');

test('the form server accepts a catalog built-in with no config row, and the POST creates it', async () => {
  const dir = seeded([]);
  const j = journals();
  const port = await freePort();
  const child = spawn(process.execPath, [cli, 'serve', String(port), 'nonce-81', 'kimi-code-plan'], {
    env: envFor(dir, j), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((res) => child.once('exit', (code) => res(code)));
  try {
    assert.strictEqual(await waitListening(port, exited), true,
      `the form server never listened on an empty config: ${stderr.trim()}`);
    assert.deepStrictEqual(routeIds(dir), [], 'a row was published before any credential was stored');
    const post = await request(port, 'POST', { nonce: 'nonce-81', credentials: { 'kimi-code-plan': KEY_A } });
    assert.strictEqual(post.status, 200, post.body);
    assert.strictEqual(await exited, 0);
    assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'storing the credential did not assemble the row');
    assert.strictEqual(inDataDir(dir, () => vault.get('kimi-code-plan')), KEY_A);
  } finally {
    child.kill();
  }
});

test('the form server still refuses an id that is neither configured nor shipped', async () => {
  const dir = seeded([]);
  const r = run(dir, ['serve', String(await freePort()), 'nonce-81', 'not-a-route']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown route/);
});

test('setup without --key prints a URL only for a form server that is really listening', async () => {
  const dir = seeded([]);
  const r = run(dir, ['setup', 'kimi-code-plan']);
  assert.strictEqual(r.status, 0, r.stderr);
  const m = /credential form: http:\/\/127\.0\.0\.1:(\d+)/.exec(r.stderr);
  assert.ok(m, `no URL printed: ${r.stderr}`);
  const port = Number(m[1]);
  // The parent has already exited. The detached child must be up at that URL.
  const page = await request(port, 'GET');
  assert.strictEqual(page.status, 200, 'the printed URL is a dead page');
  const expected = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'cmd' : 'xdg-open');
  const launches = r.j.read(r.j.browser);
  assert.strictEqual(launches.length, 1, `browser launches: ${JSON.stringify(launches)}`);
  assert.ok(launches[0].startsWith(expected) && launches[0].includes(`http://127.0.0.1:${port}`),
    `the browser was not launched at the live URL: ${launches[0]}`);
  // Finish the form through the real POST, which also lets the child exit.
  const nonce = /nonce:"([a-f0-9]{48})"/.exec(page.body);
  assert.ok(nonce, 'premise: the form page carries its nonce');
  const post = await request(port, 'POST', { nonce: nonce[1], credentials: { 'kimi-code-plan': KEY_A } });
  assert.strictEqual(post.status, 200, post.body);
  await new Promise((res) => setTimeout(res, 400));
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
});

test("setup reports the form server's exit instead of printing a dead URL", () => {
  const dir = seeded([]);
  const r = run(dir, ['setup', 'kimi-code-plan'], journals(), { VL_TEST_SERVE_EXIT: '3' });
  assert.strictEqual(r.status, 1, `a dead form server must fail setup; stderr=${r.stderr}`);
  assert.match(r.stderr, /credential form server exited \(code 3\)/);
  assert.doesNotMatch(r.stderr, /credential form: http/, 'a URL was printed for a server that never listened');
  assert.deepStrictEqual(r.j.read(r.j.browser), [], 'a browser was opened at a dead page');
  assert.deepStrictEqual(routeIds(dir), []);
});

section('real CLI — offer versus create');

test('setup offers all five built-ins by name on an empty config', () => {
  const dir = seeded([]);
  const r = run(dir, ['setup', 'not-a-route', '--key', KEY_A]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown route "not-a-route"/);
  for (const x of BUILT_IN_ROUTES) assert.ok(r.stderr.includes(x.id), `${x.id} must be offered`);
});

test('setup --key assembles the row once, and a repeat does not duplicate it', () => {
  const dir = seeded([]);
  assert.strictEqual(run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]).status, 0);
  assert.strictEqual(run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]).status, 0);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
});

test('update rotates only what exists: an unconfigured built-in is unknown there', () => {
  const dir = seeded([]);
  const r = run(dir, ['update', 'kimi-code-plan']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown route "kimi-code-plan"/);
});

test('a custom route goes zero rows -> one -> zero', () => {
  const dir = seeded([]);
  const add = run(dir, ['provider', 'add', '--label', 'acme', '--provider', 'stepplan',
    '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
  assert.strictEqual(add.status, 0, add.stderr);
  assert.deepStrictEqual(routeIds(dir), ['custom-acme']);
  const rm = run(dir, ['provider', 'remove', 'custom-acme', '--json']);
  assert.strictEqual(rm.status, 0, rm.stderr);
  assert.deepStrictEqual(routeIds(dir), []);
});

test('a configured shipped built-in keeps its row on remove; its credential goes', () => {
  const dir = seeded([]);
  run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  const r = run(dir, ['remove', 'kimi-code-plan']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'a shipped id was deleted from config.json');
  assert.strictEqual(inDataDir(dir, () => vault.probe('kimi-code-plan')), 'absent');
});

test('provider remove on a never-added built-in: not-found when nothing exists', () => {
  const dir = seeded([]);
  const r = run(dir, ['provider', 'remove', 'kimi-code-plan', '--json']);
  assert.strictEqual(r.status, 7, r.stderr);
  assert.strictEqual(r.json.status, 'not-found');
  assert.deepStrictEqual(routeIds(dir), []);
});

test('provider remove on a never-added built-in still clears an orphaned credential', () => {
  const dir = seeded([]);
  inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
  const r = run(dir, ['provider', 'remove', 'kimi-code-plan', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.removed.credential, true);
  assert.strictEqual(inDataDir(dir, () => vault.probe('kimi-code-plan')), 'absent');
  assert.deepStrictEqual(routeIds(dir), [], 'removal created a row for a route nobody set up');
});


finish('empty-defaults cli');
