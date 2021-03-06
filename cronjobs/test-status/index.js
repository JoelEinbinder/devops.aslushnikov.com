const {DataStore} = require('../datastore.js');
const {Playwright} = require('../playwright.js');
const misc = require('../misc.js');
const path = require('path');
const fs = require('fs');

const REPORT_PATH = path.join(__dirname, 'workdir', 'report.json');

const MAX_ENTRIES = 1000;

(async () => {
  misc.setupProcessHooks();
  const datastore = await DataStore.cloneWithoutHistory(__dirname);
  const pw = await Playwright.cloneWithoutHistory(__dirname);
  await pw.installDependencies();
  await pw.build();
  /*
  // Uncomment for local testing:
  const datastore = await DataStore.pickup(__dirname);
  const pw = await Playwright.pickup(__dirname);
  */

  console.log(pw.checkoutPath());
  await misc.spawnWithLogOrDie('npm', 'run', 'test', '--', '--list', '--reporter=json', {
    cwd: pw.checkoutPath(),
    env: {
      ...process.env,
      FOLIO_JSON_OUTPUT_NAME: REPORT_PATH,
      PWTESTREPORT: 1,
    },
  });

  const report = JSON.parse(await fs.promises.readFile(REPORT_PATH, 'utf8'));
  const {tests, stats} = filterTests(pw, report);
  tests.sort((t1, t2) => {
    if (t1.filepath !== t2.filepath)
      return t1.filepath < t2.filepath ? -1 : 1;
    if (t1.title !== t2.title)
      return t1.title < t2.title ? -1 : 1;
    return 0;
  });
  // stabilize stats
  const newStats = Object.fromEntries([...Object.entries(stats)].sort((a, b) => a[0] < b[0]));

  const status = await datastore.readJSON('./status.json').catch(e => ([]));

  // Check if we actually update anything.
  const newEntry = {
    timestamp: Date.now(),
    commit: await pw.getCommit('HEAD'),
    tests,
    stats: newStats,
  };

  if (status.length) {
    const lastEntry = status[status.length - 1];
    if (JSON.stringify(lastEntry.tests) === JSON.stringify(newEntry.tests) &&
        JSON.stringify(lastEntry.stats) === JSON.stringify(newEntry.stats)) {
      console.log('FYI: nothing changed; fast-returning');
      return;
    }
  }

  status.push(newEntry);

  // Aggregate status entries so that there are no two entries for the same day.
  // Just to have some historic perspective :-)
  let newStatus = [];
  let lastEntryDate = null;
  for (const s of status) {
    const entryDate = new Date(s.timestamp).toLocaleDateString();
    if (entryDate === lastEntryDate)
      newStatus.pop();
    lastEntryDate = entryDate;
    newStatus.push(s);
  }

  if (newStatus.length > MAX_ENTRIES)
    newStatus = newStatus.slice(newStatus.length - MAX_ENTRIES);

  await datastore.writeJSON('./status.json', newStatus);
  await datastore.upload('update test status');
})();

function filterTests(pw, suite, result = {stats: {}, tests: []}) {
  if (suite.suites) {
    for (const child of suite.suites)
      filterTests(pw, child, result);
  }
  for (const spec of suite.specs || []) {
    const flakyBrowsers = new Set();
    const fixmeBrowsers = new Set();
    const failBrowsers = new Set();

    for (const test of spec.tests) {
      const browserName = test.parameters.browserName;
      if (!browserName) {
        // certain tests don't attribute to browsers!
        continue;
      }
      if (test.annotations.some(a => a.type === 'flaky'))
        flakyBrowsers.add(browserName);
      if (test.annotations.some(a => a.type === 'fixme'))
        fixmeBrowsers.add(browserName);
      if (test.annotations.some(a => a.type === 'fail'))
        failBrowsers.add(browserName);
    }
    const filepath = spec.file;
    if (spec.tests.length)
      result.stats[filepath] = (result.stats[filepath] || 0) + 1;
    if (!flakyBrowsers.size && !fixmeBrowsers.size && !failBrowsers.size)
      continue;
    result.tests.push({
      filepath,
      line: spec.line,
      column: spec.column,
      title: spec.title,
      flaky: [...flakyBrowsers].sort(),
      fixme: [...fixmeBrowsers].sort(),
      fail: [...failBrowsers].sort(),
    });
  }
  return result;
}
