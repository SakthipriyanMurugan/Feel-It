// FEEL IT - Sync Root Assets to www directory for Android build
const fs = require('fs');
const path = require('path');

const srcDir = path.resolve(__dirname);
const destDir = path.resolve(__dirname, 'www');

const filesToSync = [
  'index.html',
  'style.css',
  'script.js',
  'manifest.json',
  'sw.js',
  'icon.svg'
];

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

filesToSync.forEach(file => {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Synced: ${file} -> www/${file}`);
  }
});
console.log('All frontend files successfully synced to www/');
