'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../public/i18n.js');

test('every language has the same message keys', () => {
  const [first, ...others] = i18n.LANGUAGES;
  const keys = Object.keys(i18n.MESSAGES[first]).sort();
  for (const lang of others) assert.deepEqual(Object.keys(i18n.MESSAGES[lang]).sort(), keys, lang);
});

test('picks the first supported language', () => {
  assert.equal(i18n.pick('de-CH,de;q=0.9,en;q=0.8'), 'de');
  assert.equal(i18n.pick(['fr-FR', 'en-GB']), 'en');
  assert.equal(i18n.pick('fr'), 'en');
  assert.equal(i18n.pick(undefined), 'en');
});

test('fills in values and plurals', () => {
  const t = i18n.translator('de');
  assert.equal(t('ago.min', { n: 5 }), 'vor 5 min');
  assert.equal(t.n('sources.newVideos', 1), '1 neues Video');
  assert.equal(t.n('sources.newVideos', 3), '3 neue Videos');
  assert.equal(i18n.translator('xx')('tab.stack'), 'Stack');
});
