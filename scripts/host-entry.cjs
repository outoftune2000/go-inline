const fs = require('node:fs');
const path = require('node:path');
const log = path.join(__dirname, '..', '.test-host', 'result.log');
fs.writeFileSync(log, 'Test module loaded\n');
exports.run = async function () {
  try {
    fs.appendFileSync(log, 'Tests starting\n');
    await require('../.test-host/test/host/index.js').run();
    fs.appendFileSync(log, 'PASS\n');
  } catch (error) {
    fs.appendFileSync(log, String(error.stack || error) + '\n');
    throw error;
  }
};
