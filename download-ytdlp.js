const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const platform = os.platform();
let binaryName = 'yt-dlp';
if (platform === 'win32') {
  binaryName = 'yt-dlp.exe';
} else if (platform === 'darwin') {
  binaryName = 'yt-dlp_macos';
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName}`;
const dest = path.join(__dirname, platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

console.log(`Downloading yt-dlp for ${platform} from ${url}...`);

function download(downloadUrl) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(downloadUrl, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return resolve(download(response.headers.location));
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close(() => {
          console.log('Download complete!');
          if (platform !== 'win32') {
            fs.chmodSync(dest, 0o755);
            console.log('Granted execute permissions.');
          }
          resolve();
        });
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      console.error('Error downloading yt-dlp:', err.message);
      reject(err);
    });
  });
}

download(url)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Download failed:', err);
    process.exit(1);
  });
