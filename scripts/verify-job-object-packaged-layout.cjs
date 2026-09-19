const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256File = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

module.exports = async context => {
  if (context?.electronPlatformName !== 'win32') return;
  const identityPath = path.join(__dirname, '..', 'electron', 'generated', 'job-object-launcher-identity.json');
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  const helperPath = path.join(context.appOutDir, 'resources', identity.packagedFile);
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath) || !fs.statSync(asarPath).isFile()) throw new Error('Packaged Windows Job launcher identity requires the final app.asar');
  const packagedIdentity = JSON.parse(require('@electron/asar').extractFile(asarPath, path.join('electron', 'generated', 'job-object-launcher-identity.json')).toString('utf8'));
  if (identity.schemaVersion !== 2 || JSON.stringify(packagedIdentity) !== JSON.stringify(identity) || !fs.statSync(helperPath).isFile() || sha256File(helperPath) !== identity.sha256) {
    throw new Error('Packaged Windows Job launcher does not match its integrity-validated ASAR build identity');
  }
};
