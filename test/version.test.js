'use strict';
// Version source-of-truth guard. `.claude-plugin/plugin.json` is the only
// version of record: .github/workflows/tag-on-bump.yml tags `v<version>` from
// it, and the marketplace catalog pins to that tag. A second, drifting version
// elsewhere would silently disagree with the release.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
assert.match(plugin.version, /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/,
  'plugin.json version must be semver (the tag workflow refuses anything else)');

const pkg = JSON.parse(read('package.json'));
assert.strictEqual(pkg.version, undefined,
  'package.json must not carry a version; plugin.json is the single source of truth');
assert.strictEqual(pkg.private, true, 'package.json must stay private (never published to npm)');

assert.doesNotMatch(read('README.md'), /^v\d+\.\d+\.\d+\s*$/m,
  'README.md must not hardcode a version; point at the release tags instead');

console.log('version source-of-truth: ok');
